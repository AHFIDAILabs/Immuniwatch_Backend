// settingsController — GET and PATCH /settings
// Per-org settings with platform defaults fallback.
// _key: 'platform' for super_admin; 'org_<id>' for org users.

import { Request, Response, NextFunction } from 'express';

import { AppSettings }          from '../models/AppSettings';
import { config }               from '../config';
import * as mlClient            from '../services/mlClient';
import { AuthenticatedRequest, UserRole } from '../types';

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
    region:          'Nigeria',
    organisation:    'ImmuniWatch Platform',
    backendVersion:  'v1.5.0',
    frontendVersion: 'v1.5.0',
    mlServiceUrl:    config.mlService.url,
    mlServiceStatus: mlStatus,
    mlModelVersion:  modelVersion,
    mockMode:        mlClient.isMockMode(),
    kafkaEnabled:    config.kafka.enabled,
  };
}

function settingsKey(req: Request): string {
  const { user } = req as AuthenticatedRequest;
  return user.role === UserRole.SUPER_ADMIN ? 'platform' : `org_${user.organizationId ?? 'platform'}`;
}

const DEFAULTS = {
  surgePosts:            200,
  hitlAutoEscalateAbove: 85,
  psiDriftAlert:         0.20,
  overrideRateAlert:     25,
  macroF1Target:         0.80,
  inferenceP95Ms:        200,
  feedbackQueueMax:      5000,
  notifEmail:            '',
};

export async function getSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const key = settingsKey(req);
    const [stored, systemInfo] = await Promise.all([
      AppSettings.findOne({ _key: key }).lean(),
      buildSystemInfo(),
    ]);

    // Org settings inherit from platform defaults for any unset field
    let platformDefaults = DEFAULTS;
    if (key !== 'platform') {
      const platform = await AppSettings.findOne({ _key: 'platform' }).lean();
      if (platform) platformDefaults = { ...DEFAULTS, ...platform };
    }

    res.json({ ...(stored ?? platformDefaults), systemInfo });
  } catch (err) { next(err); }
}

export async function updateSettings(req: Request, res: Response, next: NextFunction) {
  try {
    const key = settingsKey(req);
    const { user } = req as AuthenticatedRequest;

    const [updated, systemInfo] = await Promise.all([
      AppSettings.findOneAndUpdate(
        { _key: key },
        { $set: { ...req.body, organizationId: user.organizationId ?? undefined } },
        { upsert: true, new: true, runValidators: true },
      ).lean(),
      buildSystemInfo(),
    ]);

    res.json({ ...(updated ?? {}), systemInfo });
  } catch (err) { next(err); }
}
