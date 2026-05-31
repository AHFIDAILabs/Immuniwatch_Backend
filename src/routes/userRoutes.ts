import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { inviteUserSchema, updateUserSchema, resetPasswordSchema } from '../schemas';
import { UserRole } from '../types';
import * as user from '../controllers/userController';

const router = Router();
router.use(authenticate);

// ── Read — supervisor + super_admin ──────────────────────────────────────────
router.get('/',                   authorize(UserRole.SUPERVISOR, UserRole.SUPER_ADMIN), user.listUsers);
router.get('/:id',                authorize(UserRole.SUPERVISOR, UserRole.SUPER_ADMIN), user.getUser);
router.get('/:id/feedback-stats', authorize(UserRole.SUPERVISOR, UserRole.SUPER_ADMIN), user.getFeedbackStats);

// ── Write — super_admin only ─────────────────────────────────────────────────
router.post  ('/',                         authorize(UserRole.SUPER_ADMIN), validate(inviteUserSchema),    user.inviteUser);
router.patch ('/:id',                      authorize(UserRole.SUPER_ADMIN), validate(updateUserSchema),    user.updateUser);
router.patch ('/:id/reset-password',       authorize(UserRole.SUPER_ADMIN), validate(resetPasswordSchema), user.resetPassword);
router.delete('/:id',                      authorize(UserRole.SUPER_ADMIN),                                user.deleteUser);

export default router;
