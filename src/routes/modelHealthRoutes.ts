import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { triggerRetrainSchema } from '../schemas';
import { UserRole } from '../types';
import * as mh from '../controllers/modelHealthController';

const router = Router();
router.use(authenticate);

const admins = authorize(UserRole.SUPERVISOR, UserRole.ORG_ADMIN, UserRole.SUPER_ADMIN);

router.get ('/',                admins, mh.getMetrics);
router.get ('/f1-trend',        admins, mh.getF1Trend);
router.get ('/retrain-status',  admins, mh.getRetrainStatus);
router.post('/retrain',         admins, validate(triggerRetrainSchema), mh.triggerRetrain);
router.get ('/recent-feedback', admins, mh.getRecentFeedback);

export default router;
