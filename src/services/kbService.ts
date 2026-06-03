/**
 * kbService — Knowledge Base document management & semantic search.
 *
 * Embedding strategy:
 *   • Async (default): call mlClient.embedBatch() via setImmediate; document is
 *     returned immediately with embedded=false and updated in the background.
 *   • Immediate (uploadDocument({ immediate: true })): call mlClient.getEmbedding()
 *     synchronously and store the vector before returning.
 *
 * Search:
 *   • Cosine similarity in JS — acceptable up to ~3,000 docs.
 *   TODO: migrate to pgvector IVFFlat index when KB exceeds 3,000 documents.
 *   • Similarity threshold: 0.72 — results below this score are discarded.
 *   • Falls back to MongoDB $text search when mlClient returns a zero-vector.
 */

import { v2 as cloudinary } from 'cloudinary';

import { config } from '../config';
import { AuditLog } from '../models/AuditLog';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { AuditAction, PostLanguage } from '../types';
import { MLLanguage } from '../types/ml.types';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import * as mlClient from './mlClient';
import { mapLanguage } from './classificationService';

// ── Cloudinary init ───────────────────────────────────────────────────────────

cloudinary.config({
  cloud_name: config.cloudinary.cloudName,
  api_key:    config.cloudinary.apiKey,
  api_secret: config.cloudinary.apiSecret,
  secure:     true,
});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface KBUploadOptions {
  title:       string;
  source:      string;
  language:    PostLanguage;
  uploadedBy:  string;
  immediate?:  boolean;   // get embedding synchronously before returning
}

export interface KBSearchResult {
  docId:   string;
  title:   string;
  source:  string;
  snippet: string;
  score:   number;
}

// ── Cosine similarity ─────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function isZeroVector(v: number[]): boolean {
  return v.every((x) => x === 0);
}

// ── uploadDocument ────────────────────────────────────────────────────────────

export async function uploadDocument(
  fileBuffer: Buffer,
  mimeType: string,
  opts: KBUploadOptions,
): Promise<InstanceType<typeof KnowledgeBase>> {
  // Upload binary to Cloudinary
  const uploadResult = await new Promise<{ secure_url: string; public_id: string }>(
    (resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder:        'immuniwatch/kb',
          resource_type: 'auto',
          use_filename:  true,
        },
        (err, result) => {
          if (err || !result) return reject(err ?? new Error('Cloudinary upload failed'));
          resolve({ secure_url: result.secure_url, public_id: result.public_id });
        },
      );
      stream.end(fileBuffer);
    },
  );

  // For demo: treat the buffer as plain text. In production, pass through a PDF/DOCX parser.
  const extractedText = fileBuffer.toString('utf-8').slice(0, 10_000);

  const doc = await KnowledgeBase.create({
    title:              opts.title,
    source:             opts.source,
    language:           opts.language,
    cloudinaryUrl:      uploadResult.secure_url,
    cloudinaryPublicId: uploadResult.public_id,
    content:            extractedText,
    embedded:           false,
    createdBy:          opts.uploadedBy,
  });

  await AuditLog.create({
    actor:        opts.uploadedBy,
    action:       AuditAction.KB_UPLOAD,
    resourceType: 'KnowledgeBase',
    resourceId:   doc._id.toString(),
    newValue:     { title: opts.title, source: opts.source },
  });

  // Sync to ML service ChromaDB (non-blocking — don't fail the upload if ML is down)
  setImmediate(async () => {
    try {
      const mlResult = await mlClient.uploadToKbService({
        title:    opts.title,
        content:  extractedText,
        source:   opts.source,
        language: opts.language,
      });
      if (mlResult) {
        await KnowledgeBase.findByIdAndUpdate(doc._id, {
          mlDocId:   mlResult.doc_id,
          mlIndexed: true,
        });
      }
    } catch (err) {
      logger.warn(`kbService: ML KB sync failed for doc=${doc._id.toString()}: ${(err as Error).message}`);
    }
  });

  if (opts.immediate) {
    // Synchronous embedding — used for real-time KB search during classification
    const mlLang = mapLanguage(opts.language);
    const vector = await mlClient.getEmbedding(extractedText, mlLang);
    if (!isZeroVector(vector)) {
      await KnowledgeBase.findByIdAndUpdate(doc._id, {
        embeddingVector: vector,
        embedded:        true,
      });
      doc.set({ embeddingVector: vector, embedded: true });
    }
  } else {
    // Async embedding via HTTP batch endpoint (Phase 1 — Kafka not used for ML comms)
    const docId   = doc._id.toString();
    const mlLang  = mapLanguage(opts.language);
    setImmediate(async () => {
      try {
        const results = await mlClient.embedBatch([{ doc_id: docId, text: extractedText, language: mlLang }]);
        const item = results[0];
        if (item && !isZeroVector(item.embedding)) {
          await KnowledgeBase.findByIdAndUpdate(docId, {
            embeddingVector: item.embedding,
            embedded:        true,
          });
        }
      } catch (err) {
        logger.warn(`kbService: async embed failed for doc=${docId}: ${(err as Error).message}`);
      }
    });
  }

  return doc;
}

// ── searchSimilar ─────────────────────────────────────────────────────────────

export async function searchSimilar(
  query: string,
  topK: number,
  language?: PostLanguage,
): Promise<KBSearchResult[]> {
  const mlLang: MLLanguage = language ? mapLanguage(language) : MLLanguage.EN;
  const queryVec = await mlClient.getEmbedding(query, mlLang);

  if (isZeroVector(queryVec)) {
    // ML service returned fallback vector — use MongoDB text search
    logger.warn('searchSimilar: zero-vector from mlClient, falling back to $text search');
    return textFallbackSearch(query, topK);
  }

  // Load all embedded documents (only fields needed for search)
  const docs = await KnowledgeBase.find({ embedded: true })
    .select('_id title source content embeddingVector')
    .lean();

  const COSINE_THRESHOLD = 0.72;

  const scored = docs
    .map((d) => ({
      docId:   d._id.toString(),
      title:   d.title as string,
      source:  d.source as string,
      snippet: ((d.content as string) ?? '').slice(0, 300),
      score:   cosineSimilarity(queryVec, (d.embeddingVector as number[]) ?? []),
    }))
    .filter((r) => r.score >= COSINE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  return scored;
}

async function textFallbackSearch(query: string, topK: number): Promise<KBSearchResult[]> {
  const docs = await KnowledgeBase.find(
    { $text: { $search: query } },
    { score: { $meta: 'textScore' } },
  )
    .sort({ score: { $meta: 'textScore' } })
    .limit(topK)
    .lean();

  return docs.map((d) => ({
    docId:   d._id.toString(),
    title:   d.title as string,
    source:  d.source as string,
    snippet: ((d.content as string) ?? '').slice(0, 300),
    score:   0,
  }));
}

// ── reindexAll ────────────────────────────────────────────────────────────────

export async function reindexAll(): Promise<{ processed: number; failed: number; total: number; mlSynced: number }> {
  const docs = await KnowledgeBase.find({})
    .select('_id title source content language mlDocId mlIndexed')
    .lean();

  let processed = 0;
  let failed    = 0;
  let mlSynced  = 0;
  const BATCH   = 5;
  const DELAY   = 300;

  for (let i = 0; i < docs.length; i += BATCH) {
    const batch = docs.slice(i, i + BATCH);

    await Promise.allSettled(
      batch.map(async (doc) => {
        try {
          const content = (doc.content as string) ?? '';
          const mlLang  = mapLanguage((doc.language as PostLanguage) ?? PostLanguage.ENGLISH);

          // 1. Cosine embedding (local vector search)
          const vector = await mlClient.getEmbedding(content, mlLang);
          if (!isZeroVector(vector)) {
            await KnowledgeBase.findByIdAndUpdate(doc._id, { embeddingVector: vector, embedded: true });
            processed++;
          } else { failed++; }

          // 2. Sync to ML ChromaDB (only if not already indexed or no doc_id stored)
          if (!doc.mlIndexed || !doc.mlDocId) {
            const mlResult = await mlClient.uploadToKbService({
              title:    doc.title as string,
              content,
              source:   doc.source as string,
              language: doc.language as string,
            });
            if (mlResult) {
              await KnowledgeBase.findByIdAndUpdate(doc._id, { mlDocId: mlResult.doc_id, mlIndexed: true });
              mlSynced++;
            }
          }
        } catch {
          failed++;
        }
      }),
    );

    if (i + BATCH < docs.length) {
      await new Promise((r) => setTimeout(r, DELAY));
    }
  }

  logger.info(`reindexAll complete — embedded=${processed} mlSynced=${mlSynced} failed=${failed} total=${docs.length}`);
  return { processed, failed, total: docs.length, mlSynced };
}

// ── deleteDocument ────────────────────────────────────────────────────────────

export async function deleteDocument(docId: string, deletedBy: string): Promise<void> {
  const doc = await KnowledgeBase.findById(docId);
  if (!doc) throw new AppError(404, 'NOT_FOUND', `KB document ${docId} not found`);

  // Remove from ML service ChromaDB (non-fatal if it fails)
  if (doc.mlDocId) {
    await mlClient.deleteFromKbService(doc.mlDocId);
  }

  if (doc.cloudinaryPublicId) {
    await cloudinary.uploader.destroy(doc.cloudinaryPublicId as string, { resource_type: 'raw' });
  }

  await doc.deleteOne();

  await AuditLog.create({
    actor:        deletedBy,
    action:       AuditAction.KB_DELETE,
    resourceType: 'KnowledgeBase',
    resourceId:   doc._id.toString(),
    oldValue:     { title: doc.title },
  });
}
