import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { UserRole } from '../types';
import * as pipeline from '../controllers/pipelineController';

const router = Router();

router.get('/status',     authenticate, pipeline.getPipelineStatus);
router.get('/connectors', authenticate, pipeline.getConnectorStatus);
router.get('/kafka',      authenticate, pipeline.getKafkaHealth);
router.get('/recent',     authenticate, pipeline.getRecentFeed);
router.get('/ml-health',  authenticate, authorize(UserRole.SUPERVISOR, UserRole.SUPER_ADMIN), pipeline.getMlHealth);

export default router;
