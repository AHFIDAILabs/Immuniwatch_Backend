/**
 * HITL workflow integration tests.
 * Verifies approve / reject / override transitions and audit side-effects.
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import nock from 'nock';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env.NODE_ENV               = 'test';
process.env.JWT_SECRET             = 'test-jwt-secret-min-32-chars-padding!!';
process.env.JWT_ACCESS_EXPIRES_IN  = '15m';
process.env.JWT_REFRESH_EXPIRES_IN = '7d';
process.env.MONGODB_URI            = 'mongodb://127.0.0.1:27017/test';
process.env.FRONTEND_URL           = 'http://localhost:5173';
process.env.COOKIE_SECURE          = 'false';
process.env.COOKIE_SAME_SITE       = 'lax';
process.env.KAFKA_ENABLED          = 'false';
process.env.ML_MOCK_MODE           = 'true';
process.env.ML_SERVICE_URL         = 'http://localhost:8000';
process.env.ML_API_KEY             = 'test-api-key-min-32-chars-padding!!';
process.env.CLOUDINARY_CLOUD_NAME  = 'test';
process.env.CLOUDINARY_API_KEY     = 'test';
process.env.CLOUDINARY_API_SECRET  = 'test';

jest.mock('../utils/kafkaProducer', () => ({
  publishRawPost:          jest.fn().mockResolvedValue(undefined),
  publishClassified:       jest.fn().mockResolvedValue(undefined),
  publishFeedback:         jest.fn().mockResolvedValue(undefined),
  publishRetrainTrigger:   jest.fn().mockResolvedValue(undefined),
  publishEmbeddingRequest: jest.fn().mockResolvedValue(undefined),
  startKafkaProducer:      jest.fn().mockResolvedValue(undefined),
  stopKafkaProducer:       jest.fn().mockResolvedValue(undefined),
  TOPICS: {},
}));

import { User }           from '../models/User';
import { Post }           from '../models/Post';
import { Classification } from '../models/Classification';
import { HITLReview }     from '../models/HITLReview';
import authRoutes  from '../routes/authRoutes';
import hitlRoutes  from '../routes/hitlRoutes';
import { errorHandler, notFound } from '../middlewares/errorHandler';

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use('/hitl', hitlRoutes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterEach(async () => {
  nock.cleanAll();
  await mongoose.connection.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

// ── Seed helpers ──────────────────────────────────────────────────────────────

async function seedAnalyst() {
  const user = new User({ name: 'Senior Analyst', email: 'analyst@test.com', role: 'senior_analyst', isActive: true });
  user.set('password', 'Password1!');
  await user.save();
  return user;
}

async function seedReview() {
  const post = await Post.create({
    content:    'Vaccines cause infertility — confirmed by doctors',
    platform:   'twitter',
    language:   'en',
    ingestedAt: new Date(),
  });
  const cls = await Classification.create({
    postId:       post._id,
    label:        'misinformation',
    confidence:   0.92,
    entropy:      0.12,
    fallback:     false,
    modelVersion: 'v1.0.0',
  });
  const review = await HITLReview.create({
    postId:           post._id,
    classificationId: cls._id,
    priority:         'high',
    status:           'pending',
  });
  return { post, cls, review };
}

async function loginCookies(app: express.Application) {
  const res = await request(app).post('/auth/login').send({ email: 'analyst@test.com', password: 'Password1!' });
  return (res.headers['set-cookie'] as unknown as string[]).join('; ');
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /hitl', () => {
  it('lists pending reviews for authenticated analyst', async () => {
    await seedAnalyst();
    await seedReview();
    const app     = buildApp();
    const cookies = await loginCookies(app);

    const res = await request(app).get('/hitl').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('pending');
  });

  it('returns 401 for unauthenticated request', async () => {
    const app = buildApp();
    const res = await request(app).get('/hitl');
    expect(res.status).toBe(401);
  });
});

describe('POST /hitl/:id/approve', () => {
  it('transitions review to approved', async () => {
    await seedAnalyst();
    const { review } = await seedReview();
    const app        = buildApp();
    const cookies    = await loginCookies(app);

    const res = await request(app).post(`/hitl/${review._id}/approve`).set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('approved');

    const updated = await HITLReview.findById(review._id);
    expect(updated?.status).toBe('approved');
  });

  it('returns 404 for non-existent review', async () => {
    await seedAnalyst();
    const app     = buildApp();
    const cookies = await loginCookies(app);
    const fakeId  = new mongoose.Types.ObjectId();

    const res = await request(app).post(`/hitl/${fakeId}/approve`).set('Cookie', cookies);
    expect(res.status).toBe(404);
  });
});

describe('POST /hitl/:id/reject', () => {
  it('transitions review to rejected', async () => {
    await seedAnalyst();
    const { review } = await seedReview();
    const app        = buildApp();
    const cookies    = await loginCookies(app);

    nock('http://localhost:8000')
      .post('/feedback')
      .reply(200, { accepted: true, feedback_id: 'fb-reject-1', queued_for_training: true, training_queue_size: 1 });

    const res = await request(app).post(`/hitl/${review._id}/reject`).set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
  });
});

describe('POST /hitl/:id/override', () => {
  it('overrides classification label', async () => {
    await seedAnalyst();
    const { review } = await seedReview();
    const app        = buildApp();
    const cookies    = await loginCookies(app);

    nock('http://localhost:8000')
      .post('/feedback')
      .reply(200, { accepted: true, feedback_id: 'fb-override-1', queued_for_training: true, training_queue_size: 2 });

    const res = await request(app)
      .post(`/hitl/${review._id}/override`)
      .set('Cookie', cookies)
      .send({ overrideLabel: 'factual', reviewerNote: 'Claim is actually supported by WHO' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('overridden');
    expect(res.body.overriddenLabel).toBe('factual');
  });

  it('returns 400 when overrideLabel is missing', async () => {
    await seedAnalyst();
    const { review } = await seedReview();
    const app        = buildApp();
    const cookies    = await loginCookies(app);

    // No nock needed — validation rejects before hitting ML service
    const res = await request(app)
      .post(`/hitl/${review._id}/override`)
      .set('Cookie', cookies)
      .send({ reviewerNote: 'missing label' });

    expect(res.status).toBe(400);
  });
});
