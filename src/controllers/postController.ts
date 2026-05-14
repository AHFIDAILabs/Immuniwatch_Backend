import { NextFunction, Request, Response } from 'express';

import { Classification } from '../models/Classification';
import { Post } from '../models/Post';
import { PostPlatform, PostLanguage } from '../types';
import { AppError } from '../utils/AppError';
import { classifyPost } from '../services/classificationService';
import { publishRawPost } from '../utils/kafkaProducer';

// ── Ingest a single post ──────────────────────────────────────────────────────

export async function ingestPost(req: Request, res: Response, next: NextFunction) {
  try {
    const { content, platform, language, externalId, authorHandle, mediaUrls } = req.body as {
      content:       string;
      platform:      PostPlatform;
      language:      PostLanguage;
      externalId?:   string;
      authorHandle?: string;
      mediaUrls?:    string[];
    };

    if (!content || !platform || !language)
      throw new AppError(400, 'MISSING_FIELDS', 'content, platform, and language are required');

    // Prevent duplicate ingestion by externalId
    if (externalId) {
      const dup = await Post.findOne({ externalId, platform }).lean();
      if (dup) return res.status(200).json({ message: 'Duplicate — already ingested', post: dup });
    }

    const post = await Post.create({
      content,
      platform,
      language,
      externalId,
      authorHandle,
      mediaUrls: mediaUrls ?? [],
    });

    // Classify asynchronously — don't block the response
    setImmediate(() => classifyPost(post._id.toString()).catch(() => {}));
    await publishRawPost(post);

    res.status(202).json({ message: 'Post accepted for classification', postId: post._id });
  } catch (err) { next(err); }
}

// ── Similar post count (for HITL context strip) ───────────────────────────────

export async function similarCount(req: Request, res: Response, next: NextFunction) {
  try {
    const { postId } = req.query as { postId?: string };
    if (!postId) throw new AppError(400, 'postId is required');

    const cls = await Classification.findOne({ postId }).lean();
    if (!cls) return res.json({ count: 0, platforms: [] });

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const pipeline = [
      { $match: { createdAt: { $gte: since } } },
      { $lookup: { from: 'classifications', localField: '_id', foreignField: 'postId', as: 'cls' } },
      { $unwind: '$cls' },
      { $match: { 'cls.label': cls.label, _id: { $ne: cls.postId } } },
      { $group: { _id: '$platform', count: { $sum: 1 } } },
      { $sort: { count: -1 as -1 } },
    ];

    const rows = await Post.aggregate(pipeline);
    const count = rows.reduce((s: number, r: { count: number }) => s + r.count, 0);

    res.json({ label: cls.label, count, platforms: rows.map((r: { _id: string; count: number }) => ({ platform: r._id, count: r.count })) });
  } catch (err) {
    next(err);
  }
}

// ── List posts ────────────────────────────────────────────────────────────────

export async function listPosts(req: Request, res: Response, next: NextFunction) {
  try {
    const page     = Math.max(1, Number(req.query.page) || 1);
    const limit    = Math.min(200, Number(req.query.limit) || 50);
    const platform = req.query.platform as PostPlatform | undefined;
    const language = req.query.language as PostLanguage | undefined;
    const label    = req.query.label as string | undefined;

    const matchPost: Record<string, unknown> = {};
    if (platform) matchPost.platform = platform;
    if (language) matchPost.language = language;

    const matchCls: Record<string, unknown> = {};
    if (label) matchCls['classification.label'] = label;

    const [posts, total] = await Promise.all([
      Post.find(matchPost)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      Post.countDocuments(matchPost),
    ]);

    // Attach classifications in one batch query
    const postIds = posts.map((p) => p._id);
    const classifications = await Classification.find({ postId: { $in: postIds } })
      .select('postId label confidence fallback')
      .lean();

    const clsMap = new Map(classifications.map((c) => [c.postId.toString(), c]));
    const enriched = posts.map((p) => ({
      ...p,
      classification: clsMap.get(p._id.toString()) ?? null,
    }));

    res.json({ data: enriched, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
}
