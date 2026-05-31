// Changes vs. original:
//   • getConnectorStatus: Twitter/Facebook/YouTube now marked status: 'not_integrated'
//     instead of 'down' — they are not connected yet, not degraded. This is an
//     important semantic distinction for operators reading the pipeline page.
//   • getPipelineStatus: mock mode flag surfaced in response so the frontend
//     can show a "mock mode" banner when ML_MOCK_MODE=true
//   • getKafkaHealth: unchanged — Kafka disabled, returns zeroed state correctly

import { Request, Response, NextFunction } from "express";

import { config } from "../config";
import * as mlClient from "../services/mlClient";
import { logger } from "../utils/logger";
import { RetrainingHistory } from "../models/RetrainingHistory";
import { Post } from "../models/Post";
import { PostPlatform } from "../types";

// ── GET /pipeline/status ──────────────────────────────────────────────────────

export async function getPipelineStatus(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const circuitState = mlClient.getCircuitState();

    let healthy = false;
    let modelVersion = "unknown";
    let healthError: string | null = null;

    try {
      const health = await Promise.race([
        mlClient.getHealth(),
        new Promise<never>((_, rej) =>
          setTimeout(() => rej(new Error("timeout")), 2000),
        ),
      ]);
      healthy = health.status === "ok";
      modelVersion = health.model_version;
    } catch (err) {
      healthError = (err as Error).message;
    }

    const activeRetrain = await RetrainingHistory.findOne({
      status: "in_progress",
    })
      .select("startedAt runId")
      .lean();

    let status: "healthy" | "degraded" | "fallback" | "retraining" | "mock";
    if (mlClient.isMockMode()) {
      status = "mock"; // distinct status so frontend can show a banner
    } else if (activeRetrain) {
      status = "retraining";
    } else if (circuitState === "OPEN") {
      status = "fallback";
    } else if (circuitState === "HALF_OPEN" || !healthy) {
      status = "degraded";
    } else {
      status = "healthy";
    }

    const rawUrl = config.mlService.url;
    const midpoint = Math.floor(rawUrl.length / 2);
    const maskedUrl =
      rawUrl.slice(0, midpoint) + "*".repeat(rawUrl.length - midpoint);

    res.json({
      status,
      retrainingStartedAt: activeRetrain
        ? (activeRetrain as { startedAt: Date }).startedAt
        : undefined,
      mockMode: mlClient.isMockMode(),
      mlService: {
        url: maskedUrl,
        circuitState,
        healthy,
        modelVersion,
        lastHealthError: healthError,
        lastChecked: new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /pipeline/connectors ──────────────────────────────────────────────────

export async function getConnectorStatus(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const oneMinAgo  = new Date(Date.now() - 60_000);
    const oneHourAgo = new Date(Date.now() - 60 * 60_000);

    // Count events per minute and last event time for each live platform
    const [
      ytPerMin,   ytLast,
      bsPerMin,   bsLast,
      subPerMin,  subLast,
    ] = await Promise.all([
      Post.countDocuments({ platform: PostPlatform.YOUTUBE,    ingestedAt: { $gte: oneMinAgo  } }),
      Post.findOne({ platform: PostPlatform.YOUTUBE    }).sort({ ingestedAt: -1 }).select('ingestedAt').lean(),
      Post.countDocuments({ platform: PostPlatform.BLUESKY,    ingestedAt: { $gte: oneMinAgo  } }),
      Post.findOne({ platform: PostPlatform.BLUESKY    }).sort({ ingestedAt: -1 }).select('ingestedAt').lean(),
      Post.countDocuments({ platform: PostPlatform.SUBMISSION, ingestedAt: { $gte: oneMinAgo  } }),
      Post.findOne({ platform: PostPlatform.SUBMISSION }).sort({ ingestedAt: -1 }).select('ingestedAt').lean(),
    ]);

    const ts = (doc: unknown) =>
      doc ? (doc as { ingestedAt: Date }).ingestedAt.toISOString() : '';

    // A connector is 'active' if it has received any posts in the last hour
    const ytTotalHour = await Post.countDocuments({ platform: PostPlatform.YOUTUBE,  ingestedAt: { $gte: oneHourAgo } });
    const bsTotalHour = await Post.countDocuments({ platform: PostPlatform.BLUESKY,  ingestedAt: { $gte: oneHourAgo } });

    res.json([
      {
        name:         'YouTube',
        platform:     'youtube',
        status:       ytTotalHour > 0 ? 'active' : 'degraded',
        eventsPerMin: ytPerMin,
        lastEventAt:  ts(ytLast),
        errorRate:    0,
      },
      {
        name:         'Bluesky',
        platform:     'bluesky',
        status:       bsTotalHour > 0 ? 'active' : 'degraded',
        eventsPerMin: bsPerMin,
        lastEventAt:  ts(bsLast),
        errorRate:    0,
      },
      {
        name:         'Twitter/X',
        platform:     'twitter',
        status:       'not_integrated',
        eventsPerMin: 0,
        lastEventAt:  '',
        errorRate:    0,
        note:         'Phase 2 — REST connector not yet wired',
      },
      {
        name:         'Facebook',
        platform:     'facebook',
        status:       'not_integrated',
        eventsPerMin: 0,
        lastEventAt:  '',
        errorRate:    0,
        note:         'Phase 2 — REST connector not yet wired',
      },
      {
        name:         'Submissions',
        platform:     'submission',
        status:       'active',
        eventsPerMin: subPerMin,
        lastEventAt:  ts(subLast),
        errorRate:    0,
      },
    ]);
  } catch (err) {
    next(err);
  }
}

// ── GET /pipeline/recent ──────────────────────────────────────────────────────

export async function getRecentFeed(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const feed = await mlClient.getRecentPosts();
    res.json(feed);
  } catch (err) {
    next(err);
  }
}

// ── GET /pipeline/kafka ───────────────────────────────────────────────────────

export async function getKafkaHealth(
  _req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    // Kafka is disabled (KAFKA_ENABLED=false in .env). Returning zeroed state
    // so the frontend pipeline page reflects the real configuration.
    // Phase 2 will replace this with a live KafkaJS admin client check.
    res.json({
      enabled: false,
      eventsPerSec: 0,
      kafkaLagMs: 0,
      dedupRate: 0,
      topics: [] as { name: string; partitions: number; lag: number }[],
    });
  } catch (err) {
    next(err);
  }
}

export async function getMlHealth(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const health = await mlClient.getHealth();
    res.json({
      ...health,
      circuitBreakerState: mlClient.getCircuitState(),
      mockMode: mlClient.isMockMode(),
      checkedAt: new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}
