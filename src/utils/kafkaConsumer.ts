/**
 * kafkaConsumer — inbound events from the Python ML service.
 * All handlers are idempotent. A malformed message logs + commits the offset
 * so one bad message never blocks the entire consumer group.
 */

import { EachMessagePayload, Kafka, Consumer } from 'kafkajs';

import { config } from '../config';
import { Alert } from '../models/Alert';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { ModelMetrics } from '../models/ModelMetrics';
import { RetrainingHistory } from '../models/RetrainingHistory';
import {
  AlertSeverity,
  AlertTriggerType,
  ClassificationLabel,
  HITLPriority,
  HITLStatus,
  RetrainingStatus,
  RetrainingType,
  WsEvent,
  UserRole,
} from '../types';
import { MLClassifyResponse, MLLabel, MLLanguage } from '../types/ml.types';
import { logger } from './logger';

// ── Topic registry (mirrors producer) ────────────────────────────────────────

const TOPICS = {
  CLASSIFIED_POSTS:   'iw.classified-posts',
  RETRAIN_COMPLETE:   'iw.retrain-complete',
  EMBEDDING_RESULT:   'iw.embedding-result',
  MODEL_DRIFT_ALERT:  'iw.model-drift-alert',
} as const;

// ── Consumer singleton ────────────────────────────────────────────────────────

let consumer: Consumer | null = null;

export async function startKafkaConsumer(): Promise<void> {
  if (!config.kafka.enabled) {
    logger.debug('Kafka disabled — consumer is a no-op');
    return;
  }

  const kafka = new Kafka({
    clientId: `${config.kafka.clientId}-consumer`,
    brokers:  config.kafka.brokers,
    logCreator: () => (entry) => {
      const { message, ...extra } = entry.log;
      logger.debug(`[kafka-consumer] ${message}`, extra);
    },
  });

  consumer = kafka.consumer({ groupId: config.kafka.groupId });
  await consumer.connect();

  await consumer.subscribe({
    topics: Object.values(TOPICS),
    fromBeginning: false,
  });

  await consumer.run({
    autoCommit:           true,
    autoCommitInterval:   5000,
    autoCommitThreshold:  100,
    eachMessage: async (payload) => {
      try {
        await dispatch(payload);
      } catch (err) {
        // Log and swallow — offset is committed so the consumer keeps moving
        logger.error(`[kafka-consumer] unhandled error in topic=${payload.topic}: ${(err as Error).message}`, {
          offset: payload.message.offset,
          key:    payload.message.key?.toString(),
        });
      }
    },
  });

  logger.info('Kafka consumer running');
}

export async function stopKafkaConsumer(): Promise<void> {
  if (!consumer) return;
  await consumer.disconnect();
  consumer = null;
  logger.info('Kafka consumer disconnected');
}

// ── Message dispatcher ─────────────────────────────────────────────────────────

async function dispatch({ topic, message }: EachMessagePayload): Promise<void> {
  const raw = message.value?.toString();
  if (!raw) return;

  const { payload } = JSON.parse(raw) as { schema_version: string; payload: unknown };

  switch (topic) {
    case TOPICS.CLASSIFIED_POSTS:
      return handleClassifiedPost(payload as MLClassifyResponse);
    case TOPICS.RETRAIN_COMPLETE:
      return handleRetrainComplete(payload as RetrainCompletePayload);
    case TOPICS.EMBEDDING_RESULT:
      return handleEmbeddingResult(payload as EmbeddingResultPayload);
    case TOPICS.MODEL_DRIFT_ALERT:
      return handleModelDriftAlert(payload as ModelDriftAlertPayload);
    default:
      logger.warn(`[kafka-consumer] unknown topic: ${topic}`);
  }
}

// ── Handler: iw.classified-posts ─────────────────────────────────────────────

async function handleClassifiedPost(result: MLClassifyResponse): Promise<void> {
  const { Classification } = await import('../models/Classification');
  const { HITLReview }      = await import('../models/HITLReview');

  const exists = await Classification.findOne({ postId: result.post_id }).lean();
  if (exists) {
    logger.debug(`[kafka-consumer] duplicate classified-post — post=${result.post_id}`);
    return;
  }

  const labelMap: Record<MLLabel, ClassificationLabel> = {
    [MLLabel.MISINFORMATION]:  ClassificationLabel.MISINFORMATION,
    [MLLabel.DISINFORMATION]:  ClassificationLabel.DISINFORMATION,
    [MLLabel.FACTUAL]:         ClassificationLabel.FACTUAL,
    [MLLabel.IRRELEVANT]:      ClassificationLabel.IRRELEVANT,
  };
  const label = labelMap[result.label] ?? ClassificationLabel.PENDING;

  const cls = await Classification.create({
    postId:       result.post_id,
    label,
    confidence:   result.confidence,
    entropy:      result.entropy,
    modelVersion: result.model_version,
    alternatives: result.alternatives,
    kbEvidence:   result.kb_evidence,
    processingMs: result.processing_ms,
    fallback:     result.fallback ?? false,
  });

  const { config: cfg } = await import('../config');
  if (
    (label === ClassificationLabel.MISINFORMATION || label === ClassificationLabel.DISINFORMATION) &&
    result.confidence >= cfg.classification.hitlThreshold
  ) {
    const alreadyQueued = await HITLReview.findOne({ postId: result.post_id });
    if (!alreadyQueued) {
      await HITLReview.create({
        postId:           result.post_id,
        classificationId: cls._id,
        priority:
          result.confidence >= cfg.classification.highPriorityThreshold
            ? HITLPriority.HIGH
            : HITLPriority.STANDARD,
        status: HITLStatus.PENDING,
        notes:  'Created from Kafka classified-posts event',
      });
    }
  }
}

// ── Handler: iw.retrain-complete ──────────────────────────────────────────────

interface RetrainCompletePayload {
  model_version:      string;
  macro_f1_by_lang:   Record<string, number>;
  promoted:           boolean;
  timestamp:          string;
  overall_macro_f1:   number;
  previous_macro_f1?: number;
}

async function handleRetrainComplete(payload: RetrainCompletePayload): Promise<void> {
  // Transform flat f1 map (lang → number) into ILanguageMetrics shape
  const perLanguage = Object.fromEntries(
    Object.entries(payload.macro_f1_by_lang).map(([lang, f1]) => [
      lang,
      typeof f1 === 'number' ? { macroF1: f1, psi: 0, sampleCount: 0 } : f1,
    ]),
  );

  await ModelMetrics.findOneAndUpdate(
    { modelVersion: payload.model_version },
    {
      $set: {
        modelVersion: payload.model_version,
        macroF1:      payload.overall_macro_f1,
        perLanguage,
        promoted:     payload.promoted,
      },
      $setOnInsert: {
        recall:         0,
        precision:      0,
        inferenceP95ms: 0,
        lastRetrain:    new Date(payload.timestamp),
      },
    },
    { upsert: true, new: true },
  );

  await RetrainingHistory.create({
    runId:              `retrain-${payload.model_version}-${Date.now()}`,
    modelVersionBefore: 'unknown',
    modelVersionAfter:  payload.model_version,
    type:               RetrainingType.ON_DEMAND,
    f1Before:           payload.previous_macro_f1 ?? 0,
    f1After:            payload.overall_macro_f1,
    status:             payload.promoted ? RetrainingStatus.PROMOTED : RetrainingStatus.REJECTED,
    triggeredBy:        'ml-service',
    startedAt:          new Date(payload.timestamp),
    completedAt:        new Date(payload.timestamp),
  });

  // Broadcast to SuperAdmin + Supervisor via WebSocket
  broadcastWs(WsEvent.MODEL_UPDATE, payload, [UserRole.SUPER_ADMIN, UserRole.SUPERVISOR]);

  logger.info(`[retrain-complete] model=${payload.model_version} f1=${payload.overall_macro_f1} promoted=${payload.promoted}`);
}

// ── Handler: iw.embedding-result ─────────────────────────────────────────────

interface EmbeddingResultPayload {
  doc_id:    string;
  embedding: number[];
}

async function handleEmbeddingResult(payload: EmbeddingResultPayload): Promise<void> {
  const updated = await KnowledgeBase.findByIdAndUpdate(
    payload.doc_id,
    { embeddingVector: payload.embedding, embedded: true },
    { new: true },
  );
  if (!updated) {
    logger.warn(`[embedding-result] KnowledgeBase doc not found — doc=${payload.doc_id}`);
  }
}

// ── Handler: iw.model-drift-alert ────────────────────────────────────────────

interface ModelDriftAlertPayload {
  language:   MLLanguage;
  psi:        number;
  threshold:  number;
  timestamp:  string;
}

async function handleModelDriftAlert(payload: ModelDriftAlertPayload): Promise<void> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  // Idempotency: don't spam alerts for the same language within an hour
  const existing = await Alert.findOne({
    triggerType:      AlertTriggerType.PSI_DRIFT,
    affectedLanguage: payload.language,
    isResolved:       false,
    createdAt:        { $gte: oneHourAgo },
  }).lean();

  if (existing) return;

  const alert = await Alert.create({
    severity:         AlertSeverity.HIGH,
    triggerType:      AlertTriggerType.PSI_DRIFT,
    affectedLanguage: payload.language,
    title:            `Model Drift — ${payload.language.toUpperCase()}`,
    description:      `Model drift: ${payload.language.toUpperCase()} PSI=${payload.psi.toFixed(3)} exceeds threshold ${payload.threshold}`,
    isResolved:       false,
  });

  broadcastWs(WsEvent.MODEL_DRIFT_ALERT, { alert, ...payload });

  logger.warn(`[drift-alert] language=${payload.language} psi=${payload.psi}`);
}

// ── Test-only exports (tree-shaken in production builds) ─────────────────────

export const handleRetrainCompleteForTest  = handleRetrainComplete;
export const handleModelDriftAlertForTest  = handleModelDriftAlert;

// ── WebSocket broadcast helper ────────────────────────────────────────────────

function broadcastWs(
  event: WsEvent,
  data: unknown,
  roles?: UserRole[],
): void {
  // io is attached to global by src/index.ts at startup
  const io = (global as Record<string, unknown>).io as import('socket.io').Server | undefined;
  if (!io) return;

  if (roles?.length) {
    // Targeted broadcast — only emit to sockets with matching role
    io.fetchSockets().then((sockets) => {
      sockets
        .filter((s) => roles.includes((s.data as { role?: UserRole }).role as UserRole))
        .forEach((s) => s.emit(event, data));
    }).catch(() => { /* non-critical */ });
  } else {
    io.emit(event, data);
  }
}
