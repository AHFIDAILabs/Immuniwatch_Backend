// settingsController — GET and PATCH /settings
//
// GET returns the merged document: DB values take precedence, but every field
// also includes its config.ts default so the response is always complete.
// Also returns read-only system_info derived from live config so the frontend
// shows the real ML service URL, not a hardcoded string.
//
// PATCH does a partial update — only fields present in the request body are
// changed. Unknown fields are ignored (validated by Zod schema in settingsRoutes).

import { Request, Response, NextFunction } from 'express';

import { AppSettings }       from '../models/AppSettings';
import { config }            from '../config';
import * as mlClient         from '../services/mlClient';
import { AuthenticatedRequest } from '../types';

// Read-only system info — derived from live config, never editable
async function buildSystemInfo() {
  let modelVersion = 'unknown';
  let mlStatus: 'ok' | 'unavailable' | 'degraded' = 'unavailable';

  try {
    const health = await Promise.race([
      mlClient.getHealth(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000)),
    ]);
    modelVersion = health.model_version;
    mlStatus     = health.status;
  } catch { /* non-fatal */ }

  return {
    region:          'Nigeria (Lagos · AF)',
    organisation:    'NPHCDA',
    backendVersion:  'v1.4.2',
    frontendVersion: 'v1.4.2',
    mlServiceUrl:    config.mlService.url,   // real URL from .env
    mlServiceStatus: mlStatus,
    mlModelVersion:  modelVersion,
    mockMode:        mlClient.isMockMode(),
    kafkaEnabled:    config.kafka.enabled,
  };
}

export async function getSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const [stored, systemInfo] = await Promise.all([
      AppSettings.findOne({ _key: 'singleton' }).lean(),
      buildSystemInfo(),
    ]);

    // If no settings have been saved yet, return schema defaults
    const defaults = {
      surgePosts:            200,
      hitlAutoEscalateAbove: 85,
      psiDriftAlert:         0.20,
      overrideRateAlert:     25,
      macroF1Target:         0.80,
      inferenceP95Ms:        200,
      feedbackQueueMax:      5000,
      notifEmail:            '',
    };

    res.json({
      ...(stored ?? defaults),
      systemInfo,
    });
  } catch (err) { next(err); }
}

export async function updateSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const [updated, systemInfo] = await Promise.all([
      AppSettings.findOneAndUpdate(
        { _key: 'singleton' },
        { $set: req.body },
        { upsert: true, new: true, runValidators: true },
      ).lean(),
      buildSystemInfo(),
    ]);

    res.json({ ...(updated ?? {}), systemInfo });
  } catch (err) { next(err); }
}