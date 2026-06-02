// Changes vs. original:
//   • mlService.mockMode: default changed from 'true' → 'false'.
//     The original default meant any deployment that forgot to set ML_MOCK_MODE
//     would silently bypass the real ML service without any indication.
//     Now the safe default is live — set ML_MOCK_MODE=true explicitly in
//     local dev or CI where you don't have the Python service running.

import dotenv from "dotenv";
import { z } from "zod";

dotenv.config();

const schema = z.object({
  nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  port: z.coerce.number().default(5000),
  frontendUrl: z.string().url().default("http://localhost:5173"),

  cookie: z.object({
    secure: z
      .string()
      .transform((v) => v === "true")
      .default("false"),
    sameSite: z.enum(["strict", "lax", "none"]).default("lax"),
  }),

  mongodb: z.object({
    uri: z.string().min(1),
  }),

  jwt: z.object({
    secret: z.string().min(32),
    accessExpiresIn: z.string().default("15m"),
    refreshExpiresIn: z.string().default("7d"),
  }),

  cloudinary: z.object({
    cloudName: z.string().default(""),
    apiKey: z.string().default(""),
    apiSecret: z.string().default(""),
  }),

  mlService: z.object({
    url: z.string().url().default("http://localhost:8000"),
    apiKey: z.string().min(1).default("change_me"),
    timeoutMs: z.coerce.number().default(5000),
    batchTimeoutMs: z.coerce.number().default(30000),
    psiThreshold: z.coerce.number().default(0.2),
    minFeedbackSamples: z.coerce.number().default(500),
    // CHANGED: default is now 'false' (live mode).
    // Set ML_MOCK_MODE=true in .env.local / CI to use stub responses
    // without requiring the Python service to be running.
    mockMode: z
      .string()
      .transform((v) => v === "true")
      .default("false"),
    circuitBreaker: z.object({
      errorThresholdPercent: z.coerce.number().default(50),
      resetTimeoutMs: z.coerce.number().default(30000),
      volumeThreshold: z.coerce.number().default(5),
    }),
  }),

  classification: z.object({
    hitlThreshold: z.coerce.number().default(0.75),
    highPriorityThreshold: z.coerce.number().default(0.85),
  }),

  kafka: z.object({
    enabled: z
      .string()
      .transform((v) => v === "true")
      .default("false"),
    brokers: z
      .string()
      .default("localhost:9092")
      .transform((v) => v.split(",")),
    groupId: z.string().default("iw-backend"),
    clientId: z.string().default("iw-backend-server"),
  }),

  alerts: z.object({
    surgeThreshold: z.coerce.number().default(200),
    analystOverrideRateAlert: z.coerce.number().default(15),
  }),

  groq: z.object({
    apiKey: z.string().default(''),       // GROQ_API_KEY — set in .env to enable RAG
    model:  z.string().default('llama3-8b-8192'),
  }),
});

const parsed = schema.safeParse({
  nodeEnv: process.env.NODE_ENV,
  port: process.env.PORT,
  // Coerce empty string → undefined so Zod's .default() fires correctly.
  frontendUrl: process.env.FRONTEND_URL || undefined,

  cookie: {
    secure: process.env.COOKIE_SECURE,
    sameSite: process.env.COOKIE_SAME_SITE,
  },

  mongodb: {
    uri: process.env.MONGODB_URI,
  },

  jwt: {
    secret: process.env.JWT_SECRET,
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN,
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN,
  },

  cloudinary: {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    apiSecret: process.env.CLOUDINARY_API_SECRET,
  },

  mlService: {
    url: process.env.ML_SERVICE_URL,
    apiKey: process.env.ML_API_KEY,
    timeoutMs: process.env.ML_TIMEOUT_MS,
    batchTimeoutMs: process.env.ML_BATCH_TIMEOUT_MS,
    psiThreshold: process.env.ML_PSI_THRESHOLD,
    minFeedbackSamples: process.env.ML_MIN_FEEDBACK_SAMPLES,
    mockMode: process.env.ML_MOCK_MODE,
    circuitBreaker: {
      errorThresholdPercent: process.env.CB_ERROR_THRESHOLD,
      resetTimeoutMs: process.env.CB_RESET_TIMEOUT_MS,
      volumeThreshold: process.env.CB_VOLUME_THRESHOLD,
    },
  },

  classification: {
    hitlThreshold: process.env.HITL_THRESHOLD,
    highPriorityThreshold: process.env.HIGH_PRIORITY_THRESHOLD,
  },

  kafka: {
    enabled: process.env.KAFKA_ENABLED,
    brokers: process.env.KAFKA_BROKERS,
    groupId: process.env.KAFKA_GROUP_ID,
    clientId: process.env.KAFKA_CLIENT_ID,
  },

  alerts: {
    surgeThreshold: process.env.SURGE_THRESHOLD,
    analystOverrideRateAlert: process.env.ANALYST_OVERRIDE_RATE_ALERT,
  },

  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model:  process.env.GROQ_MODEL   || 'llama3-8b-8192',
  },
});

if (!parsed.success) {
  console.error("Invalid environment configuration:");
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;
