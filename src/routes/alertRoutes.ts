import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import * as alert from '../controllers/alertController';

const router = Router();
router.use(authenticate);

router.get ('/',              alert.listAlerts);
router.patch('/:id/resolve',  alert.resolveAlert);

export default router;
