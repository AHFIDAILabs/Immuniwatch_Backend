/**
 * mlClient — the ONLY file that makes HTTP calls to the Python ML service.
 * All other services must go through classificationService, kbService, or
 * modelHealthService — never import mlClient directly from anywhere else.
 *
 * Resilience layers:
 *   1. axios-retry  — retries transient errors (429, 5xx) with exponential back-off
 *   2. opossum      — circuit breaker; trips to OPEN after threshold failures,
 *                     returns safe fallbacks so the HITL queue absorbs the load
 */

import axios, { AxiosInstance } from 'axios';
import axiosRetry from 'axios-retry';
import CircuitBreaker from 'opossum';

import { config } from '../config';
import { AppError } from '../utils/AppError';
import { logger } from '../utils/logger';
import {
  CircuitState,
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
  MLRetrainPayload,
  MLRetrainStatus,
} from '../types/ml.types';

// ── Axios instance ────────────────────────────────────────────────────────────

const http: AxiosInstance = axios.create({
  baseURL: config.mlService.url,
  timeout: config.mlService.timeoutMs,
  headers: {
    'Content-Type':  'application/json',
    'X-ML-API-Key':  config.mlService.apiKey,
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

// ── Fallback builders ─────────────────────────────────────────────────────────

function classifyFallback(req: MLClassifyRequest): MLClassifyResponse {
  return {
    post_id:       req.post_id,
    label:         MLLabel.FACTUAL,   // neutral fallback — HITL will decide
    confidence:    0,
    entropy:       1,
    model_version: 'fallback',
    alternatives:  [],
    processing_ms: 0,
    kb_evidence:   [],
    fallback:      true,
  };
}

// ── Raw HTTP calls (wrapped by circuit breaker below) ─────────────────────────

async function _classifySingle(payload: MLClassifyRequest): Promise<MLClassifyResponse> {
  const { data } = await http.post<MLClassifyResponse>('/classify', payload);
  return data;
}

async function _classifyBatch(posts: MLClassifyRequest[]): Promise<MLBatchResponse> {
  const { data } = await http.post<MLBatchResponse>('/classify/batch', { posts });
  return data;
}

async function _pollBatch(jobId: string): Promise<MLBatchResult> {
  const { data } = await http.get<MLBatchResult>(`/classify/batch/${jobId}`);
  return data;
}

async function _getEmbedding(text: string, language: MLLanguage): Promise<number[]> {
  const { data } = await http.post<{ embedding: number[] }>('/embed', { text, language });
  return data.embedding;
}

async function _submitFeedback(payload: MLFeedbackPayload): Promise<MLFeedbackResponse> {
  const { data } = await http.post<MLFeedbackResponse>('/feedback', payload);
  return data;
}

async function _getModelMetrics(): Promise<MLMetricsResponse> {
  const { data } = await http.get<MLMetricsResponse>('/metrics');
  return data;
}

async function _getHealth(): Promise<MLHealthResponse> {
  const { data } = await http.get<MLHealthResponse>('/health');
  return data;
}

async function _triggerRetrain(payload: MLRetrainPayload): Promise<void> {
  await http.post('/retrain', payload);
}

async function _getRetrainStatus(): Promise<MLRetrainStatus> {
  const { data } = await http.get<MLRetrainStatus>('/retrain/status');
  return data;
}

// ── Circuit breaker ───────────────────────────────────────────────────────────

const cbOptions: CircuitBreaker.Options = {
  errorThresholdPercentage: config.mlService.circuitBreaker.errorThresholdPercent,
  resetTimeout:             config.mlService.circuitBreaker.resetTimeoutMs,
  volumeThreshold:          config.mlService.circuitBreaker.volumeThreshold,
  timeout:                  config.mlService.timeoutMs,
  name:                     'ml-service',
};

// One breaker per exported function so a /metrics outage doesn't trip /classify
const breakers = {
  classifySingle:   new CircuitBreaker(_classifySingle,   cbOptions),
  classifyBatch:    new CircuitBreaker(_classifyBatch,    cbOptions),
  pollBatch:        new CircuitBreaker(_pollBatch,        cbOptions),
  getEmbedding:     new CircuitBreaker(_getEmbedding,     cbOptions),
  submitFeedback:   new CircuitBreaker(_submitFeedback,   cbOptions),
  getModelMetrics:  new CircuitBreaker(_getModelMetrics,  cbOptions),
  getHealth:        new CircuitBreaker(_getHealth,        cbOptions),
  triggerRetrain:   new CircuitBreaker(_triggerRetrain,   cbOptions),
  getRetrainStatus: new CircuitBreaker(_getRetrainStatus, cbOptions),
};

// Log state transitions for observability
for (const [name, cb] of Object.entries(breakers)) {
  cb.on('open',     () => logger.error(`[circuit] ${name} OPEN — falling back`));
  cb.on('halfOpen', () => logger.warn(`[circuit] ${name} HALF_OPEN — probing`));
  cb.on('close',    () => logger.info(`[circuit] ${name} CLOSED — recovered`));
}

// ── Exported API ──────────────────────────────────────────────────────────────

export async function classifySingle(
  payload: MLClassifyRequest,
): Promise<MLClassifyResponse> {
  try {
    return await breakers.classifySingle.fire(payload) as MLClassifyResponse;
  } catch {
    logger.warn(`mlClient.classifySingle fallback — post_id=${payload.post_id}`);
    return classifyFallback(payload);
  }
}

export async function classifyBatch(
  posts: MLClassifyRequest[],
): Promise<MLBatchResponse> {
  try {
    return await breakers.classifyBatch.fire(posts) as MLBatchResponse;
  } catch (err) {
    throw new AppError(503, 'ML_SERVICE_UNAVAILABLE', 'Batch classification unavailable');
  }
}

export async function pollBatch(jobId: string): Promise<MLBatchResult> {
  try {
    return await breakers.pollBatch.fire(jobId) as MLBatchResult;
  } catch {
    throw new AppError(503, 'ML_SERVICE_UNAVAILABLE', 'Batch poll unavailable');
  }
}

export async function getEmbedding(
  text: string,
  language: MLLanguage,
): Promise<number[]> {
  try {
    return await breakers.getEmbedding.fire(text, language) as number[];
  } catch (err) {
    logger.warn(`mlClient.getEmbedding fallback — returning zero-vector: ${(err as Error).message}`);
    return new Array(768).fill(0);
  }
}

export async function submitFeedback(
  payload: MLFeedbackPayload,
): Promise<MLFeedbackResponse> {
  try {
    return await breakers.submitFeedback.fire(payload) as MLFeedbackResponse;
  } catch {
    throw new AppError(503, 'ML_SERVICE_UNAVAILABLE', 'Feedback submission unavailable');
  }
}

export async function getModelMetrics(): Promise<MLMetricsResponse> {
  try {
    return await breakers.getModelMetrics.fire() as MLMetricsResponse;
  } catch {
    throw new AppError(503, 'ML_SERVICE_UNAVAILABLE', 'Metrics unavailable');
  }
}

export async function getHealth(): Promise<MLHealthResponse> {
  try {
    return await breakers.getHealth.fire() as MLHealthResponse;
  } catch {
    throw new AppError(503, 'ML_SERVICE_UNAVAILABLE', 'Health check unavailable');
  }
}

export async function triggerRetrain(payload: MLRetrainPayload): Promise<void> {
  try {
    await breakers.triggerRetrain.fire(payload);
  } catch {
    throw new AppError(503, 'ML_SERVICE_UNAVAILABLE', 'Retrain trigger unavailable');
  }
}

export async function getRetrainStatus(): Promise<MLRetrainStatus> {
  try {
    return await breakers.getRetrainStatus.fire() as MLRetrainStatus;
  } catch {
    throw new AppError(503, 'ML_SERVICE_UNAVAILABLE', 'Retrain status unavailable');
  }
}

/**
 * Returns the state of the primary classify circuit — used by the pipeline
 * status endpoint and the Settings screen "Test connection" button.
 */
export function getCircuitState(): CircuitState {
  if (breakers.classifySingle.opened)   return 'OPEN';
  if (breakers.classifySingle.halfOpen) return 'HALF_OPEN';
  return 'CLOSED';
}
