import { NextFunction, Request, Response } from 'express';
import { AuthenticatedRequest } from '../types';
import * as modelHealthService from '../services/modelHealthService';

export async function getMetrics(req: Request, res: Response, next: NextFunction) {
  try { res.json(await modelHealthService.getMetrics()); }
  catch (err) { next(err); }
}

export async function getF1Trend(req: Request, res: Response, next: NextFunction) {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
    res.json(await modelHealthService.getF1Trend(days));
  } catch (err) { next(err); }
}

export async function getRetrainStatus(req: Request, res: Response, next: NextFunction) {
  try { res.json(await modelHealthService.getRetrainingStatus()); }
  catch (err) { next(err); }
}

export async function triggerRetrain(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    const { reason } = req.body as { reason: string };
    const result = await modelHealthService.triggerRetrain(user.id, reason ?? 'Manual trigger');
    res.json(result);
  } catch (err) { next(err); }
}

export async function getRecentFeedback(req: Request, res: Response, next: NextFunction) {
  try {
    const limit = Math.min(50, Number(req.query.limit) || 10);
    res.json(await modelHealthService.getRecentFeedback(limit));
  } catch (err) { next(err); }
}
