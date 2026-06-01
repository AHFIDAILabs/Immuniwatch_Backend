import { Router } from 'express';
import { authenticate, authorize } from '../middlewares/auth';
import { UserRole } from '../types';
import * as org from '../controllers/organizationController';

const router = Router();
router.use(authenticate, authorize(UserRole.SUPER_ADMIN));

router.get ('/',                         org.listOrganizations);
router.get ('/platform-overview',        org.getPlatformOverview);
router.get ('/:id',                      org.getOrganization);
router.post('/',                         org.createOrganization);
router.patch('/:id',                     org.updateOrganization);
router.patch('/:id/status',              org.setOrgStatus);

// ── Org-admin claim link management ──────────────────────────────────────────
router.get ('/:id/claim-link',           org.getClaimLink);
router.post('/:id/claim-link/regenerate', org.regenerateClaimLink);

// NOTE: super_admin does NOT create org admin accounts directly.
// The claim link flow lets the org admin self-register.

export default router;
