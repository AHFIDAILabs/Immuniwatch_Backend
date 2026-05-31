import { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';

import { User } from '../models/User';
import { AuditLog } from '../models/AuditLog';
import { UserRole, AuditAction } from '../types';
import { AppError } from '../utils/AppError';
import { AuthenticatedRequest } from '../types';

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
    const { name, email, role, password } = req.body as {
      name:     string;
      email:    string;
      role:     UserRole;
      password: string;
    };

    const exists = await User.findOne({ email: email.toLowerCase() }).lean();
    if (exists) throw new AppError(409, 'CONFLICT', 'Email already registered');

    const created = await User.create({ name, email: email.toLowerCase(), role, password });
    const user = await User.findById(created._id).select('-password -refreshToken').lean();
    res.status(201).json(user);
  } catch (err) { next(err); }
}

export async function updateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const { name, role, active } = req.body as { name?: string; role?: UserRole; active?: boolean };

    // Prevent super_admin from deactivating themselves
    if (actor?.id === req.params.id && active === false) {
      throw new AppError(400, 'INVALID', 'You cannot deactivate your own account');
    }

    const user = await User.findByIdAndUpdate(
      req.params.id,
      {
        ...(name   !== undefined && { name }),
        ...(role   !== undefined && { role }),
        ...(active !== undefined && { isActive: active }),
      },
      { new: true, runValidators: true },
    ).select('-password -refreshToken');

    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    res.json(user);
  } catch (err) { next(err); }
}

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const { password } = req.body as { password: string };

    // Prevent super_admin from resetting their own password via this endpoint
    // (they should use the normal profile/change-password flow)
    if (actor?.id === req.params.id) {
      throw new AppError(400, 'INVALID', 'Use your profile settings to change your own password');
    }

    const hash = await bcrypt.hash(password, 12);
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { password: hash, refreshToken: null },
      { new: true },
    ).select('-password -refreshToken');

    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

    // Invalidate any existing sessions by clearing the refresh token
    res.json({ message: 'Password reset successfully', userId: user._id });
  } catch (err) { next(err); }
}

export async function deleteUser(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user;

    if (actor?.id === req.params.id) {
      throw new AppError(400, 'INVALID', 'You cannot delete your own account');
    }

    const user = await User.findByIdAndDelete(req.params.id).lean();
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

    res.json({ message: 'User deleted', userId: req.params.id });
  } catch (err) { next(err); }
}

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
          _id:    '$action',
          count:  { $sum: 1 },
          lastAt: { $max: '$createdAt' },
        },
      },
    ]);

    const overrides   = stats.find((s) => s._id === AuditAction.HITL_OVERRIDE)?.count ?? 0;
    const rejections  = stats.find((s) => s._id === AuditAction.HITL_REJECT)?.count ?? 0;
    const lastContributedAt =
      stats.reduce<Date | null>((max, s) => (!max || s.lastAt > max ? s.lastAt : max), null);

    res.json({ overrides, rejections, total: overrides + rejections, lastContributedAt });
  } catch (err) { next(err); }
}
