/**
 * kafkaConsumer — inbound events from internal backend producers only.
 * All handlers are idempotent. A malformed message logs + commits the offset
 * so one bad message never blocks the entire consumer group.
 *
 * Phase 1 note: ML service does NOT publish to Kafka. Metrics and drift
 * monitoring are polled via HTTP (modelHealthService.checkPsiDrift).
 */

import { EachMessagePayload, Kafka, Consumer, logLevel as KafkaLogLevel } from 'kafkajs';

import { config } from '../config';
import {
  ClassificationLabel,
  HITLPriority,
  HITLStatus,
} from '../types';
import { logger } from './logger';

// ── Topic registry ────────────────────────────────────────────────────────────

const TOPICS = {
  CLASSIFIED_POSTS:  'iw.classified-posts',
  EMBEDDING_RESULT:  'iw.embedding-result',
} as const;

// ── Consumer singleton ────────────────────────────────────────────────────────

let consumer: Consumer | null = null;

export async function startKafkaConsumer(): Promise<void> {
  if (!config.kafka.enabled) {
    logger.debug('Kafka disabled — consumer is a no-op');
    return;
  }

  const kafka = new Kafka({
    clientId:   `${config.kafka.clientId}-consumer`,
    brokers:    config.kafka.brokers,
    logLevel:   KafkaLogLevel.ERROR,
    logCreator: () => (entry) => {
      if (entry.level > KafkaLogLevel.ERROR) return;
      const { message, ...extra } = entry.log;
      logger.error(`[kafka-consumer] ${message}`, extra);
    },
  });

  consumer = kafka.consumer({ groupId: config.kafka.groupId });

  try {
    await consumer.connect();
  } catch (err) {
    logger.warn(`Kafka consumer could not connect — running without Kafka: ${(err as Error).message}`);
    consumer = null;
    return;
  }

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

// ── Message dispatcher ────────────────────────────────────────────────────────

async function dispatch({ topic, message }: EachMessagePayload): Promise<void> {
  const raw = message.value?.toString();
  if (!raw) return;

  const { payload } = JSON.parse(raw) as { schema_version: string; payload: unknown };

  switch (topic) {
    case TOPICS.CLASSIFIED_POSTS:
      return handleClassifiedPost(payload as ClassifiedPostPayload);
    case TOPICS.EMBEDDING_RESULT:
      return handleEmbeddingResult(payload as EmbeddingResultPayload);
    default:
      logger.warn(`[kafka-consumer] unknown topic: ${topic}`);
  }
}

// ── Handler: iw.classified-posts ─────────────────────────────────────────────

interface ClassifiedPostPayload {
  post_id:       string;
  label:         string;
  confidence:    number;
  entropy:       number;
  model_version: string;
  alternatives:  Array<{ label: string; confidence: number }>;
  kb_evidence:   Array<{ doc_id: string; title: string; snippet: string; score: number }>;
  processing_ms: number;
  fallback?:     boolean;
}

async function handleClassifiedPost(result: ClassifiedPostPayload): Promise<void> {
  const { Classification } = await import('../models/Classification');
  const { HITLReview }     = await import('../models/HITLReview');
  const { config: cfg }    = await import('../config');

  const exists = await Classification.findOne({ postId: result.post_id }).lean();
  if (exists) {
    logger.debug(`[kafka-consumer] duplicate classified-post — post=${result.post_id}`);
    return;
  }

  const labelMap: Record<string, ClassificationLabel> = {
    misinformation: ClassificationLabel.MISINFORMATION,
    factual:        ClassificationLabel.FACTUAL,
    irrelevant:     ClassificationLabel.IRRELEVANT,
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

  // Auto-approve high-confidence factual predictions
  const isAutoApproved = label === ClassificationLabel.FACTUAL && result.confidence >= 0.92;

  if (
    !isAutoApproved &&
    label === ClassificationLabel.MISINFORMATION &&
    result.confidence >= cfg.classification.hitlThreshold
  ) {
    const alreadyQueued = await HITLReview.findOne({ postId: result.post_id });
    if (!alreadyQueued) {
      const priority =
        result.confidence >= cfg.classification.highPriorityThreshold || result.entropy > 0.45
          ? HITLPriority.HIGH
          : HITLPriority.STANDARD;

      await HITLReview.create({
        postId:           result.post_id,
        classificationId: cls._id,
        priority,
        status: HITLStatus.PENDING,
        notes:  'Created from Kafka classified-posts event',
      });
    }
  }
}

// ── Handler: iw.embedding-result ─────────────────────────────────────────────

interface EmbeddingResultPayload {
  doc_id:    string;
  embedding: number[];
}

async function handleEmbeddingResult(payload: EmbeddingResultPayload): Promise<void> {
  const { KnowledgeBase } = await import('../models/KnowledgeBase');

  const updated = await KnowledgeBase.findByIdAndUpdate(
    payload.doc_id,
    { embeddingVector: payload.embedding, embedded: true },
    { new: true },
  );
  if (!updated) {
    logger.warn(`[embedding-result] KnowledgeBase doc not found — doc=${payload.doc_id}`);
  }
}

// ── WebSocket broadcast helper ────────────────────────────────────────────────

function broadcastWs(
  event: string,
  data: unknown,
): void {
  const io = (global as Record<string, unknown>).io as import('socket.io').Server | undefined;
  if (!io) return;
  io.emit(event, data);
}

// Suppress unused-variable warning — broadcastWs is available for future handlers
void broadcastWs;
