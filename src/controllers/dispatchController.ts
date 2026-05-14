import { Request, Response, NextFunction } from 'express';

export async function getDispatchStats(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      dispatchedToday: 1088,
      avgResponseTimeMin: 4.2,
      platformAcceptanceRate: 0.964,
      byPlatform: [
        { platform: 'twitter',    label: 'Twitter/X',   count: 565, pct: 52 },
        { platform: 'facebook',   label: 'Facebook',    count: 337, pct: 31 },
        { platform: 'youtube',    label: 'YouTube',     count: 130, pct: 12 },
        { platform: 'submission', label: 'Submissions', count:  56, pct:  5 },
      ],
    });
  } catch (err) { next(err); }
}

export async function listDispatches(_req: Request, res: Response, next: NextFunction) {
  try {
    res.json({
      data: [
        { _id: '1', platform: 'twitter',    excerpt: 'Anti-Jigi ta claim…',   language: 'ha',  status: 'sent',     minutesAgo:   2 },
        { _id: '2', platform: 'facebook',   excerpt: 'OPV-polio cluster…',    language: 'pcm', status: 'sent',     minutesAgo:  19 },
        { _id: '3', platform: 'twitter',    excerpt: 'HPV harm claim…',        language: 'en',  status: 'pending',  minutesAgo:  38 },
        { _id: '4', platform: 'youtube',    excerpt: '5G chip disinfo…',       language: 'en',  status: 'sent',     minutesAgo:  60 },
        { _id: '5', platform: 'twitter',    excerpt: 'Infertility claim…',     language: 'ha',  status: 'retrying', minutesAgo: 120 },
      ],
      total: 1088,
    });
  } catch (err) { next(err); }
}
