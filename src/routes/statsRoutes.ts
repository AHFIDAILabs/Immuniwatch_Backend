import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { getLiveStats } from '../controllers/statsController';

const router = Router();

router.get('/live', authenticate, getLiveStats);

export default router;
