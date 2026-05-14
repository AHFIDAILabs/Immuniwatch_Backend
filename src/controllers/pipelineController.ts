import { Request, Response, NextFunction } from 'express';

import { config } from '../config';
import * as mlClient from '../services/mlClient';
import { logger } from '../utils/logger';
import { RetrainingHistory } from '../models/RetrainingHistory';

// ── GET /pipeline/status ──────────────────────────────────────────────────────

export async function getPipelineStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const circuitState = mlClient.getCircuitState();

    // Quick health probe — independent 2 s timeout, does NOT trip the main breaker
    let healthy = false;
    let modelVersion = 'unknown';
    let healthError: string | null = null;

    try {
      const health = await Promise.race([
        mlClient.getHealth(),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
      ]);
      healthy      = health.status === 'ok';
      modelVersion = health.model_version;
    } catch (err) {
      healthError = (err as Error).message;
    }

    // Check if a retrain is currently in progress
    const activeRetrain = await RetrainingHistory.findOne({ status: 'in_progress' })
      .select('startedAt runId')
      .lean();

    // Map circuit state + health to frontend status enum
    let status: 'healthy' | 'degraded' | 'fallback' | 'retraining';
    if (activeRetrain) {
      status = 'retraining';
    } else if (circuitState === 'OPEN') {
      status = 'fallback';
    } else if (circuitState === 'HALF_OPEN' || !healthy) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    // Mask last half of the ML service URL
    const rawUrl   = config.mlService.url;
    const midpoint = Math.floor(rawUrl.length / 2);
    const maskedUrl = rawUrl.slice(0, midpoint) + '*'.repeat(rawUrl.length - midpoint);

    res.json({
      status,
      retrainingStartedAt: activeRetrain ? (activeRetrain as { startedAt: Date }).startedAt : undefined,
      mlService: {
        url:             maskedUrl,
        circuitState,
        healthy,
        modelVersion,
        lastHealthError: healthError,
        lastChecked:     new Date().toISOString(),
      },
    });
  } catch (err) {
    next(err);
  }
}

// ── GET /pipeline/ml-health — SuperAdmin + Supervisor ────────────────────────

export async function getConnectorStatus(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json([
      { connector: 'Twitter/X',   method: 'Filtered Stream v2', status: 'healthy',      lastEvent: 'now',   ratePerMin: 214 },
      { connector: 'Facebook',    method: 'CrowdTangle API',    status: 'healthy',      lastEvent: '12s',   ratePerMin:  98 },
      { connector: 'YouTube',     method: 'Data API v3',        status: 'rate_limited', lastEvent: '4 min', ratePerMin:  22 },
      { connector: 'Submissions', method: 'REST API',           status: 'healthy',      lastEvent: '2 min', ratePerMin:  10 },
    ]);
  } catch (err) { next(err); }
}

export async function getKafkaHealth(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      eventsPerSec: 344,
      kafkaLagMs:   400,
      dedupRate:    18.3,
      topics: [
        { topic: 'raw-posts',        lagMs:  400, throughputPerSec: 344, retention: '7d',        status: 'ok' },
        { topic: 'classified-posts', lagMs: 1100, throughputPerSec: 298, retention: '30d',       status: 'ok' },
        { topic: 'hitl-queue',       lagMs:  200, throughputPerSec:  12, retention: 'Until ack', status: 'ok' },
      ],
    });
  } catch (err) { next(err); }
}

export async function getMlHealth(req: Request, res: Response, next: NextFunction) {
  try {
    const health = await mlClient.getHealth();
    res.json({
      ...health,
      circuitBreakerState: mlClient.getCircuitState(),
      checkedAt:           new Date().toISOString(),
    });
  } catch (err) {
    next(err);
  }
}
