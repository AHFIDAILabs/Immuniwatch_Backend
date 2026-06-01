import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { inviteUserSchema, updateUserSchema, resetPasswordSchema } from '../schemas';
import { UserRole } from '../types';
import * as user from '../controllers/userController';

const router = Router();
router.use(authenticate);

const managers = authorize(UserRole.ORG_ADMIN, UserRole.SUPERVISOR, UserRole.SUPER_ADMIN);
const admins   = authorize(UserRole.ORG_ADMIN, UserRole.SUPER_ADMIN);

// ── Read — supervisor/org_admin/super_admin ───────────────────────────────────
router.get('/',                   managers, user.listUsers);
router.get('/:id',                managers, user.getUser);
router.get('/:id/feedback-stats', managers, user.getFeedbackStats);

// ── Write — org_admin/super_admin only ────────────────────────────────────────
router.post  ('/',                    admins, validate(inviteUserSchema),    user.inviteUser);
router.patch ('/:id',                 admins, validate(updateUserSchema),    user.updateUser);
router.patch ('/:id/reset-password',  admins, validate(resetPasswordSchema), user.resetPassword);
router.delete('/:id',                 admins,                                user.deleteUser);

export default router;
