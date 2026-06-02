import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { UserRole } from '../types';
import * as audit from '../controllers/auditController';

const router = Router();
router.get('/', authenticate, authorize(UserRole.SUPERVISOR, UserRole.ORG_ADMIN, UserRole.SUPER_ADMIN), audit.listLogs);

export default router;
