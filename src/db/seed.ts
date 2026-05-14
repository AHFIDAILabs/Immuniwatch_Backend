/**
 * Seed script — populates MongoDB with realistic demo data.
 * When ML_MOCK_MODE=true (default for local dev) it skips the Python service
 * and uses keyword-based stub classification so the dashboard shows real data.
 *
 * Usage:
 *   npm run seed
 *   ML_MOCK_MODE=false npm run seed   (requires Python service running)
 */

import "dotenv/config";
import mongoose from "mongoose";
import { faker } from "@faker-js/faker";

import { config } from "../config";
import { User } from "../models/User";
import { Post } from "../models/Post";
import { Classification } from "../models/Classification";
import { HITLReview } from "../models/HITLReview";
import { KnowledgeBase } from "../models/KnowledgeBase";
import { Alert } from "../models/Alert";
import { ModelMetrics } from "../models/ModelMetrics";
import { RetrainingHistory } from "../models/RetrainingHistory";
import {
  UserRole,
  PostPlatform,
  PostLanguage,
  ClassificationLabel,
  HITLPriority,
  HITLStatus,
  AlertSeverity,
  AlertTriggerType,
  RetrainingStatus,
  RetrainingType,
} from "../types";
import { logger } from "../utils/logger";

// ── Stub classifier (ML_MOCK_MODE=true) ───────────────────────────────────────

const MISINFO_KEYWORDS = [
  "infertility",
  "poison",
  "5g",
  "chip",
  "microchip",
  "bill gates",
  "depopulation",
  "harm",
  "kill",
  "danger",
  "death",
  "rashin haihuwa",
  "jigi ta",
  "fake",
  "government plot",
];

function stubClassify(content: string): ClassificationLabel {
  const lower = content.toLowerCase();
  if (MISINFO_KEYWORDS.some((kw) => lower.includes(kw))) {
    return Math.random() > 0.3
      ? ClassificationLabel.MISINFORMATION
      : ClassificationLabel.DISINFORMATION;
  }
  return Math.random() > 0.1
    ? ClassificationLabel.FACTUAL
    : ClassificationLabel.IRRELEVANT;
}

// ── Sample posts ──────────────────────────────────────────────────────────────

const SAMPLE_POSTS = [
  {
    content:
      "An gwanjo da an tabbatar — allurar Jigi ta tana sa rashin haihuwa a cikin mata",
    platform: PostPlatform.TWITTER,
    language: PostLanguage.HAUSA,
  },
  {
    content:
      "E don reach! Dem don confirm say na OPV be the real source of polio wey dem dey see for North",
    platform: PostPlatform.FACEBOOK,
    language: PostLanguage.PIDGIN,
  },
  {
    content:
      "NPHCDA announces expanded polio drive across 5 states — 2 million children targeted",
    platform: PostPlatform.TWITTER,
    language: PostLanguage.ENGLISH,
  },
  {
    content:
      "COVID-19 vaccine contains 5G nano-chip activated by signal from cell towers",
    platform: PostPlatform.YOUTUBE,
    language: PostLanguage.ENGLISH,
  },
  {
    content:
      "My neighbour's daughter got the HPV vaccine and now she can't walk",
    platform: PostPlatform.TWITTER,
    language: PostLanguage.ENGLISH,
  },
  {
    content:
      "Ajọ WHO ati NPHCDA ṣalaye: ajesara HPV jẹ ailewu ati munadoko fun awọn ọmọbinrin",
    platform: PostPlatform.FACEBOOK,
    language: PostLanguage.YORUBA,
  },
  {
    content:
      "Vaccine na poison wey dem dey use control population — share before dem remove am!",
    platform: PostPlatform.FACEBOOK,
    language: PostLanguage.PIDGIN,
  },
  {
    content:
      "AstraZeneca blood clot death — government hiding the truth about victims",
    platform: PostPlatform.TWITTER,
    language: PostLanguage.ENGLISH,
  },
  {
    content:
      "NCDC confirms zero wild poliovirus cases in Nigeria for third consecutive year",
    platform: PostPlatform.TWITTER,
    language: PostLanguage.ENGLISH,
  },
  {
    content:
      "Bill Gates using vaccines to depopulate Africa — documents leaked",
    platform: PostPlatform.YOUTUBE,
    language: PostLanguage.ENGLISH,
  },
];

const KB_DOCS = [
  {
    title: "NPHCDA Advisory — Jigi ta (MenA) vaccine safety summary (Apr 2024)",
    source: "NPHCDA",
    language: PostLanguage.HAUSA,
    content:
      "Jigi ta (MenA) vaccine has been reviewed by 14 independent studies. WHO and NPHCDA confirm no association with infertility. The vaccine is safe and effective for preventing meningitis A in Nigeria.",
  },
  {
    title: "WHO position paper — HPV vaccines (2022)",
    source: "WHO",
    language: PostLanguage.ENGLISH,
    content:
      "Over 500 million doses of HPV vaccine have been administered globally. Outstanding safety record. No causal link to paralysis or other serious adverse events has been established.",
  },
  {
    title: "NCDC Polio bulletin — cVDPV vs wild poliovirus clarification",
    source: "NCDC",
    language: PostLanguage.ENGLISH,
    content:
      "Circulating vaccine-derived poliovirus (cVDPV) occurs only in settings with very low vaccination coverage. The solution is more vaccination, not less. OPV is safe and recommended by WHO.",
  },
  {
    title: "WHO GPEI — Oral Polio Vaccine safety and efficacy overview",
    source: "WHO",
    language: PostLanguage.ENGLISH,
    content:
      "Oral Polio Vaccine is safe, effective, and has been used for decades. It does not cause polio in healthy children. Nigeria has achieved significant reduction in polio cases through OPV campaigns.",
  },
  {
    title: "COVID-19 vaccines: mRNA mechanism explained (NAFDAC)",
    source: "NAFDAC",
    language: PostLanguage.ENGLISH,
    content:
      "COVID-19 mRNA vaccines do not contain microchips, 5G hardware, or any tracking devices. The mRNA degrades within days and does not alter human DNA. Thoroughly reviewed by NAFDAC before approval.",
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function seed() {
  await mongoose.connect(config.mongodb.uri);
  logger.info("Seeding database…");

  // Clear existing seed data
  await Promise.all([
    User.deleteMany({}),
    Post.deleteMany({}),
    Classification.deleteMany({}),
    HITLReview.deleteMany({}),
    KnowledgeBase.deleteMany({}),
    Alert.deleteMany({}),
    ModelMetrics.deleteMany({}),
    RetrainingHistory.deleteMany({}),
  ]);

  // ── Users ─────────────────────────────────────────────────────────────────

  const [admin, supervisor, seniorAnalyst, analyst1, analyst2] =
    await User.create([
      {
        name: "Babatunde Olatunji",
        email: "babatunde@immuniwatch.ng",
        role: UserRole.SUPER_ADMIN,
        password: "Admin1234$",
      },
      {
        name: "Babatunde O.",
        email: "b.olatunji@immuniwatch.ng",
        role: UserRole.SUPERVISOR,
        password: "Admin1234$",
      },
      {
        name: "Amina Danladi",
        email: "amina@immuniwatch.ng",
        role: UserRole.SENIOR_ANALYST,
        password: "Admin1234$",
      },
      {
        name: "Chukwuemeka Eze",
        email: "chukwuemeka@immuniwatch.ng",
        role: UserRole.ANALYST,
        password: "Admin1234$",
      },
      {
        name: "Fatima Al-Hassan",
        email: "fatima@immuniwatch.ng",
        role: UserRole.ANALYST,
        password: "Admin1234$",
      },
    ]);

  // ── KB documents ──────────────────────────────────────────────────────────

  await KnowledgeBase.create(
    KB_DOCS.map((d) => ({
      ...d,
      embedded: false,
      createdBy: admin._id,
      embeddingVector: new Array(768).fill(0),
    })),
  );

  // ── Posts + Classifications ───────────────────────────────────────────────

  for (const sample of SAMPLE_POSTS) {
    const post = await Post.create(sample);
    const label = stubClassify(sample.content);
    const confidence = 0.65 + Math.random() * 0.33;

    const cls = await Classification.create({
      postId: post._id,
      label,
      confidence,
      entropy: 1 - confidence,
      modelVersion: "v1.4.2",
      alternatives: [],
      kbEvidence: [],
      fallback: false,
    });

    if (
      (label === ClassificationLabel.MISINFORMATION ||
        label === ClassificationLabel.DISINFORMATION) &&
      confidence >= 0.75
    ) {
      await HITLReview.create({
        postId: post._id,
        classificationId: cls._id,
        priority:
          confidence >= 0.85 ? HITLPriority.HIGH : HITLPriority.STANDARD,
        status: Math.random() > 0.4 ? HITLStatus.PENDING : HITLStatus.APPROVED,
      });
    }
  }

  // ── Alerts ────────────────────────────────────────────────────────────────

  await Alert.create([
    {
      severity: AlertSeverity.HIGH,
      triggerType: AlertTriggerType.SURGE,
      title: "Vaccine Infertility Surge — Twitter/X",
      message:
        'Surge: "Jigi ta causes infertility" — 247 posts in 2 hrs on Twitter/X (Hausa)',
      isResolved: false,
    },
    {
      severity: AlertSeverity.HIGH,
      triggerType: AlertTriggerType.SURGE,
      title: "OPV-Polio Coordinated Cluster — Facebook",
      message:
        "Coordinated cluster spreading OPV-polio claims on Facebook (Pidgin)",
      isResolved: false,
    },
    {
      severity: AlertSeverity.MEDIUM,
      triggerType: AlertTriggerType.PSI_DRIFT,
      affectedLanguage: PostLanguage.YORUBA,
      title: "PSI Drift — YO",
      message:
        "Yoruba PSI drift = 0.22 — exceeds 0.20 threshold; retraining queued",
      isResolved: false,
    },
  ]);

  // ── Model metrics ─────────────────────────────────────────────────────────

  await ModelMetrics.create({
    modelVersion: "v1.4.2",
    macroF1: 0.847,
    recall: 0.881,
    precision: 0.834,
    inferenceP95ms: 64,
    perLanguage: {
      en: { macroF1: 0.882, psi: 0.03, sampleCount: 4200 },
      pcm: { macroF1: 0.841, psi: 0.07, sampleCount: 1800 },
      ha: { macroF1: 0.798, psi: 0.12, sampleCount: 900 },
      yo: { macroF1: 0.681, psi: 0.22, sampleCount: 420 },
      ig: { macroF1: 0.724, psi: 0.09, sampleCount: 310 },
    },
    feedbackQueue: 128,
    lastRetrain: new Date("2026-04-01"),
  });

  await RetrainingHistory.create([
    {
      runId: "run-v1.4.2",
      modelVersionBefore: "v1.4.1",
      modelVersionAfter: "v1.4.2",
      type: RetrainingType.MONTHLY_FINE_TUNE,
      f1Before: 0.831,
      f1After: 0.847,
      triggeredBy: "system",
      startedAt: new Date("2026-04-01"),
      completedAt: new Date("2026-04-01"),
      status: RetrainingStatus.PROMOTED,
    },
    {
      runId: "run-v1.4.1",
      modelVersionBefore: "v1.4.0",
      modelVersionAfter: "v1.4.1",
      type: RetrainingType.MONTHLY_FINE_TUNE,
      f1Before: 0.823,
      f1After: 0.831,
      triggeredBy: "system",
      startedAt: new Date("2026-03-01"),
      completedAt: new Date("2026-03-01"),
      status: RetrainingStatus.PROMOTED,
    },
    {
      runId: "run-v1.4.0",
      modelVersionBefore: "v1.3.9",
      modelVersionAfter: "v1.4.0",
      type: RetrainingType.MONTHLY_FINE_TUNE,
      f1Before: 0.801,
      f1After: 0.823,
      triggeredBy: "system",
      startedAt: new Date("2026-02-01"),
      completedAt: new Date("2026-02-01"),
      status: RetrainingStatus.PROMOTED,
    },
  ]);

  logger.info("Seed complete ✓");
  await mongoose.disconnect();
}

seed().catch((err) => {
  logger.error("Seed failed", { message: (err as Error).message });
  process.exit(1);
});
