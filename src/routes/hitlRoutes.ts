import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { overrideSchema, rejectSchema } from '../schemas';
import { UserRole } from '../types';
import * as hitl from '../controllers/hitlController';

const router = Router();
router.use(authenticate);

// All authenticated analysts can approve / reject.
// Override (relabelling the ML result) is restricted to senior_analyst and above.
const allAnalysts = authorize(UserRole.ANALYST, UserRole.SENIOR_ANALYST, UserRole.SUPERVISOR, UserRole.SUPER_ADMIN);
const senior      = authorize(UserRole.SENIOR_ANALYST, UserRole.SUPERVISOR, UserRole.SUPER_ADMIN);
const supervisors = authorize(UserRole.SUPERVISOR, UserRole.SUPER_ADMIN);

router.get ('/my-stats',   hitl.getMyStats);
router.get ('/team-stats', supervisors, hitl.getTeamStats);
router.get ('/',           hitl.getQueue);
router.post('/queue',      hitl.queuePost);
router.post('/:id/approve',  allAnalysts, hitl.approve);
router.post('/:id/reject',   allAnalysts, validate(rejectSchema),   hitl.reject);
router.post('/:id/override', senior,      validate(overrideSchema), hitl.override);

export default router;
