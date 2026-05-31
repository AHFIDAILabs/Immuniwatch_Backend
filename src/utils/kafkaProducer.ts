/**
 * kafkaProducer — outbound events from Node.js to the Python ML service.
 * When KAFKA_ENABLED=false all functions are async no-ops (local dev / testing).
 * On publish failure the error is logged and a direct HTTP fallback is attempted
 * so a Kafka outage never halts post ingestion.
 */

import { Kafka, Producer, RecordMetadata, logLevel as KafkaLogLevel } from 'kafkajs';

import { config } from '../config';
import {
  MLClassifyResponse,
  MLFeedbackPayload,
  MLLanguage,
} from '../types/ml.types';
import { IPost } from '../models/Post';
import { logger } from './logger';

// ── Topic registry ─────────────────────────────────────────────────────────────

export const TOPICS = {
  RAW_POSTS:         'iw.raw-posts',
  CLASSIFIED_POSTS:  'iw.classified-posts',
  FEEDBACK:          'iw.feedback',
  RETRAIN_TRIGGER:   'iw.retrain-trigger',
  EMBEDDING_REQUEST: 'iw.embedding-request',
} as const;

// ── Envelope ───────────────────────────────────────────────────────────────────

function envelope<T>(payload: T): string {
  return JSON.stringify({ schema_version: '1.0', timestamp: new Date().toISOString(), payload });
}

// ── Producer singleton ─────────────────────────────────────────────────────────

let producer: Producer | null = null;

export async function startKafkaProducer(): Promise<void> {
  if (!config.kafka.enabled) {
    logger.debug('Kafka disabled — producer is a no-op');
    return;
  }

  const kafka = new Kafka({
    clientId: config.kafka.clientId,
    brokers:  config.kafka.brokers,
    // Only forward ERROR-level messages — KafkaJS retries produce hundreds of
    // DEBUG lines that flood the console when no broker is reachable.
    logLevel:   KafkaLogLevel.ERROR,
    logCreator: () => (entry) => {
      if (entry.level > KafkaLogLevel.ERROR) return;
      const { message, ...extra } = entry.log;
      logger.error(`[kafka] ${message}`, extra);
    },
  });

  producer = kafka.producer({
    idempotent:          true,
    maxInFlightRequests: 1,
  });

  try {
    await producer.connect();
    logger.info('Kafka producer connected');
  } catch (err) {
    logger.warn(`Kafka producer could not connect — running without Kafka: ${(err as Error).message}`);
    producer = null;
  }
}

export async function stopKafkaProducer(): Promise<void> {
  if (!producer) return;
  await producer.disconnect();
  producer = null;
  logger.info('Kafka producer disconnected');
}

// ── Core send helper ───────────────────────────────────────────────────────────

async function send(
  topic: string,
  key: string,
  value: string,
): Promise<RecordMetadata[] | null> {
  if (!config.kafka.enabled || !producer) {
    logger.debug(`[kafka:no-op] ${topic} key=${key}`);
    return null;
  }
  return producer.send({ topic, messages: [{ key, value }] });
}

// ── Publishers ─────────────────────────────────────────────────────────────────

export async function publishRawPost(post: IPost): Promise<void> {
  const id = (post._id as object).toString();
  try {
    await send(TOPICS.RAW_POSTS, id, envelope(post));
  } catch (err) {
    logger.error(`[kafka] publishRawPost failed — post=${id}: ${(err as Error).message}`);
    // Raw post ingestion has no HTTP fallback (source-of-truth is already in MongoDB)
  }
}

export async function publishClassified(
  result: MLClassifyResponse,
  postId: string,
): Promise<void> {
  try {
    await send(TOPICS.CLASSIFIED_POSTS, postId, envelope(result));
  } catch (err) {
    logger.error(`[kafka] publishClassified failed — post=${postId}: ${(err as Error).message}`);
    // Classification already persisted in MongoDB; Kafka is supplemental here
  }
}

export async function publishFeedback(payload: MLFeedbackPayload): Promise<void> {
  try {
    await send(TOPICS.FEEDBACK, payload.post_id, envelope(payload));
  } catch (err) {
    logger.error(`[kafka] publishFeedback failed — post=${payload.post_id}: ${(err as Error).message}`);
    // Fallback: direct HTTP call so the training signal is not lost
    try {
      const { submitFeedback } = await import('../services/mlClient');
      await submitFeedback(payload);
    } catch (fbErr) {
      logger.error(`[kafka] publishFeedback HTTP fallback also failed: ${(fbErr as Error).message}`);
    }
  }
}

export async function publishRetrainTrigger(
  triggeredBy: string,
  reason: string,
): Promise<void> {
  try {
    await send(TOPICS.RETRAIN_TRIGGER, triggeredBy, envelope({ triggered_by: triggeredBy, reason }));
  } catch (err) {
    logger.error(`[kafka] publishRetrainTrigger failed: ${(err as Error).message}`);
  }
}

export async function publishEmbeddingRequest(
  docId: string,
  text: string,
  language: MLLanguage,
): Promise<void> {
  try {
    await send(TOPICS.EMBEDDING_REQUEST, docId, envelope({ doc_id: docId, text, language }));
  } catch (err) {
    logger.error(`[kafka] publishEmbeddingRequest failed — doc=${docId}: ${(err as Error).message}`);
    // Fallback: call ML service directly so the KB doc gets embedded immediately
    try {
      const { getEmbedding } = await import('../services/mlClient');
      const vector = await getEmbedding(text, language);
      if (vector.some((v) => v !== 0)) {
        const { KnowledgeBase } = await import('../models/KnowledgeBase');
        await KnowledgeBase.findByIdAndUpdate(docId, {
          embeddingVector: vector,
          embedded: true,
        });
      }
    } catch (fbErr) {
      logger.error(`[kafka] publishEmbeddingRequest HTTP fallback failed: ${(fbErr as Error).message}`);
    }
  }
}
