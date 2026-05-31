/**
 * ML Integration tests — Jest + nock + mongodb-memory-server.
 * No real DB. No real HTTP calls to Python.
 * These must pass in CI before any PR touching mlClient.ts or classificationService.ts.
 */

import nock from 'nock';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// ── Test environment ──────────────────────────────────────────────────────────

// Set env vars before any module import
process.env.ML_SERVICE_URL        = 'http://ml-service-test:8000';
process.env.ML_API_KEY            = 'test-api-key-min-32-chars-padding';
process.env.ML_MOCK_MODE          = 'false';
process.env.KAFKA_ENABLED         = 'false';
process.env.JWT_SECRET            = 'test-jwt-secret-min-32-chars-padding!!';
process.env.MONGODB_URI           = 'mongodb://localhost:27017/test'; // overridden below
process.env.CLOUDINARY_CLOUD_NAME = 'test';
process.env.CLOUDINARY_API_KEY    = 'test';
process.env.CLOUDINARY_API_SECRET = 'test';

// ── Mongoose models (must come after env is set) ──────────────────────────────

import { Post }           from '../models/Post';
import { Classification } from '../models/Classification';
import { HITLReview }     from '../models/HITLReview';
import { KnowledgeBase }  from '../models/KnowledgeBase';
import { ModelMetrics }   from '../models/ModelMetrics';
import { Alert }          from '../models/Alert';
import { PostPlatform, PostLanguage, ClassificationLabel, HITLPriority, AlertSeverity, AlertTriggerType } from '../types';
import { MLLabel, MLLanguage } from '../types/ml.types';

// ── Mocks ─────────────────────────────────────────────────────────────────────

jest.mock('../utils/kafkaProducer', () => ({
  publishRawPost:          jest.fn().mockResolvedValue(undefined),
  publishClassified:       jest.fn().mockResolvedValue(undefined),
  publishFeedback:         jest.fn().mockResolvedValue(undefined),
  publishRetrainTrigger:   jest.fn().mockResolvedValue(undefined),
  publishEmbeddingRequest: jest.fn().mockResolvedValue(undefined),
  startKafkaProducer:      jest.fn().mockResolvedValue(undefined),
  stopKafkaProducer:       jest.fn().mockResolvedValue(undefined),
  TOPICS: {
    RAW_POSTS:         'iw.raw-posts',
    CLASSIFIED_POSTS:  'iw.classified-posts',
    FEEDBACK:          'iw.feedback',
    RETRAIN_TRIGGER:   'iw.retrain-trigger',
    EMBEDDING_REQUEST: 'iw.embedding-request',
  },
}));

const mockBroadcast = jest.fn();
(global as Record<string, unknown>).io = {
  emit: mockBroadcast,
  fetchSockets: jest.fn().mockResolvedValue([
    { data: { role: 'super_admin' }, emit: mockBroadcast },
  ]),
};

// ── DB lifecycle ──────────────────────────────────────────────────────────────

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Promise.all(
    Object.values(mongoose.connection.collections).map((c) => c.deleteMany({})),
  );
  nock.cleanAll();
  mockBroadcast.mockClear();
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const ML_URL = 'http://ml-service-test:8000';

function seedPost() {
  return Post.create({
    content:  'An gwanjo da an tabbatar — allurar Jigi ta tana sa rashin haihuwa',
    platform: PostPlatform.TWITTER,
    language: PostLanguage.HAUSA,
  });
}

function mlClassifyResponse(overrides: Partial<object> = {}) {
  return {
    post_id:       'PLACEHOLDER',
    label:         MLLabel.MISINFORMATION,
    confidence:    0.91,
    entropy:       0.12,
    model_version: 'v1.4.2',
    alternatives:  [{ label: MLLabel.FACTUAL, confidence: 0.07 }],
    processing_ms: 42,
    kb_evidence:   [],
    fallback:      false,
    ...overrides,
  };
}

function mlMetricsResponse(overrides: Partial<object> = {}) {
  return {
    model_version: 'v1.4.3',
    overall: {
      macro_f1:       0.861,
      recall:         0.842,
      precision:      0.878,
      latency_p95_ms: 120,
    },
    by_language: {
      en: { macro_f1: 0.88, psi: 0.05, sample_count: 1200 },
      ha: { macro_f1: 0.81, psi: 0.08, sample_count: 800 },
    },
    computed_at: new Date().toISOString(),
    ...overrides,
  };
}

// ── Test suites ───────────────────────────────────────────────────────────────

describe('classifyPost — happy path', () => {
  it('creates Classification and HITLReview when Python returns misinformation', async () => {
    const post = await seedPost();

    nock(ML_URL)
      .post('/embed').reply(200, { embedding: new Array(768).fill(0.1), model: 'e5', processing_ms: 5 })
      .post('/classify').reply(200, { ...mlClassifyResponse(), post_id: post._id.toString() });

    const { classifyPost } = await import('../services/classificationService');
    const result = await classifyPost(post._id.toString());

    expect(result.classification.label).toBe(ClassificationLabel.MISINFORMATION);
    expect(result.classification.confidence).toBeCloseTo(0.91);
    expect(result.hitlReview).not.toBeNull();
    expect(result.hitlReview!.priority).toBe(HITLPriority.HIGH);

    const dbCls = await Classification.findOne({ postId: post._id });
    expect(dbCls).not.toBeNull();
  });
});

describe('classifyPost — factual auto-approval', () => {
  it('skips HITLReview when confidence >= 0.92 and label is factual', async () => {
    const post = await seedPost();

    nock(ML_URL)
      .post('/embed').reply(200, { embedding: new Array(768).fill(0.1), model: 'e5', processing_ms: 5 })
      .post('/classify').reply(200, {
        ...mlClassifyResponse({ label: MLLabel.FACTUAL, confidence: 0.95, entropy: 0.04 }),
        post_id: post._id.toString(),
      });

    const { classifyPost } = await import('../services/classificationService');
    const result = await classifyPost(post._id.toString());

    expect(result.classification.label).toBe(ClassificationLabel.FACTUAL);
    expect(result.hitlReview).toBeNull();
  });
});

describe('classifyPost — elevated entropy promotes to HIGH priority', () => {
  it('assigns HIGH priority HITL when entropy > 0.45 even below highPriorityThreshold', async () => {
    const post = await seedPost();

    nock(ML_URL)
      .post('/embed').reply(200, { embedding: new Array(768).fill(0.1), model: 'e5', processing_ms: 5 })
      .post('/classify').reply(200, {
        ...mlClassifyResponse({ confidence: 0.78, entropy: 0.52 }),
        post_id: post._id.toString(),
      });

    const { classifyPost } = await import('../services/classificationService');
    const result = await classifyPost(post._id.toString());

    expect(result.hitlReview).not.toBeNull();
    expect(result.hitlReview!.priority).toBe(HITLPriority.HIGH);
  });
});

describe('classifyPost — fallback (Python 503)', () => {
  it('creates PENDING Classification and HIGH-priority HITLReview', async () => {
    const post = await seedPost();

    nock(ML_URL)
      .post('/embed').reply(200, { embedding: new Array(768).fill(0), model: 'e5', processing_ms: 1 })
      .post('/classify').reply(503);

    const { classifyPost } = await import('../services/classificationService');
    const result = await classifyPost(post._id.toString());

    expect(result.classification.label).toBe(ClassificationLabel.PENDING);
    expect(result.classification.confidence).toBe(0);
    expect(result.hitlReview).not.toBeNull();
    expect(result.hitlReview!.priority).toBe(HITLPriority.HIGH);
    expect(result.hitlReview!.notes).toMatch(/fallback/i);
  });
});

describe('circuit breaker', () => {
  it('returns fallback immediately without HTTP after threshold failures', async () => {
    const post = await seedPost();

    // Enough 503s to trip the breaker (volumeThreshold=5, errorThreshold=50%)
    nock(ML_URL)
      .post('/embed').times(10).reply(200, { embedding: new Array(768).fill(0), processing_ms: 1 })
      .post('/classify').times(6).reply(503);

    const { classifyPost } = await import('../services/classificationService');

    // Fire requests — after threshold the breaker opens
    for (let i = 0; i < 6; i++) {
      const p = await Post.create({
        content: `Test post ${i}`, platform: PostPlatform.TWITTER, language: PostLanguage.ENGLISH,
      });
      await classifyPost(p._id.toString()).catch(() => {});
    }

    // Additional request should use fallback — no new nock interceptor needed
    const extraPost = await Post.create({
      content: 'Extra post', platform: PostPlatform.TWITTER, language: PostLanguage.ENGLISH,
    });
    const result = await classifyPost(extraPost._id.toString());
    expect(result.classification.fallback).toBe(true);
  });
});

describe('submitAnalystFeedback', () => {
  it('sends POST /feedback with correct payload shape', async () => {
    const post = await seedPost();
    const cls  = await Classification.create({
      postId:       post._id,
      label:        ClassificationLabel.MISINFORMATION,
      confidence:   0.88,
      entropy:      0.15,
      modelVersion: 'v1.4.2',
      fallback:     false,
    });
    const review = await HITLReview.create({
      postId:           post._id,
      classificationId: cls._id,
      priority:         HITLPriority.HIGH,
      status:           'pending',
    });

    const feedbackBody = {
      accepted:            true,
      feedback_id:         'fb-123',
      queued_for_training: true,
      training_queue_size: 42,
    };

    let capturedBody: Record<string, unknown> = {};
    nock(ML_URL)
      .post('/feedback', (body) => { capturedBody = body; return true; })
      .reply(200, feedbackBody);

    const { User } = await import('../models/User');
    const analyst = await User.create({
      name: 'Test Analyst', email: 'analyst@test.com',
      role: 'analyst', password: 'hashed-password-12345',
    });

    const { submitAnalystFeedback } = await import('../services/classificationService');
    await submitAnalystFeedback(review._id.toString(), analyst._id.toString());

    expect(capturedBody).toMatchObject({
      post_id:        post._id.toString(),
      original_label: MLLabel.MISINFORMATION,
      analyst_role:   'analyst',
    });
  });
});

describe('modelHealthService — metrics poll', () => {
  it('fetches live metrics, upserts ModelMetrics with renamed fields', async () => {
    nock(ML_URL).get('/metrics').reply(200, mlMetricsResponse());

    const { getMetrics } = await import('../services/modelHealthService');
    await getMetrics();

    const metrics = await ModelMetrics.findOne({ modelVersion: 'v1.4.3' });
    expect(metrics).not.toBeNull();
    expect(metrics!.macroF1).toBeCloseTo(0.861);
    expect(metrics!.inferenceP95ms).toBe(120);
  });
});

describe('modelHealthService — checkPsiDrift', () => {
  it('creates HIGH severity PSI_DRIFT Alert when PSI exceeds threshold', async () => {
    nock(ML_URL).get('/metrics').reply(200, mlMetricsResponse({
      by_language: {
        yo: { macro_f1: 0.77, psi: 0.25, sample_count: 600 }, // 0.25 > 0.2 threshold
        en: { macro_f1: 0.88, psi: 0.05, sample_count: 1200 },
      },
    }));

    const { checkPsiDrift } = await import('../services/modelHealthService');
    await checkPsiDrift();

    const alert = await Alert.findOne({ triggerType: AlertTriggerType.PSI_DRIFT });
    expect(alert).not.toBeNull();
    expect(alert!.severity).toBe(AlertSeverity.HIGH);
    expect(alert!.affectedLanguage).toBe('yo');
    expect(mockBroadcast).toHaveBeenCalledWith('MODEL_DRIFT_ALERT', expect.anything());
  });
});

describe('getEmbedding — fallback', () => {
  it('returns 768-element zero array when /embed returns 500', async () => {
    nock(ML_URL).post('/embed').reply(500);

    const { getEmbedding } = await import('../services/mlClient');
    const vector = await getEmbedding('test text', MLLanguage.EN);

    expect(vector).toHaveLength(768);
    expect(vector.every((v) => v === 0)).toBe(true);
  });
});

describe('searchSimilar — fallback to text search', () => {
  it('falls back to MongoDB $text search when embedding is zero-vector', async () => {
    // Seed KB docs
    const { User: U } = await import('../models/User');
    const kbUser = await U.create({ name: 'KB Admin', email: 'kbadmin@test.com', role: 'super_admin', password: 'password-12345' });

    await KnowledgeBase.create([
      {
        title: 'Jigi ta vaccine safety', source: 'NPHCDA', language: PostLanguage.HAUSA,
        content: 'Jigi ta vaccine is safe and effective for preventing meningitis',
        embedded: true, embeddingVector: new Array(768).fill(0.5),
        createdBy: kbUser._id,
      },
      {
        title: 'OPV polio safety', source: 'WHO', language: PostLanguage.ENGLISH,
        content: 'Oral polio vaccine OPV does not cause polio in healthy children',
        embedded: true, embeddingVector: new Array(768).fill(0.3),
        createdBy: kbUser._id,
      },
    ]);

    // Create text index manually for in-memory MongoDB (language_override prevents unsupported-language errors)
    await KnowledgeBase.collection.createIndex({ content: 'text', title: 'text' }, { default_language: 'none', language_override: 'text_lang' } as Record<string, unknown>);

    // Mock getEmbedding to return zero-vector (circuit open)
    nock(ML_URL).post('/embed').reply(500);

    const { searchSimilar } = await import('../services/kbService');
    const results = await searchSimilar('Jigi ta infertility claim', 2, PostLanguage.HAUSA);

    // Falls back to text search — should return the Jigi ta doc
    expect(results.length).toBeGreaterThan(0);
  });
});
