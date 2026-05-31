import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { overrideSchema, rejectSchema } from '../schemas';
import { UserRole } from '../types';
import * as hitl from '../controllers/hitlController';

const router = Router();
router.use(authenticate);

const reviewers   = authorize(UserRole.SENIOR_ANALYST, UserRole.SUPERVISOR, UserRole.SUPER_ADMIN);
const supervisors = authorize(UserRole.SUPERVISOR, UserRole.SUPER_ADMIN);

router.get ('/my-stats',   hitl.getMyStats);
router.get ('/team-stats', supervisors, hitl.getTeamStats);
router.get ('/',           hitl.getQueue);
router.post('/queue',      hitl.queuePost);
router.post('/:id/approve',  reviewers, hitl.approve);
router.post('/:id/override', reviewers, validate(overrideSchema), hitl.override);
router.post('/:id/reject',   reviewers, validate(rejectSchema),   hitl.reject);

export default router;
