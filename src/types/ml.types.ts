// Integration contract with the Python FastAPI ML service.
// Field names mirror the Python service's JSON schemas exactly — do not rename.

export enum MLLanguage {
  EN  = 'en',
  PCM = 'pcm',
  HA  = 'ha',
  YO  = 'yo',
  IG  = 'ig',
}

export enum MLPlatform {
  TWITTER    = 'twitter',
  FACEBOOK   = 'facebook',
  YOUTUBE    = 'youtube',
  SUBMISSION = 'submission',
}

export enum MLLabel {
  MISINFORMATION  = 'misinformation',
  DISINFORMATION  = 'disinformation',
  FACTUAL         = 'factual',
  IRRELEVANT      = 'irrelevant',
}

// ── Classify ─────────────────────────────────────────────────────────────────

export interface MLClassifyRequest {
  post_id:      string;
  content:      string;
  language:     MLLanguage;
  platform:     MLPlatform;
  context?:     string;
  kb_snippets?: string[];
}

export interface MLKbEvidence {
  doc_id:  string;
  title:   string;
  snippet: string;
  score:   number;
}

export interface MLAlternative {
  label:      string;
  confidence: number;
}

export interface MLClassifyResponse {
  post_id:       string;
  label:         MLLabel;
  confidence:    number;
  entropy:       number;
  model_version: string;
  alternatives:  MLAlternative[];
  processing_ms: number;
  kb_evidence:   MLKbEvidence[];
  fallback?:     boolean;
}

// ── Batch ─────────────────────────────────────────────────────────────────────

export interface MLBatchRequest {
  posts: MLClassifyRequest[];
}

export interface MLBatchResponse {
  job_id:       string;
  accepted:     number;
  estimated_ms: number;
}

export interface MLBatchResult {
  job_id:   string;
  status:   'pending' | 'processing' | 'complete' | 'failed';
  progress: number;
  results:  MLClassifyResponse[];
  failed:   Array<{ post_id: string; error: string }>;
}

// ── Embeddings ────────────────────────────────────────────────────────────────

export interface MLEmbedRequest {
  text:     string;
  language: MLLanguage;
}

export interface MLEmbedResponse {
  embedding:     number[];
  model:         string;
  processing_ms: number;
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export interface MLFeedbackPayload {
  post_id:         string;
  original_label:  MLLabel;
  corrected_label: MLLabel;
  analyst_role:    string;
  confidence_was:  number;
  notes?:          string;
}

export interface MLFeedbackResponse {
  accepted:              boolean;
  feedback_id:           string;
  queued_for_training:   boolean;
  training_queue_size:   number;
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export interface MLMetricsLanguage {
  macro_f1:     number;
  psi:          number;
  sample_count: number;
}

export interface MLMetricsResponse {
  model_version: string;
  overall: {
    macro_f1:        number;
    recall:          number;
    precision:       number;
    inference_ms_p95: number;
  };
  per_language:   Record<MLLanguage, MLMetricsLanguage>;
  last_retrain:   string;
  feedback_queue: number;
}

// ── Health ────────────────────────────────────────────────────────────────────

export interface MLHealthResponse {
  status:        'ok' | 'degraded' | 'offline';
  model_loaded:  boolean;
  model_version: string;
  device:        string;
  uptime_s:      number;
}

// ── Retrain ───────────────────────────────────────────────────────────────────

export interface MLRetrainPayload {
  triggered_by: string;
  reason:       string;
}

export interface MLRetrainStatus {
  status:         string;
  progress:       number;
  eta_minutes:    number;
  current_epoch:  number;
  total_epochs:   number;
}

// ── Circuit breaker state (exposed by mlClient) ───────────────────────────────

export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';
