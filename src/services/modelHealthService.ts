/**
 * modelHealthService — live ML metrics, PSI drift monitoring, retrain management.
 *
 * Caching: MongoDB-backed, 5-minute TTL.
 * PSI drift check: setInterval every 5 min (wired in src/index.ts).
 *   Do NOT shorten — the Python inference server is GPU-bound.
 */

import { Alert } from '../models/Alert';
import { AuditLog } from '../models/AuditLog';
import { ModelMetrics } from '../models/ModelMetrics';
import {
  AlertSeverity,
  AlertTriggerType,
  AuditAction,
  UserRole,
  WsEvent,
} from '../types';
import { MLLanguage } from '../types/ml.types';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import * as mlClient from './mlClient';
import { publishRetrainTrigger } from '../utils/kafkaProducer';
import { config } from '../config';

const METRICS_CACHE_TTL_MS = 5 * 60 * 1000;

// ── getMetrics ────────────────────────────────────────────────────────────────

export async function getMetrics() {
  // Check MongoDB cache first
  const cached = await ModelMetrics.findOne()
    .sort({ updatedAt: -1 })
    .lean();

  const isStale =
    !cached ||
    Date.now() - new Date(cached.updatedAt as Date).getTime() > METRICS_CACHE_TTL_MS;

  if (!isStale && cached) return cached;

  try {
    const live = await mlClient.getModelMetrics();

    const updated = await ModelMetrics.findOneAndUpdate(
      { modelVersion: live.model_version },
      {
        $set: {
          modelVersion:   live.model_version,
          macroF1:        live.overall.macro_f1,
          recall:         live.overall.recall,
          precision:      live.overall.precision,
          inferenceP95ms: live.overall.inference_ms_p95,
          perLanguage:    live.per_language,
          feedbackQueue:  live.feedback_queue,
          lastRetrain:    new Date(live.last_retrain),
        },
      },
      { upsert: true, new: true },
    );

    return updated;
  } catch {
    // Return stale cache rather than throwing so the dashboard keeps working
    if (cached) {
      logger.warn('modelHealthService.getMetrics: ML service unavailable, returning stale cache');
      return { ...cached, stale: true };
    }
    throw new AppError(503, 'ML_SERVICE_UNAVAILABLE', 'Model metrics unavailable');
  }
}

// ── getF1Trend ────────────────────────────────────────────────────────────────

export async function getF1Trend(days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return ModelMetrics.find({ createdAt: { $gte: since } })
    .sort({ createdAt: 1 })
    .select('modelVersion macroF1 createdAt')
    .lean();
}

// ── checkPsiDrift — called every 5 min by setInterval in index.ts ─────────────

export async function checkPsiDrift(): Promise<void> {
  let metrics: Awaited<ReturnType<typeof getMetrics>>;

  try {
    metrics = await getMetrics();
  } catch {
    return; // Already logged inside getMetrics
  }

  const perLang = (metrics as Record<string, unknown>).perLanguage as
    Record<MLLanguage, { psi: number }> | undefined;

  if (!perLang) return;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  for (const [lang, stats] of Object.entries(perLang) as [MLLanguage, { psi: number }][]) {
    if (stats.psi <= config.mlService.psiThreshold) continue;

    // Idempotency: skip if unresolved alert already exists for this language
    const existing = await Alert.findOne({
      triggerType:      AlertTriggerType.PSI_DRIFT,
      affectedLanguage: lang,
      isResolved:       false,
      createdAt:        { $gte: oneHourAgo },
    }).lean();

    if (existing) continue;

    const alert = await Alert.create({
      severity:         AlertSeverity.HIGH,
      triggerType:      AlertTriggerType.PSI_DRIFT,
      affectedLanguage: lang,
      title:            `PSI Drift — ${lang.toUpperCase()}`,
      description:      `PSI drift detected: ${lang.toUpperCase()} PSI=${stats.psi.toFixed(3)} exceeds threshold ${config.mlService.psiThreshold}. Retraining recommended.`,
      isResolved:       false,
    });

    broadcastWs(WsEvent.MODEL_DRIFT_ALERT, { alert, language: lang, psi: stats.psi });
    logger.warn(`PSI drift alert created — language=${lang} psi=${stats.psi}`);
  }
}

// ── triggerRetrain ────────────────────────────────────────────────────────────

export async function triggerRetrain(
  triggeredBy: string,
  reason: string,
): Promise<{ status: string }> {
  await mlClient.triggerRetrain({ triggered_by: triggeredBy, reason });

  // Belt-and-suspenders: also publish to Kafka
  await publishRetrainTrigger(triggeredBy, reason);

  await AuditLog.create({
    actor:        triggeredBy,
    action:       AuditAction.TRIGGER_RETRAIN,
    resourceType: 'ModelMetrics',
    newValue:     { triggered_by: triggeredBy, reason },
  });

  logger.info(`Retrain triggered by=${triggeredBy} reason=${reason}`);
  return { status: 'queued' };
}

// ── getRetrainingStatus ───────────────────────────────────────────────────────

export async function getRetrainingStatus() {
  return mlClient.getRetrainStatus();
}

// ── getRecentFeedback ─────────────────────────────────────────────────────────

export async function getRecentFeedback(limit = 10) {
  return AuditLog.find({
    action: { $in: [AuditAction.HITL_OVERRIDE, AuditAction.HITL_REJECT] },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate('actor', 'name role')
    .lean();
}

// ── WebSocket helper ──────────────────────────────────────────────────────────

function broadcastWs(event: WsEvent, data: unknown, roles?: UserRole[]): void {
  const io = (global as Record<string, unknown>).io as import('socket.io').Server | undefined;
  if (!io) return;

  if (roles?.length) {
    io.fetchSockets().then((sockets) => {
      sockets
        .filter((s) => roles.includes((s.data as { role?: UserRole }).role as UserRole))
        .forEach((s) => s.emit(event, data));
    }).catch(() => { /* non-critical */ });
  } else {
    io.emit(event, data);
  }
}
