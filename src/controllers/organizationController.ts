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
import { orgClaimLink } from './authController';

const CLAIM_TTL_DAYS = 30;  // claim links are valid for 30 days, regeneratable by super admin

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
      .select('+claimToken +claimTokenExpiresAt')
      .populate('createdBy', 'name email')
      .lean();
    if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found');

    // Fetch stats in parallel
    const orgId = new mongoose.Types.ObjectId(req.params.id);
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Posts and HITL use a "global OR org" filter because ML-ingested posts
    // (Bluesky/YouTube) have no organizationId — all orgs should see them in stats.
    const globalOrOrg = {
      $or: [
        { organizationId: orgId },
        { organizationId: null },
        { organizationId: { $exists: false } },
      ],
    };

    const [users, postsToday, postsTotal, hitlPending, hitlTotal, alerts] = await Promise.all([
      User.find({ organizationId: orgId }).select('name email role isActive lastActive').lean(),
      Post.countDocuments({ ...globalOrOrg, createdAt: { $gte: today } }),
      Post.countDocuments(globalOrOrg),
      HITLReview.countDocuments({ ...globalOrOrg, status: HITLStatus.PENDING }),
      HITLReview.countDocuments(globalOrOrg),
      Alert.countDocuments({ organizationId: orgId, isResolved: false }),
    ]);

    res.json({
      ...org,
      users,
      stats: { postsToday, postsTotal, hitlPending, hitlTotal, openAlerts: alerts },
      // Include claim link for super_admin so they can copy/share it from the detail page
      claimLink: (!org.adminClaimed && org.claimToken) ? orgClaimLink(org.claimToken) : null,
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

    // Auto-generate the claim token — super admin copies and shares this link
    const token     = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + CLAIM_TTL_DAYS * 24 * 60 * 60 * 1000);

    const org = await Organization.create({
      name, slug, description, region, state, contactEmail, phoneNumber,
      plan:                plan ?? 'basic',
      status:              'active',
      createdBy:           user.id,
      adminClaimed:        false,
      claimToken:          token,
      claimTokenExpiresAt: expiresAt,
    });

    res.status(201).json({
      ...org.toObject(),
      claimLink:  orgClaimLink(token),
      claimToken: token,      // included so frontend can build the link client-side too
    });
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

// ── Get current claim link for an organization (super_admin only) ─────────────

export async function getClaimLink(req: Request, res: Response, next: NextFunction) {
  try {
    const org = await Organization.findById(req.params.id).select('+claimToken +claimTokenExpiresAt').lean();
    if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found');

    if (org.adminClaimed) {
      return res.json({ adminClaimed: true, claimLink: null });
    }

    const link = org.claimToken ? orgClaimLink(org.claimToken) : null;
    res.json({
      adminClaimed:        false,
      claimLink:           link,
      claimTokenExpiresAt: org.claimTokenExpiresAt?.toISOString() ?? null,
    });
  } catch (err) { next(err); }
}

// ── Regenerate claim link (super_admin only) ──────────────────────────────────
// Use this if the link expired, was shared incorrectly, or to replace the org admin.

export async function regenerateClaimLink(req: Request, res: Response, next: NextFunction) {
  try {
    const orgId    = req.params.id;
    const token    = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + CLAIM_TTL_DAYS * 24 * 60 * 60 * 1000);

    const org = await Organization.findByIdAndUpdate(
      orgId,
      {
        claimToken:          token,
        claimTokenExpiresAt: expiresAt,
        adminClaimed:        false,   // allow re-claiming (e.g. replacing an admin)
      },
      { new: true },
    ).lean();

    if (!org) throw new AppError(404, 'NOT_FOUND', 'Organization not found');

    res.json({
      claimLink:           orgClaimLink(token),
      claimTokenExpiresAt: expiresAt.toISOString(),
    });
  } catch (err) { next(err); }
}
