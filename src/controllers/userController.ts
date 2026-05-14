import { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';

import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { UserRole, AuditAction } from '../types';
import { AppError } from '../utils/AppError';

export async function listUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const users = await User.find()
      .select('-password -refreshToken')
      .sort({ createdAt: -1 })
      .lean();
    res.json(users);
  } catch (err) { next(err); }
}

export async function getUser(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await User.findById(req.params.id)
      .select('-password -refreshToken')
      .lean();
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    res.json(user);
  } catch (err) { next(err); }
}

export async function inviteUser(req: Request, res: Response, next: NextFunction) {
  try {
    // Validated by inviteUserSchema middleware
    const { name, email, role, password } = req.body as {
      name:     string;
      email:    string;
      role:     UserRole;
      password: string;
    };

    const exists = await User.findOne({ email: email.toLowerCase() }).lean();
    if (exists) throw new AppError(409, 'CONFLICT', 'Email already registered');

    const user = await User.create({ name, email: email.toLowerCase(), role, password });
    res.status(201).json({ id: user._id, name: user.name, email: user.email, role: user.role });
  } catch (err) { next(err); }
}

export async function updateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, role, active } = req.body as { name?: string; role?: UserRole; active?: boolean };
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { ...(name && { name }), ...(role && { role }), ...(active !== undefined && { isActive: active }) },
      { new: true, runValidators: true },
    ).select('-password -refreshToken');

    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    res.json(user);
  } catch (err) { next(err); }
}

// Analyst feedback stats for User Management screen
export async function getFeedbackStats(req: Request, res: Response, next: NextFunction) {
  try {
    const stats = await AuditLog.aggregate([
      {
        $match: {
          actor:  req.params.id,
          action: { $in: [AuditAction.HITL_OVERRIDE, AuditAction.HITL_REJECT] },
        },
      },
      {
        $group: {
          _id:     '$action',
          count:   { $sum: 1 },
          lastAt:  { $max: '$createdAt' },
        },
      },
    ]);

    const overrides = stats.find((s) => s._id === AuditAction.HITL_OVERRIDE)?.count ?? 0;
    const rejections = stats.find((s) => s._id === AuditAction.HITL_REJECT)?.count ?? 0;
    const lastContributedAt =
      stats.reduce<Date | null>((max, s) => (!max || s.lastAt > max ? s.lastAt : max), null);

    res.json({ overrides, rejections, total: overrides + rejections, lastContributedAt });
  } catch (err) { next(err); }
}
