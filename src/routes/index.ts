import { Router } from 'express';

import authRoutes        from './authRoutes';
import postRoutes        from './postRoutes';
import hitlRoutes        from './hitlRoutes';
import kbRoutes          from './kbRoutes';
import modelHealthRoutes from './modelHealthRoutes';
import pipelineRoutes    from './pipelineRoutes';
import userRoutes        from './userRoutes';
import auditRoutes       from './auditRoutes';
import alertRoutes       from './alertRoutes';
import trendsRoutes      from './trendsRoutes';
import dispatchRoutes    from './dispatchRoutes';
import statsRoutes       from './statsRoutes';
import submitRoutes      from './submitRoutes';
import settingsRoutes    from './settingsRoutes';

const router = Router();

router.use('/auth',         authRoutes);
router.use('/posts',        postRoutes);
router.use('/hitl',         hitlRoutes);
router.use('/kb',           kbRoutes);
router.use('/model-health', modelHealthRoutes);
router.use('/pipeline',     pipelineRoutes);
router.use('/users',        userRoutes);
router.use('/audit',        auditRoutes);
router.use('/alerts',       alertRoutes);
router.use('/trends',       trendsRoutes);
router.use('/dispatch',     dispatchRoutes);
router.use('/stats',        statsRoutes);
router.use('/submit',       submitRoutes);   // public — no authenticate middleware
router.use('/settings',     settingsRoutes);

export default router;
