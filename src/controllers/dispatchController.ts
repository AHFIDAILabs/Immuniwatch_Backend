import { Request, Response, NextFunction } from 'express';
import { Classification } from '../models/Classification';
import { HITLReview }     from '../models/HITLReview';
import { Post }           from '../models/Post';
import { HITLStatus, AuthenticatedRequest } from '../types';
import * as mlClient    from '../services/mlClient';
import { generateCounterNarrative } from '../services/groqService';
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
 * GET /dispatch/counter-narrative?postId=<mongoId>
 *
 * Flow:
 *   1. Load the Post from DB to get externalId (ML service post_id), content, platform, language
 *   2. Try GET /counter-narrative/{externalId} — returns if already generated
 *   3. If not found, call POST /counter-narrative/generate with the post content
 *   4. Return all three versions (short ≤280 chars, medium ≤200 words, long ≤500 words)
 *
 * Gracefully returns { available: false } if the ML endpoints are not yet live.
 */
export async function getCounterNarrative(req: Request, res: Response, next: NextFunction) {
  try {
    const { postId } = req.query as { postId?: string };
    if (!postId) return res.json({ available: false, postId: null });

    const { user } = req as AuthenticatedRequest;

    // Load the post and its classification so we have content + kbEvidence for RAG
    const [post, cls] = await Promise.all([
      Post.findById(postId).select('externalId content platform language organizationId').lean(),
      Classification.findOne({ postId }).select('label confidence kbEvidence').lean(),
    ]);

    if (!post) return res.json({ available: false, postId });

    const mlPostId = post.externalId ?? postId;

    // ── Step 1: Try ML service (GET then POST/generate) ──────────────────────
    let mlGenerated = await mlClient.getCounterNarrativeById(mlPostId);

    if (!mlGenerated) {
      mlGenerated = await mlClient.generateCounterNarrative({
        post_id:  mlPostId,
        content:  post.content,
        platform: post.platform,
        language: post.language ?? null,
      });
    }

    if (mlGenerated) {
      return res.json({
        available:        true,
        source:           'ml',
        postId,
        short:            mlGenerated.generated_short,
        medium:           mlGenerated.generated_medium,
        long:             mlGenerated.generated_long,
        sources:          mlGenerated.sources ?? [],
        counterNarrative: mlGenerated.generated_short,
        platform:         post.platform,
      });
    }

    // ── Step 2: Fall back to Groq RAG ────────────────────────────────────────
    const kbEvidence = (cls?.kbEvidence as Array<{ title: string; snippet: string }> | undefined) ?? [];

    const groqResult = await generateCounterNarrative(
      post.content,
      cls?.label ?? 'misinformation',
      post.language ?? 'en',
      kbEvidence,
      user.organizationId,
    );

    if (groqResult) {
      return res.json({
        available:        true,
        source:           'groq',
        postId,
        short:            groqResult.short,
        medium:           groqResult.medium,
        long:             groqResult.long,
        sources:          [],
        counterNarrative: groqResult.short,
        platform:         post.platform,
      });
    }

    // ── Step 3: Nothing available ─────────────────────────────────────────────
    res.json({ available: false, postId });
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
