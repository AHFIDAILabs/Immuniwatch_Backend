import { Router } from 'express';
import { login, refresh, logout, me, getInvite, acceptInvite, getOrgClaim, acceptOrgClaim } from '../controllers/authController';
import { authenticate } from '../middlewares/auth';
import { authLimiter } from '../middlewares/rateLimiter';
import { validate } from '../middlewares/validate';
import { loginSchema } from '../schemas';

const router = Router();

router.post('/login',          authLimiter, validate(loginSchema), login);
router.post('/refresh',        refresh);
router.post('/logout',         authenticate, logout);
router.get ('/me',             authenticate, me);

// ── User invite flow (public) ─────────────────────────────────────────────────
router.get ('/invite/:token',   getInvite);
router.post('/accept-invite',   acceptInvite);

// ── Org-admin self-registration / claim flow (public) ─────────────────────────
router.get ('/claim-org/:token', getOrgClaim);
router.post('/claim-org',        acceptOrgClaim);

export default router;
