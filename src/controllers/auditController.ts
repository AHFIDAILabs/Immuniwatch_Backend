import { NextFunction, Request, Response } from 'express';
import { AuditLog } from '../models/AuditLog';
import { AuditAction } from '../types';

export async function listLogs(req: Request, res: Response, next: NextFunction) {
  try {
    const page   = Math.max(1, Number(req.query.page) || 1);
    const limit  = Math.min(200, Number(req.query.limit) || 50);
    const action = req.query.action as AuditAction | undefined;
    const actor  = req.query.actor as string | undefined;

    const filter: Record<string, unknown> = {};
    if (action) filter.action = action;
    if (actor)  filter.actor  = actor;

    const [logs, total] = await Promise.all([
      AuditLog.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('actor', 'name role')
        .lean(),
      AuditLog.countDocuments(filter),
    ]);

    res.json({ data: logs, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
}
