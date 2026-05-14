import { Request, Response, NextFunction } from 'express';
import { Post } from '../models/Post';
import { HITLReview } from '../models/HITLReview';

export async function getLiveStats(_req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const [postsLastHour, pendingHITL] = await Promise.all([
      Post.countDocuments({ ingestedAt: { $gte: oneHourAgo } }),
      HITLReview.countDocuments({ status: 'pending' }),
    ]);

    res.json({ postsLastHour, pendingHITL });
  } catch (err) {
    next(err);
  }
}
