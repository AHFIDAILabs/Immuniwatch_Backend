import { NextFunction, Request, Response } from 'express';
import { Classification } from '../models/Classification';
import { Post } from '../models/Post';

export async function getClassificationBreakdown(req: Request, res: Response, next: NextFunction) {
  try {
    const days  = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const breakdown = await Classification.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$label', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $project: { _id: 0, label: '$_id', count: 1 } },
    ]);

    res.json(breakdown);
  } catch (err) { next(err); }
}

export async function getTopNarratives(req: Request, res: Response, next: NextFunction) {
  try {
    const days      = Math.min(90, Number(req.query.days) || 7);
    const since     = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const limit     = Math.min(20, Number(req.query.limit) || 10);
    const trendDays = 7;

    const dateKeys: string[] = [];
    for (let i = trendDays - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      dateKeys.push(d.toISOString().slice(0, 10));
    }

    const narratives = await Post.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $lookup: {
          from:         'classifications',
          localField:   '_id',
          foreignField: 'postId',
          as:           'classification',
        },
      },
      { $unwind: { path: '$classification', preserveNullAndEmptyArrays: false } },
      { $match: { 'classification.label': 'misinformation' } },
      {
        $group: {
          _id: {
            content: '$content',
            date:    { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          },
          count: { $sum: 1 },
          label: { $first: '$classification.label' },
        },
      },
      {
        $group: {
          _id:   '$_id.content',
          count: { $sum: '$count' },
          label: { $first: '$label' },
          days:  { $push: { date: '$_id.date', count: '$count' } },
        },
      },
      { $sort: { count: -1 } },
      { $limit: limit },
      { $project: { _id: 0, narrative: '$_id', count: 1, label: 1, days: 1 } },
    ]) as { narrative: string; count: number; label: string; days: { date: string; count: number }[] }[];

    const result = narratives.map((n) => ({
      narrative: n.narrative,
      count:     n.count,
      label:     n.label,
      trend:     dateKeys.map((k) => n.days.find((d) => d.date === k)?.count ?? 0),
    }));

    res.json(result);
  } catch (err) { next(err); }
}

export async function getDailyBreakdown(req: Request, res: Response, next: NextFunction) {
  try {
    const days  = Math.min(30, Number(req.query.days) || 7);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await Classification.aggregate([
      { $match: { createdAt: { $gte: since } } },
      {
        $group: {
          _id: {
            date:  { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
            label: '$label',
          },
          count: { $sum: 1 },
        },
      },
    ]) as { _id: { date: string; label: string }; count: number }[];

    const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const series: Record<string, unknown>[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const d   = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10);
      const entry: Record<string, unknown> = {
        date:          key,
        day:           DAY_NAMES[d.getUTCDay()],
        misinformation: 0,
        factual:        0,
        irrelevant:     0,
      };
      for (const r of rows) {
        if (r._id.date === key && r._id.label in entry) {
          entry[r._id.label] = r.count;
        }
      }
      series.push(entry);
    }

    res.json(series);
  } catch (err) { next(err); }
}

export async function getPlatformIngestion(req: Request, res: Response, next: NextFunction) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const stats = await Post.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$platform', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    res.json(stats);
  } catch (err) { next(err); }
}

export async function getDailyMisinformation(req: Request, res: Response, next: NextFunction) {
  try {
    const days  = Math.min(90, Number(req.query.days) || 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const rows = await Classification.aggregate([
      { $match: { createdAt: { $gte: since }, label: 'misinformation' } },
      {
        $group: {
          _id:   { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
      { $project: { _id: 0, date: '$_id', count: 1 } },
    ]);

    // Build a complete day-by-day series so the chart always has a full dataset
    const byDate = new Map<string, number>(rows.map((r: { date: string; count: number }) => [r.date, r.count]));
    const series: { date: string; count: number }[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD in UTC
      series.push({ date: key, count: byDate.get(key) ?? 0 });
    }

    res.json(series);
  } catch (err) { next(err); }
}

export async function getLanguageDistribution(req: Request, res: Response, next: NextFunction) {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const stats = await Post.aggregate([
      { $match: { createdAt: { $gte: since } } },
      { $group: { _id: '$language', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]);

    res.json(stats);
  } catch (err) { next(err); }
}
