/**
 * mlClient — the ONLY file that makes HTTP calls to the Python ML service.
 * All other services must go through classificationService, kbService, or
 * modelHealthService — never import mlClient directly from anywhere else.
 *
 * Changes vs. original:
 *   • config.mlService.mockMode is now actually checked — all exported
 *     functions return realistic stub data when mock mode is on. Previously
 *     the flag was read into config and logged at startup, but never acted on.
 *   • Mock classify uses a deterministic keyword heuristic so the dashboard
 *     fills with plausible data in local dev without touching the Python service.
 *   • Mock health, metrics, and retrain return stable, realistic payloads.
 *
 * Resilience layers (unchanged):
 *   1. axios-retry  — retries transient errors (429, 5xx) with exponential back-off
 *   2. opossum      — circuit breaker; trips to OPEN after threshold failures,
 *                     returns safe fallbacks so the HITL queue absorbs the load
 */

import axios, { AxiosInstance } from "axios";
import axiosRetry from "axios-retry";
import CircuitBreaker from "opossum";

import { config } from "../config";
import { AppError } from "../utils/AppError";
import { logger } from "../utils/logger";
import {
  CircuitState,
  MLBatchEmbedItem,
  MLBatchEmbedResultItem,
  MLBatchResponse,
  MLBatchResult,
  MLClassifyRequest,
  MLClassifyResponse,
  MLFeedbackPayload,
  MLFeedbackResponse,
  MLHealthResponse,
  MLLabel,
  MLLanguage,
  MLMetricsResponse,
  MLRecentResponse,
  MLRetrainPayload,
  MLRetrainStatus,
} from "../types/ml.types";

// ── Axios instance ────────────────────────────────────────────────────────────

const http: AxiosInstance = axios.create({
  baseURL: config.mlService.url,
  timeout: config.mlService.timeoutMs,
  headers: {
    "Content-Type": "application/json",
    "X-ML-API-Key": config.mlService.apiKey,
  },
});

// Retry on 429 / 5xx only — never on 4xx (client errors are not transient)
axiosRetry(http, {
  retries: 3,
  retryDelay: (retryCount) => [200, 400, 800][retryCount - 1] ?? 800,
  retryCondition: (err) => {
    const status = err.response?.status ?? 0;
    return status === 429 || status >= 500;
  },
  onRetry: (count, err) => {
    logger.warn(`mlClient retry #${count} — ${err.message}`);
  },
});

// ── Mock implementations (used when ML_MOCK_MODE=true) ────────────────────────

const MOCK_MODEL_VERSION = "v1.0.0-mock";

// Keyword heuristic — mirrors the seed's stub classifier so mock + seed data
// are consistent with each other.
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
  "covid chip",
  "mark of the beast",
];

function mockLabel(content: string): MLLabel {
  const lower = content.toLowerCase();
  if (MISINFO_KEYWORDS.some((kw) => lower.includes(kw))) {
    return Math.random() > 0.35 ? MLLabel.MISINFORMATION : MLLabel.IRRELEVANT;
  }
  return Math.random() > 0.12 ? MLLabel.FACTUAL : MLLabel.IRRELEVANT;
}

function mockClassifyResponse(req: MLClassifyRequest): MLClassifyResponse {
  const label = mockLabel(req.content);
  const confidence =
    label === MLLabel.FACTUAL
      ? 0.82 + Math.random() * 0.14
      : 0.71 + Math.random() * 0.22;
  const entropy =
    label === MLLabel.FACTUAL
      ? 0.05 + Math.random() * 0.15
      : 0.2 + Math.random() * 0.35;

  const alts = (
    [MLLabel.MISINFORMATION, MLLabel.FACTUAL, MLLabel.IRRELEVANT] as MLLabel[]
  )
    .filter((l) => l !== label)
    .map((l, i) => ({
      label: l,
      confidence: i === 0 ? 1 - confidence - 0.03 : 0.03,
    }));

  return {
    post_id: req.post_id,
    label,
    confidence: Math.round(confidence * 1000) / 1000,
    entropy: Math.round(entropy * 1000) / 1000,
    model_version: MOCK_MODEL_VERSION,
    language: req.language ?? undefined,
    alternatives: alts,
    processing_ms: Math.round(60 + Math.random() * 80),
    kb_evidence: req.kb_snippets?.length
      ? [
          {
            doc_id: "mock-0",
            title: "",
            snippet: req.kb_snippets[0],
            score: 0.82,
          },
        ]
      : [],
    fallback: false,
  };
}

const mockBatchStore = new Map<string, MLBatchResult>();

function mockHealthResponse(): MLHealthResponse {
  return {
    status: "ok",
    model_loaded: true,
    model_version: MOCK_MODEL_VERSION,
    device: "cpu (mock)",
    uptime_s: Math.floor(Date.now() / 1000) % 86400,
  };
}

function mockMetricsResponse(): MLMetricsResponse {
  return {
    model_version: MOCK_MODEL_VERSION,
    overall: {
      macro_f1: 0.9311,
      recall: 0.8426,
      precision: 0.8667,
      latency_p95_ms: 276,
    },
    by_language: {
      [MLLanguage.EN]: { macro_f1: 0.83, recall: 0.855, psi: 0.0 },
      [MLLanguage.PCM]: { macro_f1: 0.827, recall: 0.849, psi: 0.0 },
      [MLLanguage.HA]: { macro_f1: 0.687, recall: 0.712, psi: 0.0 },
      [MLLanguage.IG]: { macro_f1: 0.69, recall: 0.715, psi: 0.0 },
      [MLLanguage.YO]: { macro_f1: 0.559, recall: 0.581, psi: 0.0 },
    },
    computed_at: new Date().toISOString(),
  };
}

// ── Fallback builders (used by circuit breaker when live service fails) ────────

function classifyFallback(req: MLClassifyRequest): MLClassifyResponse {
  return {
    post_id: req.post_id,
    label: MLLabel.FACTUAL, // neutral — HITL will decide
    confidence: 0,
    entropy: 1,
    model_version: "fallback",
    alternatives: [],
    processing_ms: 0,
    kb_evidence: [],
    fallback: true,
  };
}

// ── Raw HTTP calls (wrapped by circuit breaker below) ─────────────────────────

async function _classifySingle(
  payload: MLClassifyRequest,
): Promise<MLClassifyResponse> {
  const { data } = await http.post<MLClassifyResponse>("/classify", payload);
  return data;
}

async function _classifyBatch(
  posts: MLClassifyRequest[],
): Promise<MLBatchResponse> {
  const { data } = await http.post<MLBatchResponse>("/classify/batch", {
    posts,
  });
  return data;
}

async function _pollBatch(jobId: string): Promise<MLBatchResult> {
  const { data } = await http.get<MLBatchResult>(`/classify/batch/${jobId}`);
  return data;
}

async function _getEmbedding(
  text: string,
  language: MLLanguage,
): Promise<number[]> {
  const { data } = await http.post<{ embedding: number[] }>("/embed", {
    text,
    language,
  });
  return data.embedding;
}

async function _embedBatch(
  documents: MLBatchEmbedItem[],
): Promise<MLBatchEmbedResultItem[]> {
  const { data } = await http.post<{ results: MLBatchEmbedResultItem[] }>(
    "/embed/batch",
    { items: documents },
  );
  return data.results;
}

async function _submitFeedback(
  payload: MLFeedbackPayload,
): Promise<MLFeedbackResponse> {
  const { data } = await http.post<MLFeedbackResponse>("/feedback", payload);
  return data;
}

async function _getModelMetrics(): Promise<MLMetricsResponse> {
  const { data } = await http.get<MLMetricsResponse>("/metrics");
  return data;
}

async function _getHealth(): Promise<MLHealthResponse> {
  const { data } = await http.get<MLHealthResponse>("/health");
  return data;
}

async function _triggerRetrain(payload: MLRetrainPayload): Promise<void> {
  await http.post("/retrain/trigger", payload);
}

async function _getRetrainStatus(): Promise<MLRetrainStatus | null> {
  try {
    const { data } = await http.get<MLRetrainStatus>("/retrain/status");
    return data;
  } catch (err) {
    if (axios.isAxiosError(err) && err.response?.status === 404) return null;
    throw err;
  }
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

const cbOptions: CircuitBreaker.Options = {
  errorThresholdPercentage:
    config.mlService.circuitBreaker.errorThresholdPercent,
  resetTimeout: config.mlService.circuitBreaker.resetTimeoutMs,
  volumeThreshold: config.mlService.circuitBreaker.volumeThreshold,
  timeout: config.mlService.timeoutMs,
  name: "ml-service",
};

const breakers = {
  classifySingle: new CircuitBreaker(_classifySingle, cbOptions),
  classifyBatch: new CircuitBreaker(_classifyBatch, cbOptions),
  pollBatch: new CircuitBreaker(_pollBatch, cbOptions),
  getEmbedding: new CircuitBreaker(_getEmbedding, cbOptions),
  embedBatch: new CircuitBreaker(_embedBatch, cbOptions),
  submitFeedback: new CircuitBreaker(_submitFeedback, cbOptions),
  getModelMetrics: new CircuitBreaker(_getModelMetrics, cbOptions),
  getHealth: new CircuitBreaker(_getHealth, cbOptions),
  triggerRetrain: new CircuitBreaker(_triggerRetrain, cbOptions),
  getRetrainStatus: new CircuitBreaker(_getRetrainStatus, cbOptions),
};

for (const [name, cb] of Object.entries(breakers)) {
  cb.on("open", () => logger.error(`[circuit] ${name} OPEN — falling back`));
  cb.on("halfOpen", () => logger.warn(`[circuit] ${name} HALF_OPEN — probing`));
  cb.on("close", () => logger.info(`[circuit] ${name} CLOSED — recovered`));
}

// ── Exported API ──────────────────────────────────────────────────────────────

export async function classifySingle(
  payload: MLClassifyRequest,
): Promise<MLClassifyResponse> {
  // ── MOCK MODE ──
  if (config.mlService.mockMode) return mockClassifyResponse(payload);

  try {
    return (await breakers.classifySingle.fire(payload)) as MLClassifyResponse;
  } catch {
    logger.warn(
      `mlClient.classifySingle fallback — post_id=${payload.post_id}`,
    );
    return classifyFallback(payload);
  }
}

export async function classifyBatch(
  posts: MLClassifyRequest[],
): Promise<MLBatchResponse> {
  // ── MOCK MODE ── process synchronously and store in local map
  if (config.mlService.mockMode) {
    const jobId = `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const result: MLBatchResult = {
      job_id: jobId,
      status: "complete",
      progress: 1,
      results: posts.map((p) => mockClassifyResponse(p)),
      failed: [],
    };
    mockBatchStore.set(jobId, result);
    return { job_id: jobId, post_count: posts.length, estimated_ms: 0 };
  }

  try {
    return (await breakers.classifyBatch.fire(posts)) as MLBatchResponse;
  } catch {
    throw new AppError(
      503,
      "ML_SERVICE_UNAVAILABLE",
      "Batch classification unavailable",
    );
  }
}

export async function pollBatch(jobId: string): Promise<MLBatchResult> {
  // ── MOCK MODE ──
  if (config.mlService.mockMode) {
    const result = mockBatchStore.get(jobId);
    if (!result)
      throw new AppError(404, "NOT_FOUND", `Mock batch job ${jobId} not found`);
    return result;
  }

  try {
    return (await breakers.pollBatch.fire(jobId)) as MLBatchResult;
  } catch {
    throw new AppError(503, "ML_SERVICE_UNAVAILABLE", "Batch poll unavailable");
  }
}

export async function getEmbedding(
  text: string,
  language: MLLanguage,
): Promise<number[]> {
  // ── MOCK MODE — return zero-vector (acceptable for dev; KB search will return no results)
  if (config.mlService.mockMode) return new Array(768).fill(0);

  try {
    return (await breakers.getEmbedding.fire(text, language)) as number[];
  } catch (err) {
    logger.warn(
      `mlClient.getEmbedding fallback — zero-vector: ${(err as Error).message}`,
    );
    return new Array(768).fill(0);
  }
}

export async function embedBatch(
  documents: MLBatchEmbedItem[],
): Promise<MLBatchEmbedResultItem[]> {
  // ── MOCK MODE ──
  if (config.mlService.mockMode) {
    return documents.map((d) => ({
      doc_id: d.doc_id,
      embedding: new Array(768).fill(0),
    }));
  }

  try {
    return (await breakers.embedBatch.fire(
      documents,
    )) as MLBatchEmbedResultItem[];
  } catch (err) {
    logger.warn(
      `mlClient.embedBatch fallback — zero-vectors: ${(err as Error).message}`,
    );
    return documents.map((d) => ({
      doc_id: d.doc_id,
      embedding: new Array(768).fill(0),
    }));
  }
}

export async function submitFeedback(
  payload: MLFeedbackPayload,
): Promise<MLFeedbackResponse> {
  // ── MOCK MODE ──
  if (config.mlService.mockMode) {
    return {
      accepted: true,
      feedback_id: `mock-fb-${Date.now()}`,
      queued_for_training: true,
    };
  }

  try {
    return (await breakers.submitFeedback.fire(payload)) as MLFeedbackResponse;
  } catch {
    throw new AppError(
      503,
      "ML_SERVICE_UNAVAILABLE",
      "Feedback submission unavailable",
    );
  }
}

export async function getModelMetrics(): Promise<MLMetricsResponse> {
  // ── MOCK MODE ──
  if (config.mlService.mockMode) return mockMetricsResponse();

  try {
    return (await breakers.getModelMetrics.fire()) as MLMetricsResponse;
  } catch {
    throw new AppError(503, "ML_SERVICE_UNAVAILABLE", "Metrics unavailable");
  }
}

export async function getHealth(): Promise<MLHealthResponse> {
  // ── MOCK MODE ──
  if (config.mlService.mockMode) return mockHealthResponse();

  try {
    return (await breakers.getHealth.fire()) as MLHealthResponse;
  } catch {
    throw new AppError(
      503,
      "ML_SERVICE_UNAVAILABLE",
      "Health check unavailable",
    );
  }
}

export async function triggerRetrain(payload: MLRetrainPayload): Promise<void> {
  if (config.mlService.mockMode) {
    logger.info(
      `[mock] Retrain triggered by=${payload.triggered_by} reason=${payload.reason}`,
    );
    return;
  }

  try {
    await breakers.triggerRetrain.fire(payload);
  } catch {
    throw new AppError(
      503,
      "ML_SERVICE_UNAVAILABLE",
      "Retrain trigger unavailable",
    );
  }
}

export async function getRetrainStatus(): Promise<MLRetrainStatus | null> {
  if (config.mlService.mockMode) return null; // no active retrain in mock mode

  try {
    return (await breakers.getRetrainStatus.fire()) as MLRetrainStatus | null;
  } catch {
    throw new AppError(
      503,
      "ML_SERVICE_UNAVAILABLE",
      "Retrain status unavailable",
    );
  }
}

/**
 * Returns the state of the primary classify circuit.
 * Always CLOSED in mock mode — there is no real circuit to track.
 */
export function getCircuitState(): CircuitState {
  if (config.mlService.mockMode) return "CLOSED";
  if (breakers.classifySingle.opened) return "OPEN";
  if (breakers.classifySingle.halfOpen) return "HALF_OPEN";
  return "CLOSED";
}

/**
 * Fetches the live feed of recently-classified posts from the ML service.
 * Bypasses the circuit breaker — this is a polling feed, not a classification
 * call, so a slow response should not count against the classifier's error budget.
 * Returns an empty response on failure so the ingestion service degrades silently.
 */
export async function getRecentPosts(): Promise<MLRecentResponse> {
  if (config.mlService.mockMode) {
    return { posts: [], count: 0, total_since_start: 0 };
  }
  try {
    const { data } = await http.get<MLRecentResponse>('/recent', {
      timeout: 30_000,  // HF free-tier cold-starts can take 15–20 s
    });
    return data;
  } catch (err) {
    logger.warn(`mlClient.getRecentPosts failed: ${(err as Error).message}`);
    return { posts: [], count: 0, total_since_start: 0 };
  }
}

/** Whether the client is running in mock mode. Used for logging/health endpoints. */
export function isMockMode(): boolean {
  return config.mlService.mockMode;
}
