// Integration contract with the Python FastAPI ML service.
// Field names mirror the Python service's JSON schemas exactly — do not rename.
//
// Changes vs. original:
//   • MLMetricsLanguage: added `recall`, removed `sample_count` (not in API v1.0.0)
//   • MLHealthResponse.status: corrected to 'ok' | 'unavailable' (per §4.1 docs)
//   • MLBatchResult.status: fixed 'completed' → 'complete' (per §4.4 docs) — THIS
//     was causing pollBatchResult to silently never finalize batch jobs in the DB
//   • MLRetrainPayload: added optional min_samples (per §4.9 docs)
//   • MLFeedbackResponse: removed undocumented training_queue_size field
//   • MLRetrainStatus.status: typed as strict union matching §4.10 docs

export enum MLLanguage {
  EN = "en",
  PCM = "pcm",
  HA = "ha",
  YO = "yo",
  IG = "ig",
}

export enum MLPlatform {
  TWITTER    = "twitter",
  FACEBOOK   = "facebook",
  YOUTUBE    = "youtube",
  BLUESKY    = "bluesky",
  SUBMISSION = "submission",
}

// Phase 1 spec: misinformation | factual | irrelevant only.
// disinformation was removed from the ML service output in Phase 1.
export enum MLLabel {
  MISINFORMATION = "misinformation",
  FACTUAL = "factual",
  IRRELEVANT = "irrelevant",
}

// ── Classify ──────────────────────────────────────────────────────────────────

export interface MLClassifyRequest {
  post_id:     string;
  content:     string;
  language:    MLLanguage | null;
  platform:    MLPlatform;
  context?:    string | null;
  location?:   string | null;
  kb_snippets?: string[];
}

// ── Recent live feed ──────────────────────────────────────────────────────────

export interface MLRecentPost {
  post_id:       string;
  content_snippet: string;
  label:         MLLabel;
  confidence:    number;
  entropy:       number;
  language:      string | null;
  state:         string | null;
  platform:      string;             // "youtube" | "bluesky"
  classified_at: string;             // ISO-8601
}

export interface MLRecentResponse {
  posts:             MLRecentPost[];
  count:             number;
  total_since_start: number;
}

export interface MLKbEvidence {
  doc_id: string;
  title: string;
  snippet: string;
  score: number;
}

export interface MLAlternative {
  label: string;
  confidence: number;
}

export interface MLClassifyResponse {
  post_id: string;
  label: MLLabel;
  confidence: number;
  entropy: number;
  model_version: string;
  language?: string;
  state?: string;
  alternatives: MLAlternative[];
  processing_ms: number;
  kb_evidence: MLKbEvidence[];
  fallback?: boolean;
  counter_response_queued?: boolean; // true when ML auto-generated a counter-narrative
}

// ── Counter-narrative ─────────────────────────────────────────────────────────

export interface MLCounterNarrativeItem {
  post_id:           string;
  platform:          string;
  content_snippet?:  string;
  counter_narrative: string;
  created_at?:       string;
  status?:           'pending' | 'deployed' | 'skipped';
}

/** POST /counter-narrative/generate */
export interface MLCounterNarrativeGenerateRequest {
  post_id:  string;
  content:  string;
  platform: string;
  language: string | null;
}

/** Response from POST /counter-narrative/generate and GET /counter-narrative/{post_id} */
export interface MLCounterNarrativeGenerateResponse {
  post_id:          string;
  generated_short:  string;   // ≤280 chars — pre-fill the textarea
  generated_medium: string;   // ≤200 words
  generated_long:   string;   // ≤500 words
  sources:          string[];
  status:           string;
}

export interface MLCounterNarrativeDeployPayload {
  approved_text: string;
}

// ── Batch classify ────────────────────────────────────────────────────────────

export interface MLBatchRequest {
  posts: MLClassifyRequest[];
}

export interface MLBatchResponse {
  job_id: string;
  post_count: number;
  estimated_ms: number;
}

// IMPORTANT: the ML service returns status "complete" (NOT "completed").
// The original type had "completed" which meant pollBatchResult's
//   `result.status !== 'completed'` check was ALWAYS true — batch jobs
//   never finalized in the database.
export interface MLBatchResult {
  job_id: string;
  status: "pending" | "processing" | "complete" | "failed";
  progress: number;
  results: MLClassifyResponse[] | null;
  failed: Array<{ post_id: string; error: string }>;
}

// ── Embeddings ────────────────────────────────────────────────────────────────

export interface MLEmbedRequest {
  text: string;
  language: MLLanguage;
}

export interface MLEmbedResponse {
  embedding: number[];
  model: string;
  processing_ms: number;
}

export interface MLBatchEmbedItem {
  doc_id: string;
  text: string;
  language: MLLanguage;
}

export interface MLBatchEmbedRequest {
  items: MLBatchEmbedItem[];
}

export interface MLBatchEmbedResultItem {
  doc_id: string;
  embedding: number[];
}

export interface MLBatchEmbedResponse {
  results: MLBatchEmbedResultItem[];
  processing_ms: number;
}

// ── Feedback ──────────────────────────────────────────────────────────────────

export interface MLFeedbackPayload {
  post_id: string;
  original_label: MLLabel;
  corrected_label: MLLabel;
  analyst_role: string;
  confidence_was: number;
  notes?: string;
}

export interface MLFeedbackResponse {
  accepted: boolean;
  feedback_id: string;
  queued_for_training: boolean;
  // training_queue_size removed — not in API v1.0.0 docs
}

// ── Metrics ───────────────────────────────────────────────────────────────────

// API §4.7: by_language returns macro_f1, recall, psi only.
// sample_count is NOT returned — removed from this interface.
// recall was also missing from the original type.
export interface MLMetricsLanguage {
  macro_f1: number;
  recall: number;
  psi: number;
}

export interface MLMetricsResponse {
  model_version: string;
  overall: {
    macro_f1: number;
    recall: number;
    precision: number;
    latency_p95_ms: number;
  };
  by_language: Record<MLLanguage, MLMetricsLanguage>;
  computed_at: string;
}

// ── Health ────────────────────────────────────────────────────────────────────

// API §4.1: status is "ok" on 200, "unavailable" on 503.
// "degraded" kept for forward-compatibility with future service versions.
export interface MLHealthResponse {
  status: "ok" | "unavailable" | "degraded";
  model_loaded: boolean;
  model_version: string;
  device: string;
  uptime_s: number;
}

// ── Retrain ───────────────────────────────────────────────────────────────────

export interface MLRetrainPayload {
  triggered_by: string;
  reason: string;
  min_samples?: number; // optional per §4.9 — defaults to service-side minimum
}

// API §4.10: status is one of these exact strings
export interface MLRetrainStatus {
  status: "queued" | "training" | "evaluating" | "complete" | "failed";
  progress: number;
  eta_minutes: number;
  current_epoch: number;
  total_epochs: number;
  job_id?: string;
  model_version?: string; // in-progress version candidate (e.g. "v1.0.1-rc")
  started_at?: string; // ISO string
  completed_at?: string; // ISO string
}

// ── Circuit breaker state (exposed by mlClient) ───────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";
