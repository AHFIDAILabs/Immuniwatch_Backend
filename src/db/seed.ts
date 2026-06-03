/**
 * Seed script — bootstraps the platform with minimum required data:
 *   • One super admin (platform-level, no org)
 *   • Platform-level KB documents (WHO/NPHCDA/NCDC advisories)
 *   • Platform AppSettings defaults
 *
 * NOTE: Health center organizations and their users are created via the app UI
 * by the super admin — not seeded here.
 *
 * Usage:  npm run seed
 */

import 'dotenv/config';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import axios from 'axios';

import { config }          from '../config';
import { User }            from '../models/User';
import { Post }            from '../models/Post';
import { Classification }  from '../models/Classification';
import { HITLReview }      from '../models/HITLReview';
import { KnowledgeBase }   from '../models/KnowledgeBase';
import { Alert }           from '../models/Alert';
import { ModelMetrics }    from '../models/ModelMetrics';
import { RetrainingHistory } from '../models/RetrainingHistory';
import { Organization }    from '../models/Organization';
import { AppSettings }     from '../models/AppSettings';
import { UserRole, PostLanguage } from '../types';
import { logger }          from '../utils/logger';

// ── Global KB documents (visible to all orgs) ─────────────────────────────────

const KB_DOCS = [
  {
    title:    'NPHCDA Advisory — Jigi ta (MenA) vaccine safety summary (Apr 2024)',
    source:   'NPHCDA',
    language: PostLanguage.HAUSA,
    content:  'Jigi ta (MenA) vaccine has been reviewed by 14 independent studies. WHO and NPHCDA confirm no association with infertility. The vaccine is safe and effective for preventing meningitis A in Nigeria.',
  },
  {
    title:    'WHO position paper — HPV vaccines (2022)',
    source:   'WHO',
    language: PostLanguage.ENGLISH,
    content:  'Over 500 million doses of HPV vaccine have been administered globally. Outstanding safety record. No causal link to paralysis or other serious adverse events has been established.',
  },
  {
    title:    'NCDC Polio bulletin — cVDPV vs wild poliovirus clarification',
    source:   'NCDC',
    language: PostLanguage.ENGLISH,
    content:  'Circulating vaccine-derived poliovirus (cVDPV) occurs only in settings with very low vaccination coverage. The solution is more vaccination, not less. OPV is safe and recommended by WHO.',
  },
  {
    title:    'WHO GPEI — Oral Polio Vaccine safety and efficacy overview',
    source:   'WHO',
    language: PostLanguage.ENGLISH,
    content:  'Oral Polio Vaccine is safe, effective, and has been used for decades. It does not cause polio in healthy children. Nigeria has achieved significant reduction in polio cases through OPV campaigns.',
  },
  {
    title:    'COVID-19 vaccines: mRNA mechanism explained (NAFDAC)',
    source:   'NAFDAC',
    language: PostLanguage.ENGLISH,
    content:  'COVID-19 mRNA vaccines do not contain microchips, 5G hardware, or any tracking devices. The mRNA degrades within days and does not alter human DNA. Thoroughly reviewed by NAFDAC before approval.',
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
    Organization.deleteMany({}),
    AppSettings.deleteMany({}),
  ]);

  // ── Super admin (platform-level, no org) ─────────────────────────────────

  const passwordHash = await bcrypt.hash('Admin1234$', 12);
  const admin = await User.create({
    name:     'Super Admin',
    email:    'admin@immuniwatch.ng',
    role:     UserRole.SUPER_ADMIN,
    password: passwordHash,
  });
  logger.info('Super admin created — email: admin@immuniwatch.ng  password: Admin1234$');

  // ── Platform default settings ─────────────────────────────────────────────

  await AppSettings.create({ _key: 'platform' });
  logger.info('Platform default settings created');

  // ── Global KB documents — seeded into MongoDB AND synced to ML ChromaDB ───
  // No organizationId → visible to all orgs + super_admin

  const ML_BASE = config.mlService.url;
  const ML_KEY  = config.mlService.apiKey;

  let mlSynced = 0;

  for (const d of KB_DOCS) {
    // 1. Upload to ML ChromaDB first to get the doc_id
    let mlDocId: string | undefined;
    let mlIndexed = false;

    try {
      const { data: mlResult } = await axios.post(
        `${ML_BASE}/knowledge-base/upload`,
        { title: d.title, content: d.content, source: d.source, language: d.language, url: '' },
        { headers: { 'X-ML-API-Key': ML_KEY, 'Content-Type': 'application/json' }, timeout: 30_000 },
      );
      mlDocId   = mlResult.doc_id;
      mlIndexed = true;
      mlSynced++;
      logger.info(`  ✓ ML ChromaDB: "${d.title}" → doc_id=${mlResult.doc_id} chunks=${mlResult.chunks_indexed}`);
    } catch (err) {
      logger.warn(`  ✗ ML ChromaDB sync failed for "${d.title}": ${(err as Error).message}`);
    }

    // 2. Save to MongoDB with mlDocId if sync succeeded
    await KnowledgeBase.create({
      ...d,
      embedded:        false,
      createdBy:       admin._id,
      embeddingVector: new Array(768).fill(0),
      mlDocId,
      mlIndexed,
    });
  }

  logger.info(`Seeded ${KB_DOCS.length} global KB documents (${mlSynced}/${KB_DOCS.length} synced to ML ChromaDB)`);

  logger.info('─────────────────────────────────────────────────────');
  logger.info('Seed complete ✓');
  logger.info('Next steps:');
  logger.info('  1. Log in as admin@immuniwatch.ng / Admin1234$');
  logger.info('  2. Go to Organizations → Create Organization');
  logger.info('  3. Create an Org Admin for each health center');
  logger.info('  4. Log in as the Org Admin to create analysts & supervisors');
  logger.info('─────────────────────────────────────────────────────');

  await mongoose.disconnect();
}

seed().catch((err) => {
  logger.error('Seed failed', { message: (err as Error).message });
  process.exit(1);
});
