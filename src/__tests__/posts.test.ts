/**
 * Post ingestion + listing integration tests.
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
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

jest.mock('../services/classificationService', () => ({
  classifyPost: jest.fn().mockResolvedValue(undefined),
}));

import { User } from '../models/User';
import { Post } from '../models/Post';
import authRoutes from '../routes/authRoutes';
import postRoutes from '../routes/postRoutes';
import { errorHandler, notFound } from '../middlewares/errorHandler';

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/auth',  authRoutes);
  app.use('/posts', postRoutes);
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
  await mongoose.connection.dropDatabase();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

async function seedAndLogin(app: express.Application) {
  const user = new User({ name: 'Analyst', email: 'analyst@test.com', role: 'analyst', isActive: true });
  user.set('password', 'Password1!');
  await user.save();
  const res = await request(app).post('/auth/login').send({ email: 'analyst@test.com', password: 'Password1!' });
  return (res.headers['set-cookie'] as string[]).join('; ');
}

const VALID_POST = { content: 'Jigi ta causes infertility', platform: 'twitter', language: 'ha' };

describe('POST /posts (ingest)', () => {
  it('accepts a valid post and returns 202', async () => {
    const app     = buildApp();
    const cookies = await seedAndLogin(app);

    const res = await request(app).post('/posts').set('Cookie', cookies).send(VALID_POST);
    expect(res.status).toBe(202);
    expect(res.body).toHaveProperty('postId');
  });

  it('deduplicates posts with the same externalId + platform', async () => {
    const app     = buildApp();
    const cookies = await seedAndLogin(app);
    const payload = { ...VALID_POST, externalId: 'ext-123' };

    await request(app).post('/posts').set('Cookie', cookies).send(payload);
    const second = await request(app).post('/posts').set('Cookie', cookies).send(payload);

    expect(second.status).toBe(200);
    expect(second.body.message).toMatch(/Duplicate/i);
    expect(await Post.countDocuments()).toBe(1);
  });

  it('rejects a post with missing required fields', async () => {
    const app     = buildApp();
    const cookies = await seedAndLogin(app);

    const res = await request(app).post('/posts').set('Cookie', cookies).send({ content: 'No platform or language' });
    expect(res.status).toBe(400);
  });

  it('rejects a post with an invalid platform', async () => {
    const app     = buildApp();
    const cookies = await seedAndLogin(app);

    const res = await request(app).post('/posts').set('Cookie', cookies).send({ ...VALID_POST, platform: 'tiktok' });
    expect(res.status).toBe(400);
  });

  it('returns 401 for unauthenticated requests', async () => {
    const app = buildApp();
    const res = await request(app).post('/posts').send(VALID_POST);
    expect(res.status).toBe(401);
  });
});

describe('GET /posts (list)', () => {
  it('returns paginated posts', async () => {
    const app     = buildApp();
    const cookies = await seedAndLogin(app);

    await Post.create([
      { content: 'Post 1', platform: 'twitter',  language: 'en', ingestedAt: new Date() },
      { content: 'Post 2', platform: 'facebook', language: 'pcm', ingestedAt: new Date() },
    ]);

    const res = await request(app).get('/posts').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body).toHaveProperty('total', 2);
  });

  it('filters by platform', async () => {
    const app     = buildApp();
    const cookies = await seedAndLogin(app);

    await Post.create([
      { content: 'Twitter post',  platform: 'twitter',  language: 'en',  ingestedAt: new Date() },
      { content: 'Facebook post', platform: 'facebook', language: 'pcm', ingestedAt: new Date() },
    ]);

    const res = await request(app).get('/posts?platform=twitter').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].platform).toBe('twitter');
  });
});
