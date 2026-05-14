import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { inviteUserSchema, updateUserSchema } from '../schemas';
import { UserRole } from '../types';
import * as user from '../controllers/userController';

const router = Router();
router.use(authenticate, authorize(UserRole.SUPERVISOR, UserRole.SUPER_ADMIN));

router.get ('/',                     user.listUsers);
router.get ('/:id',                  user.getUser);
router.post('/',                     validate(inviteUserSchema),  user.inviteUser);
router.patch('/:id',                 validate(updateUserSchema),  user.updateUser);
router.get ('/:id/feedback-stats',   user.getFeedbackStats);

export default router;
