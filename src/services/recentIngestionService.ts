/**
 * recentIngestionService — polls GET /recent every 60 s and stores new
 * classified posts from Bluesky + YouTube into MongoDB.
 *
 * For each post from the ML live feed:
 *   1. Skip if already stored (deduplicated by externalId = post_id)
 *   2. Create a Post document
 *   3. Create a Classification document with the ML label + confidence
 *   4. Auto-create a HITLReview (HIGH priority) for misinformation ≥ 0.80 confidence
 *
 * All failures are logged and swallowed — the ingestion loop must never crash
 * the server process.
 */

import { getRecentPosts } from './mlClient';
import { Post }           from '../models/Post';
import { Classification } from '../models/Classification';
import { HITLReview }     from '../models/HITLReview';
import {
  PostPlatform,
  PostLanguage,
  ClassificationLabel,
  HITLStatus,
  HITLPriority,
} from '../types';
import { logger } from '../utils/logger';
import { config } from '../config';

// ── Mapping helpers ────────────────────────────────────────────────────────────

const PLATFORM_MAP: Record<string, PostPlatform> = {
  youtube:    PostPlatform.YOUTUBE,
  bluesky:    PostPlatform.BLUESKY,
  twitter:    PostPlatform.TWITTER,
  facebook:   PostPlatform.FACEBOOK,
  submission: PostPlatform.SUBMISSION,
};

const LANGUAGE_MAP: Record<string, PostLanguage> = {
  en:  PostLanguage.ENGLISH,
  pcm: PostLanguage.PIDGIN,
  ha:  PostLanguage.HAUSA,
  yo:  PostLanguage.YORUBA,
  ig:  PostLanguage.IGBO,
};

const LABEL_MAP: Record<string, ClassificationLabel> = {
  misinformation: ClassificationLabel.MISINFORMATION,
  disinformation: ClassificationLabel.MISINFORMATION,  // treated as misinformation
  factual:        ClassificationLabel.FACTUAL,
  irrelevant:     ClassificationLabel.IRRELEVANT,
};

// ── Core ingestion pass ────────────────────────────────────────────────────────

export async function ingestRecentPosts(): Promise<void> {
  const feed = await getRecentPosts();
  if (!feed.posts.length) return;

  let created = 0;
  let skipped = 0;

  for (const item of feed.posts) {
    try {
      // Deduplicate — skip if already stored
      const exists = await Post.exists({ externalId: item.post_id });
      if (exists) { skipped++; continue; }

      const platform = PLATFORM_MAP[item.platform] ?? PostPlatform.YOUTUBE;
      const language = item.language
        ? (LANGUAGE_MAP[item.language] ?? PostLanguage.ENGLISH)
        : PostLanguage.ENGLISH;

      const label = LABEL_MAP[item.label] ?? ClassificationLabel.FACTUAL;

      // 1. Create Post
      const post = await Post.create({
        externalId:  item.post_id,
        platform,
        language,
        content:     item.content_snippet,
        ingestedAt:  new Date(item.classified_at),
        isProcessed: true,
      });

      // 2. Create Classification
      const cls = await Classification.create({
        postId:       post._id,
        label,
        confidence:   item.confidence,
        entropy:      item.entropy,
        modelVersion: 'v1.0.0',
        alternatives: [],
        kbEvidence:   [],
        processingMs: 0,
        fallback:     false,
      });

      // 3. Auto-queue misinformation with confidence ≥ hitlThreshold for HITL
      if (
        label === ClassificationLabel.MISINFORMATION &&
        item.confidence >= config.classification.hitlThreshold
      ) {
        const priority = item.confidence >= config.classification.highPriorityThreshold
          ? HITLPriority.HIGH
          : HITLPriority.STANDARD;

        await HITLReview.create({
          postId:           post._id,
          classificationId: cls._id,
          priority,
          status:           HITLStatus.PENDING,
          notes:            `Auto-queued from live feed (${item.platform}) — confidence ${(item.confidence * 100).toFixed(1)}%`,
        });
      }

      created++;
    } catch (err) {
      logger.warn(`[recent-ingestion] failed to store post ${item.post_id}: ${(err as Error).message}`);
    }
  }

  if (created > 0) {
    logger.info(`[recent-ingestion] ingested ${created} new posts (${skipped} duplicates skipped) — total since ML start: ${feed.total_since_start}`);
  }
}

// ── Background polling loop ────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 60_000; // 60 seconds

export function startRecentIngestion(): void {
  // Delay the first pass by 25 s — the ML warm-up ping fires at startup and
  // HF free-tier spaces can take 15–20 s to cold-start. Hitting /recent before
  // the space is awake wastes the call and logs a timeout warning.
  const INITIAL_DELAY_MS = 25_000;

  setTimeout(() => {
    ingestRecentPosts().catch((err) =>
      logger.warn(`[recent-ingestion] initial pass failed: ${(err as Error).message}`),
    );
  }, INITIAL_DELAY_MS);

  const timer = setInterval(() => {
    ingestRecentPosts().catch((err) =>
      logger.warn(`[recent-ingestion] poll failed: ${(err as Error).message}`),
    );
  }, POLL_INTERVAL_MS);

  timer.unref();
  logger.info(`[recent-ingestion] polling live ML feed every ${POLL_INTERVAL_MS / 1000}s (first pass in ${INITIAL_DELAY_MS / 1000}s)`);
}
