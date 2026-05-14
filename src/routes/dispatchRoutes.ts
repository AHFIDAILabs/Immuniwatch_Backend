import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import * as dispatch from '../controllers/dispatchController';

const router = Router();
router.use(authenticate);

router.get('/',       dispatch.listDispatches);
router.get('/stats',  dispatch.getDispatchStats);

export default router;
