import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import * as trends from '../controllers/trendsController';

const router = Router();
router.use(authenticate);

router.get('/classification-breakdown', trends.getClassificationBreakdown);
router.get('/top-narratives',           trends.getTopNarratives);
router.get('/daily-misinformation',     trends.getDailyMisinformation);
router.get('/daily-breakdown',          trends.getDailyBreakdown);
router.get('/platform-ingestion',       trends.getPlatformIngestion);
router.get('/language-distribution',    trends.getLanguageDistribution);

export default router;
