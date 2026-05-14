import { NextFunction, Request, Response } from 'express';
import { Alert } from '../models/Alert';
import { AuthenticatedRequest, AlertSeverity, AlertTriggerType } from '../types';

export async function listAlerts(req: Request, res: Response, next: NextFunction) {
  try {
    const page     = Math.max(1, Number(req.query.page) || 1);
    const limit    = Math.min(100, Number(req.query.limit) || 20);
    const severity = req.query.severity as AlertSeverity | undefined;
    const resolved = req.query.resolved !== undefined
      ? req.query.resolved === 'true'
      : undefined;

    const filter: Record<string, unknown> = {};
    if (severity)            filter.severity = severity;
    if (resolved !== undefined) filter.isResolved = resolved;

    const [alerts, total] = await Promise.all([
      Alert.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
      Alert.countDocuments(filter),
    ]);

    res.json({ data: alerts, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
}

export async function resolveAlert(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    const alert = await Alert.findByIdAndUpdate(
      req.params.id,
      { isResolved: true, resolvedAt: new Date(), resolvedBy: user.id },
      { new: true },
    );
    if (!alert) return res.status(404).json({ message: 'Alert not found' });
    res.json(alert);
  } catch (err) { next(err); }
}
