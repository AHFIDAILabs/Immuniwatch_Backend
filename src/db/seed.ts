/**
 * Seed script — bootstraps the database with the minimum required data:
 *   • One super admin account (all other users are created via the app UI)
 *   • Five WHO/NPHCDA/NCDC knowledge-base documents
 *
 * Usage:
 *   npm run seed
 *
 * WARNING: clears ALL existing data before seeding.
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';

import { config } from '../config';
import { User } from '../models/User';
import { Post } from '../models/Post';
import { Classification } from '../models/Classification';
import { HITLReview } from '../models/HITLReview';
import { KnowledgeBase } from '../models/KnowledgeBase';
import { Alert } from '../models/Alert';
import { ModelMetrics } from '../models/ModelMetrics';
import { RetrainingHistory } from '../models/RetrainingHistory';
import { UserRole, PostLanguage } from '../types';
import { logger } from '../utils/logger';

// ── Reference KB documents ────────────────────────────────────────────────────
// These are real WHO/NPHCDA/NCDC advisories used as evidence by the classifier.

const KB_DOCS = [
  {
    title: 'NPHCDA Advisory — Jigi ta (MenA) vaccine safety summary (Apr 2024)',
    source: 'NPHCDA',
    language: PostLanguage.HAUSA,
    content:
      'Jigi ta (MenA) vaccine has been reviewed by 14 independent studies. WHO and NPHCDA confirm no association with infertility. The vaccine is safe and effective for preventing meningitis A in Nigeria.',
  },
  {
    title: 'WHO position paper — HPV vaccines (2022)',
    source: 'WHO',
    language: PostLanguage.ENGLISH,
    content:
      'Over 500 million doses of HPV vaccine have been administered globally. Outstanding safety record. No causal link to paralysis or other serious adverse events has been established.',
  },
  {
    title: 'NCDC Polio bulletin — cVDPV vs wild poliovirus clarification',
    source: 'NCDC',
    language: PostLanguage.ENGLISH,
    content:
      'Circulating vaccine-derived poliovirus (cVDPV) occurs only in settings with very low vaccination coverage. The solution is more vaccination, not less. OPV is safe and recommended by WHO.',
  },
  {
    title: 'WHO GPEI — Oral Polio Vaccine safety and efficacy overview',
    source: 'WHO',
    language: PostLanguage.ENGLISH,
    content:
      'Oral Polio Vaccine is safe, effective, and has been used for decades. It does not cause polio in healthy children. Nigeria has achieved significant reduction in polio cases through OPV campaigns.',
  },
  {
    title: 'COVID-19 vaccines: mRNA mechanism explained (NAFDAC)',
    source: 'NAFDAC',
    language: PostLanguage.ENGLISH,
    content:
      'COVID-19 mRNA vaccines do not contain microchips, 5G hardware, or any tracking devices. The mRNA degrades within days and does not alter human DNA. Thoroughly reviewed by NAFDAC before approval.',
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function seed() {
  await mongoose.connect(config.mongodb.uri);
  logger.info('Seeding database…');

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

  // ── Super admin ───────────────────────────────────────────────────────────
  // The only bootstrapped user. All other accounts are created via the app UI.

  const passwordHash = await bcrypt.hash('Admin1234$', 12);

  const admin = await User.create({
    name:     'Super Admin',
    email:    'admin@immuniwatch.ng',
    role:     UserRole.SUPER_ADMIN,
    password: passwordHash,
  });

  logger.info(`Super admin created — email: admin@immuniwatch.ng  password: Admin1234$`);

  // ── Knowledge base documents ──────────────────────────────────────────────

  await KnowledgeBase.create(
    KB_DOCS.map((d) => ({
      ...d,
      embedded:        false,
      createdBy:       admin._id,
      embeddingVector: new Array(768).fill(0),
    })),
  );

  logger.info(`Seeded ${KB_DOCS.length} KB documents`);
  logger.info('Seed complete ✓');
  await mongoose.disconnect();
}

seed().catch((err) => {
  logger.error('Seed failed', { message: (err as Error).message });
  process.exit(1);
});
