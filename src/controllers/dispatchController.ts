import { Request, Response, NextFunction } from 'express';
import { HITLReview } from '../models/HITLReview';
import { HITLStatus, AuthenticatedRequest } from '../types';
import * as mlClient from '../services/mlClient';
import { logger } from '../utils/logger';

export async function getDispatchStats(_req: Request, res: Response, next: NextFunction) {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todayReviews, allStatusCounts, platformStats] = await Promise.all([
      HITLReview.find({
        reviewedAt: { $gte: todayStart },
        status: { $in: [HITLStatus.APPROVED, HITLStatus.OVERRIDDEN] },
      }).select('reviewedAt createdAt').lean(),

      HITLReview.aggregate([
        { $match: { status: { $in: [HITLStatus.APPROVED, HITLStatus.OVERRIDDEN, HITLStatus.REJECTED] } } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),

      HITLReview.aggregate([
        { $match: { reviewedAt: { $gte: todayStart }, status: { $in: [HITLStatus.APPROVED, HITLStatus.OVERRIDDEN] } } },
        { $lookup: { from: 'posts', localField: 'postId', foreignField: '_id', as: 'post' } },
        { $unwind: { path: '$post', preserveNullAndEmptyArrays: false } },
        { $group: { _id: '$post.platform', count: { $sum: 1 } } },
        { $sort: { count: -1 as -1 } },
      ]),
    ]);

    const approvedCount   = (allStatusCounts.find((r: { _id: string }) => r._id === HITLStatus.APPROVED)   as { count: number } | undefined)?.count ?? 0;
    const overriddenCount = (allStatusCounts.find((r: { _id: string }) => r._id === HITLStatus.OVERRIDDEN) as { count: number } | undefined)?.count ?? 0;
    const rejectedCount   = (allStatusCounts.find((r: { _id: string }) => r._id === HITLStatus.REJECTED)   as { count: number } | undefined)?.count ?? 0;
    const totalActioned   = approvedCount + overriddenCount + rejectedCount;

    const avgMs = todayReviews.length > 0
      ? todayReviews.reduce((sum, r) => {
          const doc = r as unknown as { createdAt: Date; reviewedAt: Date };
          return sum + (doc.reviewedAt.getTime() - doc.createdAt.getTime());
        }, 0) / todayReviews.length
      : 0;

    res.json({
      dispatchedToday:        todayReviews.length,
      avgResponseTimeMin:     Math.round(avgMs / 60_000 * 10) / 10,
      platformAcceptanceRate: totalActioned > 0
        ? Math.round((approvedCount + overriddenCount) / totalActioned * 1000) / 1000
        : 0,
      byPlatform: (platformStats as { _id: string; count: number }[]).map((p) => ({
        platform:       p._id,
        count:          p.count,
        acceptanceRate: totalActioned > 0 ? Math.round((approvedCount + overriddenCount) / totalActioned * 1000) / 1000 : 0,
      })),
    });
  } catch (err) { next(err); }
}

export async function listDispatches(req: Request, res: Response, next: NextFunction) {
  try {
    const page  = Math.max(1, Number(req.query.page)  || 1);
    const limit = Math.min(100, Number(req.query.limit) || 20);

    const [reviews, total] = await Promise.all([
      HITLReview.find({ status: { $in: [HITLStatus.APPROVED, HITLStatus.OVERRIDDEN] } })
        .sort({ reviewedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate<{ postId: { platform: string; language: string; content: string } }>('postId', 'platform language content')
        .lean(),
      HITLReview.countDocuments({ status: { $in: [HITLStatus.APPROVED, HITLStatus.OVERRIDDEN] } }),
    ]);

    const data = reviews.map((r) => {
      const post = r.postId as unknown as { platform: string; language: string; content: string } | null;
      const reviewed = (r as unknown as { reviewedAt?: Date; createdAt: Date });
      return {
        _id:          r._id.toString(),
        postId:       r.postId?.toString() ?? '',
        platform:     post?.platform ?? 'unknown',
        language:     post?.language ?? 'en',
        response:     r.approvedResponse ?? r.notes ?? '',
        status:       'sent' as const,
        dispatchedAt: (reviewed.reviewedAt ?? reviewed.createdAt).toISOString(),
      };
    });

    res.json({ data, total });
  } catch (err) { next(err); }
}

// ── Counter-narrative ─────────────────────────────────────────────────────────

/**
 * GET /dispatch/counter-narrative?postId=<id>
 * Returns the ML-generated counter-narrative for a specific post, or null
 * when the ML endpoint is not yet live or no counter-narrative was generated.
 */
export async function getCounterNarrative(req: Request, res: Response, next: NextFunction) {
  try {
    const { postId } = req.query as { postId?: string };

    const pending = await mlClient.getCounterNarrativePending();
    const item    = postId
      ? pending.find((p) => p.post_id === postId) ?? null
      : null;

    res.json({
      available:        item !== null,
      postId:           postId ?? null,
      counterNarrative: item?.counter_narrative ?? null,
      platform:         item?.platform ?? null,
    });
  } catch (err) { next(err); }
}

/**
 * POST /dispatch/counter-narrative/:postId/deploy
 * Body: { approvedText: string }
 * Deploys the approved counter-narrative via the ML service, which posts it to
 * the original platform tagging the original author.
 */
export async function deployCounterNarrative(req: Request, res: Response, next: NextFunction) {
  try {
    const { postId } = req.params;
    const { approvedText } = req.body as { approvedText: string };

    if (!approvedText?.trim()) {
      return res.status(400).json({ code: 'MISSING_TEXT', message: 'approvedText is required' });
    }

    // Update the HITL review with the final approved response text
    await HITLReview.findOneAndUpdate(
      { postId },
      { $set: { approvedResponse: approvedText.trim() } },
    );

    // Deploy to platform via ML service (gracefully no-ops if endpoint not yet live)
    await mlClient.deployCounterNarrative(postId, approvedText.trim());

    logger.info(`[counter-narrative] deployed post=${postId}`);
    res.json({ success: true, postId, message: 'Counter-narrative deployed successfully' });
  } catch (err) { next(err); }
}

/**
 * POST /dispatch/counter-narrative/:postId/skip
 * Moderator chose not to reply — signals the ML service to skip this post's
 * counter-narrative.
 */
export async function skipCounterNarrative(req: Request, res: Response, next: NextFunction) {
  try {
    const { postId } = req.params;

    await mlClient.skipCounterNarrative(postId);

    logger.info(`[counter-narrative] skipped post=${postId}`);
    res.json({ success: true, postId, message: 'Counter-narrative skipped' });
  } catch (err) { next(err); }
}
