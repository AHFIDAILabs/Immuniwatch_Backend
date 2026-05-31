import { NextFunction, Request, Response } from 'express';
import mongoose from 'mongoose';

import { HITLPriority, HITLStatus, AuthenticatedRequest, ClassificationLabel } from '../types';
import { HITLReview } from '../models/HITLReview';
import { User }       from '../models/User';
import * as hitlService from '../services/hitlService';
import { AppError } from '../utils/AppError';

// ── Personal stats (any authenticated user) ───────────────────────────────────

export async function getMyStats(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    const userId   = new mongoose.Types.ObjectId(user.id);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [reviewedToday, weekReviews, pendingTotal] = await Promise.all([
      HITLReview.countDocuments({ reviewedBy: userId, reviewedAt: { $gte: todayStart } }),
      HITLReview.find({
        reviewedBy: userId,
        reviewedAt: { $gte: sevenDaysAgo },
        status:     { $in: [HITLStatus.APPROVED, HITLStatus.REJECTED, HITLStatus.OVERRIDDEN] },
      }).select('status').lean(),
      HITLReview.countDocuments({ status: HITLStatus.PENDING }),
    ]);

    const overrideCount = weekReviews.filter((r) => r.status === HITLStatus.OVERRIDDEN).length;
    const overrideRate  = weekReviews.length > 0
      ? Math.round((overrideCount / weekReviews.length) * 100)
      : 0;

    res.json({ reviewedToday, reviewedThisWeek: weekReviews.length, overrideRate, pendingTotal });
  } catch (err) { next(err); }
}

// ── Team stats (supervisor / super_admin only) ────────────────────────────────

export async function getTeamStats(req: Request, res: Response, next: NextFunction) {
  try {
    const todayStart   = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [reviewedToday, weekReviews, pendingByPriority, topReviewersRaw] = await Promise.all([
      HITLReview.countDocuments({ reviewedAt: { $gte: todayStart }, status: { $ne: HITLStatus.PENDING } }),

      HITLReview.find({
        reviewedAt: { $gte: sevenDaysAgo },
        status:     { $in: [HITLStatus.APPROVED, HITLStatus.REJECTED, HITLStatus.OVERRIDDEN] },
      }).select('status').lean(),

      HITLReview.aggregate([
        { $match: { status: HITLStatus.PENDING } },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]),

      HITLReview.aggregate([
        { $match: { reviewedAt: { $gte: todayStart }, status: { $ne: HITLStatus.PENDING } } },
        { $group: { _id: '$reviewedBy', count: { $sum: 1 } } },
        { $sort: { count: -1 as -1 } },
        { $limit: 5 },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'userDoc' } },
        { $unwind: { path: '$userDoc', preserveNullAndEmptyArrays: true } },
        { $project: { name: { $ifNull: ['$userDoc.name', 'Unknown'] }, count: 1 } },
      ]),
    ]);

    const overrideCount = weekReviews.filter((r) => r.status === HITLStatus.OVERRIDDEN).length;
    const overrideRate  = weekReviews.length > 0
      ? Math.round((overrideCount / weekReviews.length) * 100)
      : 0;

    const pendingHigh     = (pendingByPriority.find((p: { _id: string }) => p._id === 'high') as { count: number } | undefined)?.count ?? 0;
    const pendingStandard = (pendingByPriority.find((p: { _id: string }) => p._id === 'standard') as { count: number } | undefined)?.count ?? 0;

    res.json({
      reviewedToday,
      reviewedThisWeek: weekReviews.length,
      overrideRate,
      pendingHigh,
      pendingStandard,
      topReviewers: topReviewersRaw.map((r: { name: string; count: number }) => ({ name: r.name, count: r.count })),
    });
  } catch (err) { next(err); }
}

// ── Queue listing ─────────────────────────────────────────────────────────────

export async function getQueue(req: Request, res: Response, next: NextFunction) {
  try {
    const page     = Math.max(1, Number(req.query.page)  || 1);
    const limit    = Math.min(100, Number(req.query.limit) || 20);
    const priority = req.query.priority as HITLPriority | undefined;
    const status   = (req.query.status as HITLStatus | undefined) ?? HITLStatus.PENDING;

    const result = await hitlService.listReviews({ priority, status, page, limit });
    res.json(result);
  } catch (err) { next(err); }
}

export async function approve(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    const { reviewerNote } = req.body as { reviewerNote?: string };
    const review = await hitlService.approveReview(req.params.id, user.id, user.role, reviewerNote);
    res.json(review);
  } catch (err) { next(err); }
}

export async function override(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    const { overrideLabel, newLabel, editedResponse, reviewerNote } = req.body as {
      overrideLabel?: ClassificationLabel;
      newLabel?:       ClassificationLabel;
      editedResponse?: string;
      reviewerNote?:   string;
    };
    // Accept either field name — overrideLabel is what the frontend sends
    const label = (overrideLabel ?? newLabel) as ClassificationLabel;
    const review = await hitlService.overrideReview(
      req.params.id, user.id, user.role, label, editedResponse ?? '', reviewerNote,
    );
    res.json(review);
  } catch (err) { next(err); }
}

export async function reject(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    const { reviewerNote } = req.body as { reviewerNote?: string };
    const review = await hitlService.rejectReview(req.params.id, user.id, user.role, reviewerNote);
    res.json(review);
  } catch (err) { next(err); }
}

export async function queuePost(req: Request, res: Response, next: NextFunction) {
  try {
    const { postId } = req.body as { postId: string };
    if (!postId) throw new AppError(400, 'postId is required');

    const { classifyPost } = await import('../services/classificationService');
    const { classification, hitlReview } = await classifyPost(postId);

    if (hitlReview) {
      res.status(201).json(hitlReview);
    } else {
      // Already classified and below threshold — create a manual HITL review
      const existing = await HITLReview.findOne({ postId });
      if (existing) {
        res.json(existing);
        return;
      }
      const review = await HITLReview.create({
        postId,
        classificationId: classification._id,
        priority:         HITLPriority.STANDARD,
        status:           HITLStatus.PENDING,
        notes:            'Manually queued for review',
      });
      res.status(201).json(review);
    }
  } catch (err) { next(err); }
}
