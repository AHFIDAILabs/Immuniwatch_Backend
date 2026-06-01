import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { overrideSchema, rejectSchema } from '../schemas';
import { UserRole } from '../types';
import * as hitl from '../controllers/hitlController';

const router = Router();
router.use(authenticate);

// Approve / reject — every authenticated analyst (including org_admin)
const allAnalysts = authorize(
  UserRole.ANALYST,
  UserRole.SENIOR_ANALYST,
  UserRole.SUPERVISOR,
  UserRole.ORG_ADMIN,
  UserRole.SUPER_ADMIN,
);

// Override (relabel ML result) — senior_analyst and above + org_admin
// Analysts are limited to approve/reject only.
const canOverride = authorize(
  UserRole.SENIOR_ANALYST,
  UserRole.SUPERVISOR,
  UserRole.ORG_ADMIN,
  UserRole.SUPER_ADMIN,
);

const supervisors = authorize(UserRole.SUPERVISOR, UserRole.ORG_ADMIN, UserRole.SUPER_ADMIN);

router.get ('/my-stats',   hitl.getMyStats);
router.get ('/team-stats', supervisors, hitl.getTeamStats);
router.get ('/',           hitl.getQueue);
router.post('/queue',      hitl.queuePost);
router.post('/:id/approve',  allAnalysts, hitl.approve);
router.post('/:id/reject',   allAnalysts, validate(rejectSchema),   hitl.reject);
router.post('/:id/override', canOverride, validate(overrideSchema), hitl.override);

export default router;
