import { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

import { User }        from '../models/User';
import { Organization } from '../models/Organization';
import { AuditLog }    from '../models/AuditLog';
import { UserRole, AuditAction, AuthenticatedRequest } from '../types';
import { AppError }    from '../utils/AppError';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns the org-scope filter for the requesting user.
 *  org_admin/supervisor see only their org; super_admin sees all. */
function userOrgFilter(actor: AuthenticatedRequest['user']): Record<string, unknown> {
  if (actor.role === UserRole.SUPER_ADMIN) return {};
  return { organizationId: actor.organizationId ?? undefined };
}

// ── List users ────────────────────────────────────────────────────────────────

export async function listUsers(req: Request, res: Response, next: NextFunction) {
  try {
    const actor  = (req as AuthenticatedRequest).user;
    const filter = userOrgFilter(actor);

    const users = await User.find(filter)
      .select('-password -refreshToken')
      .sort({ createdAt: -1 })
      .lean();
    res.json(users);
  } catch (err) { next(err); }
}

// ── Get single user ───────────────────────────────────────────────────────────

export async function getUser(req: Request, res: Response, next: NextFunction) {
  try {
    const actor  = (req as AuthenticatedRequest).user;
    const filter = { _id: req.params.id, ...userOrgFilter(actor) };

    const user = await User.findOne(filter).select('-password -refreshToken').lean();
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    res.json(user);
  } catch (err) { next(err); }
}

// ── Create user ───────────────────────────────────────────────────────────────

export async function inviteUser(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user;
    const { name, email, role, password } = req.body as {
      name: string; email: string; role: UserRole; password: string;
    };

    // Determine which org this user belongs to
    let organizationId: mongoose.Types.ObjectId | undefined;
    if (actor.role === UserRole.SUPER_ADMIN) {
      // super_admin creates org_admins → they must specify an org via body
      const { organizationId: bodyOrg } = req.body as { organizationId?: string };
      if (bodyOrg) organizationId = new mongoose.Types.ObjectId(bodyOrg);
    } else {
      // org_admin creates users within their own org
      if (!actor.organizationId) throw new AppError(400, 'INVALID', 'No organization context');
      organizationId = new mongoose.Types.ObjectId(actor.organizationId);
    }

    // org_admin cannot create other org_admins or super_admins
    if (actor.role === UserRole.ORG_ADMIN && (role === UserRole.ORG_ADMIN || role === UserRole.SUPER_ADMIN)) {
      throw new AppError(403, 'FORBIDDEN', 'org_admin cannot create admin accounts');
    }

    const exists = await User.findOne({
      email:          email.toLowerCase(),
      organizationId: organizationId ?? null,
    }).lean();
    if (exists) throw new AppError(409, 'CONFLICT', 'Email already registered in this organization');

    const created = await User.create({
      name, email: email.toLowerCase(), role, password, organizationId,
    });

    // Keep org user count in sync
    if (organizationId) {
      await Organization.findByIdAndUpdate(organizationId, { $inc: { userCount: 1 } });
    }

    const user = await User.findById(created._id).select('-password -refreshToken').lean();
    res.status(201).json(user);
  } catch (err) { next(err); }
}

// ── Update user ───────────────────────────────────────────────────────────────

export async function updateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const actor  = (req as AuthenticatedRequest).user;
    const targetId = req.params.id;
    const { name, role, active, newPassword } = req.body as {
      name?: string; role?: UserRole; active?: boolean; newPassword?: string;
    };

    if (actor.id === targetId) {
      if (role && role !== actor.role) throw new AppError(403, 'FORBIDDEN', 'You cannot change your own role');
      if (active === false)           throw new AppError(403, 'FORBIDDEN', 'You cannot deactivate your own account');
    }

    const target = await User.findOne({ _id: targetId, ...userOrgFilter(actor) });
    if (!target) throw new AppError(404, 'NOT_FOUND', 'User not found');

    // org_admin cannot promote/change someone to org_admin or higher
    if (actor.role === UserRole.ORG_ADMIN && role && (role === UserRole.ORG_ADMIN || role === UserRole.SUPER_ADMIN)) {
      throw new AppError(403, 'FORBIDDEN', 'org_admin cannot assign admin roles');
    }

    if (name)            target.name     = name;
    if (role)            target.role     = role;
    if (active != null)  target.isActive = active;
    if (newPassword)     target.password = await bcrypt.hash(newPassword, 12);

    await target.save();
    const { password: _pw, refreshToken: _rt, ...safe } = target.toObject();
    res.json(safe);
  } catch (err) { next(err); }
}

// ── Reset password ────────────────────────────────────────────────────────────

export async function resetPassword(req: Request, res: Response, next: NextFunction) {
  try {
    const actor  = (req as AuthenticatedRequest).user;
    const { password } = req.body as { password: string };

    if (actor.id === req.params.id) throw new AppError(400, 'INVALID', 'Use profile settings to change your own password');

    const hash = await bcrypt.hash(password, 12);
    const user = await User.findOneAndUpdate(
      { _id: req.params.id, ...userOrgFilter(actor) },
      { password: hash, refreshToken: null },
      { new: true },
    ).select('-password -refreshToken');

    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');
    res.json({ message: 'Password reset successfully', userId: user._id });
  } catch (err) { next(err); }
}

// ── Delete user ───────────────────────────────────────────────────────────────

export async function deleteUser(req: Request, res: Response, next: NextFunction) {
  try {
    const actor = (req as AuthenticatedRequest).user;
    if (actor.id === req.params.id) throw new AppError(400, 'INVALID', 'You cannot delete your own account');

    const user = await User.findOneAndDelete({ _id: req.params.id, ...userOrgFilter(actor) }).lean();
    if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found');

    if (user.organizationId) {
      await Organization.findByIdAndUpdate(user.organizationId, { $inc: { userCount: -1 } });
    }

    res.json({ message: 'User deleted', userId: req.params.id });
  } catch (err) { next(err); }
}

// ── Feedback stats ────────────────────────────────────────────────────────────

export async function getFeedbackStats(req: Request, res: Response, next: NextFunction) {
  try {
    const stats = await AuditLog.aggregate([
      { $match: { actor: req.params.id, action: { $in: [AuditAction.HITL_OVERRIDE, AuditAction.HITL_REJECT] } } },
      { $group: { _id: '$action', count: { $sum: 1 }, lastAt: { $max: '$createdAt' } } },
    ]);

    const overrides  = stats.find((s) => s._id === AuditAction.HITL_OVERRIDE)?.count ?? 0;
    const rejections = stats.find((s) => s._id === AuditAction.HITL_REJECT)?.count   ?? 0;
    const lastContributedAt =
      stats.reduce<Date | null>((max, s) => (!max || s.lastAt > max ? s.lastAt : max), null);

    res.json({ overrides, rejections, total: overrides + rejections, lastContributedAt });
  } catch (err) { next(err); }
}
