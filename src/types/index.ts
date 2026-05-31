import { Request } from 'express';
import { Types } from 'mongoose';

// ── Enums ─────────────────────────────────────────────────────────────────────

export enum UserRole {
  ANALYST = 'analyst',
  SENIOR_ANALYST = 'senior_analyst',
  SUPERVISOR = 'supervisor',
  SUPER_ADMIN = 'super_admin',
}

export enum PostPlatform {
  TWITTER    = 'twitter',
  FACEBOOK   = 'facebook',
  YOUTUBE    = 'youtube',
  BLUESKY    = 'bluesky',
  SUBMISSION = 'submission',
}

export enum PostLanguage {
  ENGLISH = 'en',
  PIDGIN = 'pcm',
  HAUSA = 'ha',
  YORUBA = 'yo',
  IGBO = 'ig',
}

export enum ClassificationLabel {
  MISINFORMATION = 'misinformation',
  DISINFORMATION = 'disinformation',
  FACTUAL = 'factual',
  IRRELEVANT = 'irrelevant',
  PENDING = 'pending',
}

export enum HITLPriority {
  HIGH = 'high',
  STANDARD = 'standard',
}

export enum HITLStatus {
  PENDING = 'pending',
  APPROVED = 'approved',
  REJECTED = 'rejected',
  OVERRIDDEN = 'overridden',
}

export enum AlertSeverity {
  HIGH = 'high',
  MEDIUM = 'medium',
  LOW = 'low',
  INFO = 'info',
}

export enum AlertTriggerType {
  SURGE = 'surge',
  PSI_DRIFT = 'psi_drift',
  MODEL_UPDATE = 'model_update',
  CONNECTOR_ERROR = 'connector_error',
  OVERRIDE_RATE = 'override_rate',
}

export enum AuditAction {
  AUTO_CLASSIFY = 'AUTO_CLASSIFY',
  HITL_APPROVE = 'HITL_APPROVE',
  HITL_REJECT = 'HITL_REJECT',
  HITL_OVERRIDE = 'HITL_OVERRIDE',
  ANALYST_FEEDBACK = 'ANALYST_FEEDBACK',
  TRIGGER_RETRAIN = 'TRIGGER_RETRAIN',
  USER_LOGIN = 'USER_LOGIN',
  USER_LOGOUT = 'USER_LOGOUT',
  KB_UPLOAD = 'KB_UPLOAD',
  KB_DELETE = 'KB_DELETE',
  DISPATCH_SENT = 'DISPATCH_SENT',
}

export enum BatchJobStatus {
  PENDING = 'pending',
  PROCESSING = 'processing',
  COMPLETE = 'complete',
  FAILED = 'failed',
}

export enum RetrainingType {
  MONTHLY_FINE_TUNE = 'monthly_fine_tune',
  LANGUAGE_AUGMENTATION = 'language_augmentation',
  ON_DEMAND = 'on_demand',
}

export enum RetrainingStatus {
  PROMOTED = 'promoted',
  REJECTED = 'rejected',
  ARCHIVED = 'archived',
  IN_PROGRESS = 'in_progress',
}

// ── Express augmentation ──────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
  user: {
    id: string;
    role: UserRole;
  };
}

// ── Pagination ────────────────────────────────────────────────────────────────

export interface PaginationQuery {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ── WebSocket events ──────────────────────────────────────────────────────────

export enum WsEvent {
  MODEL_UPDATE = 'MODEL_UPDATE',
  MODEL_DRIFT_ALERT = 'MODEL_DRIFT_ALERT',
  ML_CIRCUIT_STATE_CHANGE = 'ML_CIRCUIT_STATE_CHANGE',
  NEW_ALERT = 'NEW_ALERT',
  HITL_NEW_ITEM = 'HITL_NEW_ITEM',
}

// ── Misc ──────────────────────────────────────────────────────────────────────

export type ObjectId = Types.ObjectId;
