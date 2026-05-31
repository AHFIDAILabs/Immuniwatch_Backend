/**
 * modelHealthService — live ML metrics, PSI drift monitoring, retrain management.
 *
 * Changes vs. original:
 *   • perLanguage mapping: now includes recall, sets sampleCount to 0 (the ML
 *     service v1.0.0 does not return sample_count — the original code mapped
 *     stats.sample_count which was always undefined, failing Mongoose validation
 *     and causing every live-data upsert to silently error; the service then
 *     returned stale seed data indefinitely)
 *   • computedAt: now stored from the ML service's own computed_at timestamp
 *   • warmUpMetricsCache(): exported so index.ts can eager-fetch on startup,
 *     overwriting seed data with live data as soon as the service comes online
 *   • stale: true is now set in the returned document when cache is served
 *
 * Caching: MongoDB-backed, 5-minute TTL.
 * PSI drift check: setInterval every 60 min (wired in src/index.ts).
 */

import { Alert } from "../models/Alert";
import { AuditLog } from "../models/AuditLog";
import { ModelMetrics } from "../models/ModelMetrics";
import {
  AlertSeverity,
  AlertTriggerType,
  AuditAction,
  UserRole,
  WsEvent,
} from "../types";
import { MLLanguage } from "../types/ml.types";
import { AppError } from "../utils/AppError";
import { logger } from "../utils/logger";
import * as mlClient from "./mlClient";
import { config } from "../config";

const METRICS_CACHE_TTL_MS = 5 * 60 * 1000;

// ── getMetrics ────────────────────────────────────────────────────────────────

export async function getMetrics() {
  const cached = await ModelMetrics.findOne().sort({ updatedAt: -1 }).lean();

  const isStale =
    !cached ||
    Date.now() - new Date(cached.updatedAt as Date).getTime() >
      METRICS_CACHE_TTL_MS;

  if (!isStale && cached) return cached;

  try {
    const live = await mlClient.getModelMetrics();

    // FIX: map recall per language; sampleCount not returned by v1.0.0 API → default 0
    const perLanguage = Object.fromEntries(
      Object.entries(live.by_language).map(([lang, stats]) => [
        lang,
        {
          macroF1: stats.macro_f1,
          recall: stats.recall,
          psi: stats.psi,
          sampleCount: 0, // not provided by ML service v1.0.0
        },
      ]),
    );

    const updated = await ModelMetrics.findOneAndUpdate(
      { modelVersion: live.model_version },
      {
        $set: {
          modelVersion: live.model_version,
          macroF1: live.overall.macro_f1,
          recall: live.overall.recall,
          precision: live.overall.precision,
          inferenceP95ms: live.overall.latency_p95_ms,
          perLanguage,
          computedAt: live.computed_at ? new Date(live.computed_at) : undefined,
        },
      },
      { upsert: true, new: true },
    ).lean();

    return updated;
  } catch (err) {
    // Return stale cache rather than throwing — dashboard keeps working
    if (cached) {
      logger.warn(
        `modelHealthService.getMetrics: ML service unavailable, returning stale cache — ${(err as Error).message}`,
      );
      return { ...cached, stale: true };
    }
    throw new AppError(
      503,
      "ML_SERVICE_UNAVAILABLE",
      "Model metrics unavailable",
    );
  }
}

// ── warmUpMetricsCache ────────────────────────────────────────────────────────
// Call this from index.ts after the server starts (with a short delay so the
// ML service has time to warm up). It fetches live metrics and overwrites the
// seed data in MongoDB, ensuring the dashboard shows real numbers on first load.

export async function warmUpMetricsCache(): Promise<void> {
  try {
    // Force stale so getMetrics always fetches from the live service
    const cached = await ModelMetrics.findOne().sort({ updatedAt: -1 }).lean();
    if (cached) {
      // Temporarily backdate updatedAt so the TTL check treats it as stale
      await ModelMetrics.updateMany({}, { $set: { updatedAt: new Date(0) } });
    }
    await getMetrics();
    logger.info(
      "modelHealthService.warmUpMetricsCache: live metrics cached successfully",
    );
  } catch (err) {
    // Non-fatal — seed data will be returned until the next TTL expiry
    logger.warn(
      `modelHealthService.warmUpMetricsCache: ${(err as Error).message}`,
    );
  }
}

// ── getF1Trend ────────────────────────────────────────────────────────────────

export async function getF1Trend(days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return ModelMetrics.find({ createdAt: { $gte: since } })
    .sort({ createdAt: 1 })
    .select("modelVersion macroF1 recall createdAt computedAt")
    .lean();
}

// ── checkPsiDrift — called every 60 min by setInterval in index.ts ────────────

export async function checkPsiDrift(): Promise<void> {
  let metrics: Awaited<ReturnType<typeof getMetrics>>;
  try {
    metrics = await getMetrics();
  } catch {
    return;
  }

  const perLang = (metrics as Record<string, unknown>).perLanguage as
    | Record<MLLanguage, { psi: number }>
    | undefined;

  if (!perLang) return;

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  for (const [lang, stats] of Object.entries(perLang) as [
    MLLanguage,
    { psi: number },
  ][]) {
    if (stats.psi <= config.mlService.psiThreshold) continue;

    const existing = await Alert.findOne({
      triggerType: AlertTriggerType.PSI_DRIFT,
      affectedLanguage: lang,
      isResolved: false,
      createdAt: { $gte: oneHourAgo },
    }).lean();

    if (existing) continue;

    const alert = await Alert.create({
      severity: AlertSeverity.HIGH,
      triggerType: AlertTriggerType.PSI_DRIFT,
      affectedLanguage: lang,
      title: `PSI Drift — ${lang.toUpperCase()}`,
      message: `PSI=${stats.psi.toFixed(3)} exceeds threshold ${config.mlService.psiThreshold} for language ${lang.toUpperCase()}. Retraining recommended.`,
      psiValue: stats.psi,
      isResolved: false,
    });

    broadcastWs(WsEvent.MODEL_DRIFT_ALERT, {
      alert,
      language: lang,
      psi: stats.psi,
    });
    logger.warn(`PSI drift alert created — language=${lang} psi=${stats.psi}`);
  }
}

// ── triggerRetrain ────────────────────────────────────────────────────────────

export async function triggerRetrain(
  triggeredBy: string,
  reason: string,
): Promise<{ status: string }> {
  await mlClient.triggerRetrain({ triggered_by: triggeredBy, reason });

  await AuditLog.create({
    actor: triggeredBy,
    action: AuditAction.TRIGGER_RETRAIN,
    resourceType: "ModelMetrics",
    newValue: { triggered_by: triggeredBy, reason },
  });

  logger.info(`Retrain triggered by=${triggeredBy} reason=${reason}`);
  return { status: "queued" };
}

// ── getRetrainingStatus ───────────────────────────────────────────────────────

export async function getRetrainingStatus() {
  const status = await mlClient.getRetrainStatus();
  return (
    status ?? {
      status: "idle",
      progress: 0,
      eta_minutes: 0,
      current_epoch: 0,
      total_epochs: 0,
    }
  );
}

// ── getRecentFeedback ─────────────────────────────────────────────────────────

export async function getRecentFeedback(limit = 10) {
  return AuditLog.find({
    action: { $in: [AuditAction.HITL_OVERRIDE, AuditAction.HITL_REJECT] },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .populate("actor", "name role")
    .lean();
}

// ── WebSocket helper ──────────────────────────────────────────────────────────

function broadcastWs(event: WsEvent, data: unknown, roles?: UserRole[]): void {
  const io = (global as Record<string, unknown>).io as
    | import("socket.io").Server
    | undefined;
  if (!io) return;

  if (roles?.length) {
    io.fetchSockets()
      .then((sockets) => {
        sockets
          .filter((s) =>
            roles.includes((s.data as { role?: UserRole }).role as UserRole),
          )
          .forEach((s) => s.emit(event, data));
      })
      .catch(() => {
        /* non-critical */
      });
  } else {
    io.emit(event, data);
  }
}
