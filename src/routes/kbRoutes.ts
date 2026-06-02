import express, { Router } from 'express';
import multer from 'multer';
import { authenticate, authorize } from '../middlewares/auth';
import { validate } from '../middlewares/validate';
import { uploadKbSchema } from '../schemas';
import { UserRole } from '../types';
import * as kb from '../controllers/kbController';

const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (_req: express.Request, file: Express.Multer.File, cb: multer.FileFilterCallback) => {
    const allowed = ['application/pdf', 'text/plain', 'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'];
    cb(null, allowed.includes(file.mimetype));
  },
});

const router = Router();
router.use(authenticate);

router.get ('/',         kb.listDocuments);
router.post('/',         authorize(UserRole.SENIOR_ANALYST, UserRole.SUPERVISOR, UserRole.ORG_ADMIN, UserRole.SUPER_ADMIN), upload.single('file'), validate(uploadKbSchema), kb.uploadDocument);
router.delete('/:id',    authorize(UserRole.SUPERVISOR, UserRole.ORG_ADMIN, UserRole.SUPER_ADMIN), kb.deleteDocument);
router.post('/reindex',  authorize(UserRole.SUPER_ADMIN), kb.reindexAll);

export default router;
