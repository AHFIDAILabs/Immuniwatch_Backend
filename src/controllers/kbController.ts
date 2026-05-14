import { NextFunction, Response, Request } from 'express';
import { AuthenticatedRequest, UserRole } from '../types';
import { KnowledgeBase } from '../models/KnowledgeBase';
import * as kbService from '../services/kbService';
import { AppError } from '../utils/AppError';
import { PostLanguage } from '../types';

export async function listDocuments(req: Request, res: Response, next: NextFunction) {
  try {
    const page   = Math.max(1, Number(req.query.page) || 1);
    const limit  = Math.min(100, Number(req.query.limit) || 20);
    const search = (req.query.search as string) ?? '';
    const source = req.query.source as string | undefined;

    const filter: Record<string, unknown> = {};
    if (search) filter.$text = { $search: search };
    if (source) filter.source = source;

    const [docs, total] = await Promise.all([
      KnowledgeBase.find(filter)
        .select('-embeddingVector -content')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      KnowledgeBase.countDocuments(filter),
    ]);

    res.json({ data: docs, total, page, limit, totalPages: Math.ceil(total / limit) });
  } catch (err) { next(err); }
}

export async function uploadDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    if (!req.file) throw new AppError(400, 'NO_FILE', 'No file uploaded');

    const { title, source, language, immediate } = req.body as {
      title:     string;
      source:    string;
      language:  PostLanguage;
      immediate?: string;
    };

    if (!title || !source || !language)
      throw new AppError(400, 'MISSING_FIELDS', 'title, source, and language are required');

    const doc = await kbService.uploadDocument(req.file.buffer, req.file.mimetype, {
      title,
      source,
      language,
      uploadedBy: user.id,
      immediate:  immediate === 'true',
    });

    res.status(201).json(doc);
  } catch (err) { next(err); }
}

export async function deleteDocument(req: Request, res: Response, next: NextFunction) {
  try {
    const { user } = req as AuthenticatedRequest;
    await kbService.deleteDocument(req.params.id, user.id);
    res.status(204).send();
  } catch (err) { next(err); }
}

export async function reindexAll(req: Request, res: Response, next: NextFunction) {
  try {
    const result = await kbService.reindexAll();
    res.json(result);
  } catch (err) { next(err); }
}
