import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { UserRole } from '../types';
import * as dispatch from '../controllers/dispatchController';

const router = Router();
router.use(authenticate);

// Dispatch stats + list — supervisor and above
router.get('/',      dispatch.listDispatches);
router.get('/stats', dispatch.getDispatchStats);

// Counter-narrative — all analysts can fetch and deploy
const allAnalysts = authorize(
  UserRole.ANALYST,
  UserRole.SENIOR_ANALYST,
  UserRole.SUPERVISOR,
  UserRole.SUPER_ADMIN,
);
router.get ('/counter-narrative',            allAnalysts, dispatch.getCounterNarrative);
router.post('/counter-narrative/:postId/deploy', allAnalysts, dispatch.deployCounterNarrative);
router.post('/counter-narrative/:postId/skip',   allAnalysts, dispatch.skipCounterNarrative);

export default router;
