import { Router } from 'express';
import { authenticate } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { ingestPostSchema } from '../schemas';
import * as post from '../controllers/postController';

const router = Router();
router.use(authenticate);

router.get ('/',                    post.listPosts);
router.get ('/similar-count',       post.similarCount);
router.post('/', validate(ingestPostSchema), post.ingestPost);
router.patch('/:id/archive',        post.archivePost);

export default router;
