import { Request, Response, NextFunction } from 'express';
import mongoose from 'mongoose';
import crypto from 'crypto';

import { Organization } from '../models/Organization';
import { User }         from '../models/User';
import { Post }         from '../models/Post';
import { HITLReview }   from '../models/HITLReview';
import { Alert }        from '../models/Alert';
import { AppSettings }  from '../models/AppSettings';
import { AuthenticatedRequest, UserRole, HITLStatus } from '../types';
import { AppError }     from '../utils/AppError';
import { generateInviteToken, inviteLink } from './authController';

const INVITE_TTL_HOURS = 72;

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── List all organizations (super_admin only) ─────────────────────────────────

export async function listOrganizations(req: Request, res: Response, next: NextFunction) {
  try {
    const page   = Math.max(1, Number(req.query.page)  || 1);
    const limit  = Math.min(100, Number(req.query.limit) || 20);
    const status = req.query.status as string | undefined;
    const search = req.query.search as string | undefined;

    const filter: Record<string, unknown> = {};
    if (status) filter.status = status;
    if (search?.trim()) filter.$or = [
      { name:         { $regex: search, $options: 'i' } },
      { contactEmail: { $regex: search, $options: 'i' } },
      { region:       { $regex: search, $options: 'i' } },
    ];

    const [orgs, total] = await Promise.all([
      Organization.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('createdBy', 'name email')
        .lean(),
      Organization.countDocuments(filter),
    ]);

    // Enrich with live user count
    const orgIds = orgs.map((o) => o._id);
    const userCounts = await User.aggregate([
      { $match: { organizationId: { $in: orgIds } } },
      { $group: { _id: '$organizationId', count: { $sum: 1 } } },
    ]);
    const countMap = new Map(userCounts.map((u: { _id: unknown; count: number }) => [u._id?.toString(), u.count]));

    const enriched = orgs.map((o) => ({
      ...o,
      userCount: countMap.get(o._id.toString()) ?? 0,
    }));

    res.json({ data: enriched, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
}

// ── Get one organization ──────────────────────────────────────────────────────

export async function getOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const org = await Organization.findById(req.params.id)
      .populate('createdBy', 'name email')
      .lean();
    if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found');

    // Fetch stats in parallel
    const orgId = new mongoose.Types.ObjectId(req.params.id);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [users, postsToday, postsTotal, hitlPending, hitlTotal, alerts] = await Promise.all([
      User.find({ organizationId: orgId }).select('name email role isActive lastActive').lean(),
      Post.countDocuments({ organizationId: orgId, createdAt: { $gte: today } }),
      Post.countDocuments({ organizationId: orgId }),
      HITLReview.countDocuments({ organizationId: orgId, status: HITLStatus.PENDING }),
      HITLReview.countDocuments({ organizationId: orgId }),
      Alert.countDocuments({ organizationId: orgId, isResolved: false }),
    ]);

    res.json({
      ...org,
      users,
      stats: { postsToday, postsTotal, hitlPending, hitlTotal, openAlerts: alerts },
    });
  } catch (err) { next(err); }
}

// ── Create organization ───────────────────────────────────────────────────────

export async function createOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    const {
      name, description, region, state, contactEmail, phoneNumber, plan,
    } = req.body as {
      name: string; description?: string; region: string; state: string;
      contactEmail: string; phoneNumber?: string; plan?: string;
    };

    const slug = slugify(name);
    const existing = await Organization.findOne({ slug }).lean();
    if (existing) throw new AppError(409, 'CONFLICT', `An organization with slug "${slug}" already exists`);

    const org = await Organization.create({
      name, slug, description, region, state, contactEmail, phoneNumber,
      plan: plan ?? 'basic',
      status: 'active',
      createdBy: user.id,
    });

    res.status(201).json(org);
  } catch (err) { next(err); }
}

// ── Update organization ───────────────────────────────────────────────────────

export async function updateOrganization(req: Request, res: Response, next: NextFunction) {
  try {
    const { name, description, region, state, contactEmail, phoneNumber, plan, status } = req.body as {
      name?: string; description?: string; region?: string; state?: string;
      contactEmail?: string; phoneNumber?: string; plan?: string; status?: string;
    };

    const org = await Organization.findByIdAndUpdate(
      req.params.id,
      {
        ...(name        && { name }),
        ...(description !== undefined && { description }),
        ...(region      && { region }),
        ...(state       && { state }),
        ...(contactEmail && { contactEmail }),
        ...(phoneNumber !== undefined && { phoneNumber }),
        ...(plan        && { plan }),
        ...(status      && { status }),
      },
      { new: true, runValidators: true },
    ).lean();

    if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found');
    res.json(org);
  } catch (err) { next(err); }
}

// ── Suspend / reactivate organization ────────────────────────────────────────

export async function setOrgStatus(req: Request, res: Response, next: NextFunction) {
  try {
    const { status } = req.body as { status: 'active' | 'suspended' | 'trial' };
    const org = await Organization.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true },
    ).lean();
    if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found');
    res.json(org);
  } catch (err) { next(err); }
}

// ── Platform-wide overview (super_admin only) ─────────────────────────────────

export async function getPlatformOverview(_req: Request, res: Response, next: NextFunction) {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const [
      totalOrgs, activeOrgs, totalUsers,
      postsToday, postsTotal,
      hitlPending, openAlerts,
      recentOrgs,
      orgActivity,
    ] = await Promise.all([
      Organization.countDocuments({}),
      Organization.countDocuments({ status: 'active' }),
      User.countDocuments({ organizationId: { $exists: true } }),
      Post.countDocuments({ createdAt: { $gte: today } }),
      Post.countDocuments({}),
      HITLReview.countDocuments({ status: HITLStatus.PENDING }),
      Alert.countDocuments({ isResolved: false }),

      // 5 most recently created orgs
      Organization.find({})
        .sort({ createdAt: -1 })
        .limit(5)
        .select('name slug status plan createdAt region')
        .lean(),

      // Per-org activity (posts today + users) for the table
      Post.aggregate([
        { $match: { createdAt: { $gte: today } } },
        { $group: { _id: '$organizationId', postsToday: { $sum: 1 } } },
      ]),
    ]);

    // Build org activity map
    const activityMap = new Map(
      (orgActivity as { _id: unknown; postsToday: number }[])
        .map((a) => [a._id?.toString(), a.postsToday]),
    );

    // All orgs with user counts + today's posts
    const allOrgs = await Organization.find({})
      .sort({ createdAt: -1 })
      .select('name slug status plan region state contactEmail createdAt')
      .lean();

    const userCounts = await User.aggregate([
      { $match: { organizationId: { $exists: true } } },
      { $group: { _id: '$organizationId', count: { $sum: 1 } } },
    ]);
    const userMap = new Map(
      (userCounts as { _id: unknown; count: number }[]).map((u) => [u._id?.toString(), u.count]),
    );

    const hitlByOrg = await HITLReview.aggregate([
      { $match: { status: HITLStatus.PENDING } },
      { $group: { _id: '$organizationId', pending: { $sum: 1 } } },
    ]);
    const hitlMap = new Map(
      (hitlByOrg as { _id: unknown; pending: number }[]).map((h) => [h._id?.toString(), h.pending]),
    );

    const orgSummaries = allOrgs.map((o) => ({
      ...o,
      userCount:   userMap.get(o._id.toString()) ?? 0,
      postsToday:  activityMap.get(o._id.toString()) ?? 0,
      hitlPending: hitlMap.get(o._id.toString()) ?? 0,
    }));

    res.json({
      summary: { totalOrgs, activeOrgs, totalUsers, postsToday, postsTotal, hitlPending, openAlerts },
      recentOrgs,
      organizations: orgSummaries,
    });
  } catch (err) { next(err); }
}

// ── Create org_admin user for an organization ─────────────────────────────────

export async function createOrgAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId = req.params.id;

    const org = await Organization.findById(orgId).lean();
    if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found');

    const { name, email } = req.body as { name: string; email: string };

    const exists = await User.findOne({ email: email.toLowerCase(), organizationId: orgId }).lean();
    if (exists) throw new AppError(409, 'CONFLICT', 'Email already registered in this organization');

    const token     = generateInviteToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000);

    const created = await User.create({
      name,
      email:                email.toLowerCase(),
      password:             crypto.randomBytes(24).toString('hex'), // placeholder
      role:                 UserRole.ORG_ADMIN,
      organizationId:       new mongoose.Types.ObjectId(orgId),
      isActive:             true,
      isInvitePending:      true,
      inviteToken:          token,
      inviteTokenExpiresAt: expiresAt,
    });

    await Organization.findByIdAndUpdate(orgId, { $inc: { userCount: 1 } });

    res.status(201).json({
      user:       { _id: created._id, name: created.name, email: created.email, role: created.role },
      inviteLink: inviteLink(token),
      expiresAt:  expiresAt.toISOString(),
    });
  } catch (err) { next(err); }
}
