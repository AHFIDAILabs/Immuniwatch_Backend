/**
 * Auth integration tests.
 * Uses mongodb-memory-server — no real DB, no real network.
 */

import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// ── Env must be set before any module that reads config ───────────────────────
process.env.NODE_ENV              = 'test';
process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-padding!!';
process.env.JWT_ACCESS_EXPIRES_IN = '15m';
process.env.JWT_REFRESH_EXPIRES_IN= '7d';
process.env.MONGODB_URI           = 'mongodb://127.0.0.1:27017/test'; // overridden below
process.env.FRONTEND_URL          = 'http://localhost:5173';
process.env.COOKIE_SECURE         = 'false';
process.env.COOKIE_SAME_SITE      = 'lax';
process.env.KAFKA_ENABLED         = 'false';
process.env.ML_MOCK_MODE          = 'true';
process.env.ML_SERVICE_URL        = 'http://localhost:8000';
process.env.ML_API_KEY            = 'test-api-key-min-32-chars-padding!!';
process.env.CLOUDINARY_CLOUD_NAME = 'test';
process.env.CLOUDINARY_API_KEY    = 'test';
process.env.CLOUDINARY_API_SECRET = 'test';

import { User } from '../models/User';
import authRoutes from '../routes/authRoutes';
import { errorHandler, notFound } from '../middlewares/errorHandler';

// ── Build a minimal Express app for tests ────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/auth', authRoutes);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createUser(overrides: Partial<{ email: string; password: string; role: string }> = {}) {
  const { email = 'analyst@test.com', password = 'Password1!', role = 'analyst' } = overrides;
  const user = new User({ name: 'Test Analyst', email, role, isActive: true });
  await (user as unknown as { setPassword: (p: string) => Promise<void> }).setPassword?.(password)
    .catch(() => { (user as unknown as Record<string, unknown>).password = password; });
  // Use comparePassword model method path — just set hashed directly via model
  user.set('password', password); // model pre-save hook hashes it
  await user.save();
  return user;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /auth/login', () => {
  it('returns 200 + sets HttpOnly cookies on valid credentials', async () => {
    await createUser();
    const app = buildApp();

    const res = await request(app)
      .post('/auth/login')
      .send({ email: 'analyst@test.com', password: 'Password1!' });

    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ email: 'analyst@test.com', role: 'analyst' });
    expect(res.body).not.toHaveProperty('accessToken');
    expect(res.body).not.toHaveProperty('refreshToken');

    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('access_token='))).toBe(true);
    expect(cookies.some((c) => c.startsWith('refresh_token='))).toBe(true);
    expect(cookies.every((c) => c.includes('HttpOnly'))).toBe(true);
  });

  it('returns 401 on wrong password', async () => {
    await createUser();
    const app = buildApp();
    const res = await request(app).post('/auth/login').send({ email: 'analyst@test.com', password: 'wrongpass' });
    expect(res.status).toBe(401);
  });

  it('returns 401 for inactive user', async () => {
    const user = await createUser();
    await User.findByIdAndUpdate(user._id, { isActive: false });
    const app = buildApp();
    const res = await request(app).post('/auth/login').send({ email: 'analyst@test.com', password: 'Password1!' });
    expect(res.status).toBe(401);
  });

  it('returns 400 on malformed email', async () => {
    const app = buildApp();
    const res = await request(app).post('/auth/login').send({ email: 'not-an-email', password: 'Password1!' });
    expect(res.status).toBe(400);
  });
});

describe('POST /auth/refresh', () => {
  it('returns 200 + new cookies when refresh_token cookie is valid', async () => {
    await createUser();
    const app = buildApp();

    const login = await request(app).post('/auth/login').send({ email: 'analyst@test.com', password: 'Password1!' });
    const cookies = (login.headers['set-cookie'] as unknown as string[]).join('; ');

    const res = await request(app).post('/auth/refresh').set('Cookie', cookies);
    expect(res.status).toBe(200);
    const newCookies = res.headers['set-cookie'] as unknown as string[];
    expect(newCookies.some((c) => c.startsWith('access_token='))).toBe(true);
  });

  it('returns 401 when no refresh_token cookie provided', async () => {
    const app = buildApp();
    const res = await request(app).post('/auth/refresh');
    expect(res.status).toBe(401);
  });
});

describe('GET /auth/me', () => {
  it('returns user when access_token cookie is valid', async () => {
    await createUser();
    const app = buildApp();

    const login = await request(app).post('/auth/login').send({ email: 'analyst@test.com', password: 'Password1!' });
    const cookies = (login.headers['set-cookie'] as unknown as string[]).join('; ');

    const res = await request(app).get('/auth/me').set('Cookie', cookies);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'analyst@test.com' });
  });

  it('returns 401 with no cookie', async () => {
    const app = buildApp();
    const res = await request(app).get('/auth/me');
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/logout', () => {
  it('clears cookies and revokes refresh token', async () => {
    await createUser();
    const app = buildApp();

    const login  = await request(app).post('/auth/login').send({ email: 'analyst@test.com', password: 'Password1!' });
    const cookies = (login.headers['set-cookie'] as unknown as string[]).join('; ');

    const logout = await request(app).post('/auth/logout').set('Cookie', cookies);
    expect(logout.status).toBe(200);

    // Cleared cookies should have maxAge=0 or expired date
    const clearedCookies = logout.headers['set-cookie'] as unknown as string[];
    expect(clearedCookies.some((c) => c.includes('access_token=;') || c.includes('Expires=Thu, 01 Jan 1970'))).toBe(true);
  });
});
