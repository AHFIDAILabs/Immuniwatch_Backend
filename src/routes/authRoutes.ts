import { Router } from 'express';
import { login, refresh, logout, me } from '../controllers/authController';
import { authenticate } from '../middlewares/auth';
import { authLimiter } from '../middlewares/rateLimiter';
import { validate } from '../middlewares/validate';
import { loginSchema } from '../schemas';

const router = Router();

router.post('/login',   authLimiter, validate(loginSchema), login);
router.post('/refresh', refresh);   // token read from HttpOnly cookie
router.post('/logout',  authenticate, logout);
router.get ('/me',      authenticate, me);

export default router;
