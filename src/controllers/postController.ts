import { NextFunction, Request, Response } from "express";
import mongoose from "mongoose";

import { AuditLog } from "../models/AuditLog";
import { Classification } from "../models/Classification";
import { HITLReview } from "../models/HITLReview";
import { Post } from "../models/Post";
import {
  PostPlatform,
  PostLanguage,
  AuthenticatedRequest,
  AuditAction,
} from "../types";
import { AppError } from "../utils/AppError";
import { globalOrOrgFilter } from "../middlewares/auth";
import { classifyPost } from "../services/classificationService";
import { publishRawPost } from "../utils/kafkaProducer";

// ── Ingest a single post ──────────────────────────────────────────────────────

export async function ingestPost(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const {
      content,
      platform,
      language,
      externalId,
      authorHandle,
      mediaUrls,
      labels,
    } = req.body as {
      content: string;
      platform: PostPlatform;
      language: PostLanguage;
      externalId?: string;
      authorHandle?: string;
      mediaUrls?: string[];
      labels?: string[];
    };

    if (!content || !platform || !language)
      throw new AppError(
        400,
        "MISSING_FIELDS",
        "content, platform, and language are required",
      );

    if (externalId) {
      const dup = await Post.findOne({ externalId, platform }).lean();
      if (dup)
        return res
          .status(200)
          .json({ message: "Duplicate — already ingested", post: dup });
    }

    const post = await Post.create({
      content,
      platform,
      language,
      externalId,
      authorHandle,
      mediaUrls: mediaUrls ?? [],
      labels: labels ?? [],
    });
    setImmediate(() => classifyPost(post._id.toString()).catch(() => {}));
    await publishRawPost(post);

    res
      .status(202)
      .json({ message: "Post accepted for classification", postId: post._id });
  } catch (err) {
    next(err);
  }
}

// ── Archive a post ────────────────────────────────────────────────────────────

export async function archivePost(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { user } = req as AuthenticatedRequest;
    const post = await Post.findOne({
      _id: req.params.id,
      ...globalOrOrgFilter(req),
    });
    if (!post) throw new AppError(404, "NOT_FOUND", "Post not found");
    if (post.archivedAt) return res.json({ message: "Already archived", post });

    post.archivedAt = new Date();
    post.archivedBy = new mongoose.Types.ObjectId(
      user.id,
    ) as unknown as typeof post.archivedBy;
    await post.save();

    await AuditLog.create({
      actor: user.id,
      action: AuditAction.HITL_APPROVE, // closest semantic — "confirmed factual, no action needed"
      resourceType: "Post",
      resourceId: post._id.toString(),
      newValue: { archivedAt: post.archivedAt },
    });

    res.json(post);
  } catch (err) {
    next(err);
  }
}

// ── Similar post count (for HITL context strip) ───────────────────────────────

export async function similarCount(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const { postId } = req.query as { postId?: string };
    if (!postId) throw new AppError(400, "postId is required");

    const cls = await Classification.findOne({ postId }).lean();
    if (!cls) return res.json({ count: 0, platforms: [] });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pipeline = [
      { $match: { createdAt: { $gte: since }, ...globalOrOrgFilter(req) } },
      {
        $lookup: {
          from: "classifications",
          localField: "_id",
          foreignField: "postId",
          as: "cls",
        },
      },
      { $unwind: "$cls" },
      { $match: { "cls.label": cls.label, _id: { $ne: cls.postId } } },
      { $group: { _id: "$platform", count: { $sum: 1 } } },
      { $sort: { count: -1 as -1 } },
    ];

    const rows = await Post.aggregate(pipeline);
    const count = rows.reduce(
      (s: number, r: { count: number }) => s + r.count,
      0,
    );

    res.json({
      label: cls.label,
      count,
      platforms: rows.map((r: { _id: string; count: number }) => ({
        platform: r._id,
        count: r.count,
      })),
    });
  } catch (err) {
    next(err);
  }
}

// ── List posts ────────────────────────────────────────────────────────────────
// Returns posts enriched with their latest Classification and HITLReview status
// so the frontend can show the correct action button (Queue / In Queue / Archived).

export async function listPosts(
  req: Request,
  res: Response,
  next: NextFunction,
) {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Number(req.query.limit) || 50);
    const platform = req.query.platform as PostPlatform | undefined;
    const language = req.query.language as PostLanguage | undefined;
    const search = req.query.search as string | undefined;
    const labeled = req.query.labeled as string | undefined; // 'true' | 'false'

    // ML-ingested posts (Bluesky/YouTube) have no organizationId — they are
    // platform-wide and all org users should see them alongside their own posts.
    const matchPost: Record<string, unknown> = { ...globalOrOrgFilter(req) };
    if (platform) matchPost.platform = platform;
    if (language) matchPost.language = language;
    if (search?.trim()) matchPost.$text = { $search: search.trim() };

    // If filtering by labeled/unlabeled, we need the set of classified post IDs first
    if (labeled === "true" || labeled === "false") {
      const classifiedIds = await Classification.distinct("postId");
      if (labeled === "true") {
        matchPost._id = { $in: classifiedIds };
      } else {
        matchPost._id = { $nin: classifiedIds };
      }
    }

    const [posts, total] = await Promise.all([
      Post.find(matchPost)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Post.countDocuments(matchPost),
    ]);

    const postIds = posts.map((p) => p._id);

    // Batch-load classifications and HITL reviews in parallel
    const [classifications, hitlReviews] = await Promise.all([
      Classification.find({ postId: { $in: postIds } })
        .select("postId label confidence fallback modelVersion")
        .lean(),
      HITLReview.find({ postId: { $in: postIds } })
        .select("postId status priority")
        .lean(),
    ]);

    const clsMap = new Map(
      classifications.map((c) => [c.postId.toString(), c]),
    );
    const hitlMap = new Map(hitlReviews.map((h) => [h.postId.toString(), h]));

    const enriched = posts.map((p) => ({
      ...p,
      classification: clsMap.get(p._id.toString()) ?? null,
      hitlReview: hitlMap.get(p._id.toString()) ?? null,
    }));

    res.json({
      data: enriched,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    next(err);
  }
}
