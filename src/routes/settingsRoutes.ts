import { Router } from "express";
import { z } from "zod";
import { authenticate, authorize } from "../middlewares/auth";
import { validate } from "../middlewares/validate";
import { UserRole } from "../types";
import * as settings from "../controllers/settingsController";

const router = Router();
router.use(authenticate);

// All roles can read settings (needed by every page for alert thresholds)
router.get("/", settings.getSettings);

// org_admin, supervisor, and super_admin can change settings
const admins = authorize(UserRole.ORG_ADMIN, UserRole.SUPERVISOR, UserRole.SUPER_ADMIN);

const updateSettingsSchema = z.object({
  body: z
    .object({
      surgePosts: z.number().min(50).max(10000).optional(),
      hitlAutoEscalateAbove: z.number().min(50).max(100).optional(),
      psiDriftAlert: z.number().min(0.05).max(0.5).optional(),
      overrideRateAlert: z.number().min(5).max(60).optional(),
      macroF1Target: z.number().min(0).max(1).optional(),
      inferenceP95Ms: z.number().min(50).max(5000).optional(),
      feedbackQueueMax: z.number().min(100).max(100000).optional(),
      notifEmail: z.string().email().or(z.literal("")).optional(),
    })
    .strict(),
});

router.patch(
  "/",
  admins,
  validate(updateSettingsSchema),
  settings.updateSettings,
);

export default router;
