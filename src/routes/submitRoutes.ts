import { Router, Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { Post } from '../models/Post';
import { AppError } from '../utils/AppError';
import { classifyPost } from '../services/classificationService';
import { publishRawPost } from '../utils/kafkaProducer';

const PostLanguage = z.enum(['en', 'pcm', 'ha', 'yo', 'ig']);
const PostPlatform = z.enum(['twitter', 'facebook', 'youtube', 'submission']);

const submitSchema = z.object({
  content:      z.string().min(10, 'Please provide at least 10 characters').max(5_000),
  platformSeen: PostPlatform.default('submission'),
  language:     PostLanguage.default('en'),
  sourceUrl:    z.string().url('Must be a valid URL').optional().or(z.literal('')),
  submitterNote: z.string().max(500).optional(),
});

// Stricter limiter for public endpoint — 5 submissions per 10 minutes per IP
const submitLimiter = rateLimit({
  windowMs:        10 * 60 * 1000,
  max:             5,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many submissions. Please wait 10 minutes before submitting again.' },
});

const router = Router();

router.post('/', submitLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = submitSchema.safeParse(req.body);
    if (!result.success) {
      const msg = result.error.errors.map((e) => e.message).join('; ');
      throw new AppError(400, msg);
    }

    const { content, platformSeen, language, sourceUrl, submitterNote } = result.data;

    const post = await Post.create({
      content,
      platform:     platformSeen,
      language,
      authorHandle: sourceUrl || undefined,
      mediaUrls:    [],
      ingestedAt:   new Date(),
      meta: { submitterNote: submitterNote ?? null, publicSubmission: true },
    });

    setImmediate(() => classifyPost(post._id.toString()).catch(() => {}));
    await publishRawPost(post);

    res.status(202).json({ message: 'Thank you — your submission has been received and will be reviewed.' });
  } catch (err) {
    next(err);
  }
});

export default router;
