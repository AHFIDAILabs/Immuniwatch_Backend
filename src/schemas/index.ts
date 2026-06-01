import { z } from 'zod';

// ── Shared enums ──────────────────────────────────────────────────────────────

const PostPlatform   = z.enum(['twitter', 'facebook', 'youtube', 'submission']);
const PostLanguage   = z.enum(['en', 'pcm', 'ha', 'yo', 'ig']);
const UserRole       = z.enum(['analyst', 'senior_analyst', 'supervisor', 'super_admin']);
const ClassificationLabel = z.enum(['misinformation', 'disinformation', 'factual', 'irrelevant', 'pending']);

// ── Auth ──────────────────────────────────────────────────────────────────────

export const loginSchema = z.object({
  email:    z.string().email('Must be a valid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required'),
});

// ── Posts ─────────────────────────────────────────────────────────────────────

export const ingestPostSchema = z.object({
  content:       z.string().min(1, 'Content is required').max(10_000, 'Content too long'),
  platform:      PostPlatform,
  language:      PostLanguage,
  externalId:    z.string().max(256).optional(),
  authorHandle:  z.string().max(128).optional(),
  mediaUrls:     z.array(z.string().url()).max(20).optional(),
});

// ── HITL ──────────────────────────────────────────────────────────────────────

export const overrideSchema = z.object({
  // Accept either field name — frontend sends overrideLabel, some callers may send newLabel
  overrideLabel:  ClassificationLabel.optional(),
  newLabel:        ClassificationLabel.optional(),
  editedResponse: z.string().max(5_000).optional(),
  reviewerNote:   z.string().max(1_000).optional(),
}).refine(
  (d) => d.overrideLabel != null || d.newLabel != null,
  { message: 'overrideLabel is required', path: ['overrideLabel'] },
);

export const rejectSchema = z.object({
  reviewerNote: z.string().max(1_000).optional(),
});

// ── Users ─────────────────────────────────────────────────────────────────────

export const inviteUserSchema = z.object({
  name:           z.string().min(1, 'Name is required').max(128),
  email:          z.string().email('Must be a valid email address'),
  role:           UserRole,
  organizationId: z.string().optional(),  // super_admin specifies target org
});

export const updateUserSchema = z.object({
  name:        z.string().min(1).max(128).optional(),
  role:        UserRole.optional(),
  active:      z.boolean().optional(),
  newPassword: z.string().min(8).max(128).optional(),
}).refine(
  (d) => d.name != null || d.role != null || d.active != null || d.newPassword != null,
  { message: 'At least one field (name, role, active, newPassword) must be provided' },
);

// ── Knowledge Base ────────────────────────────────────────────────────────────

export const uploadKbSchema = z.object({
  title:     z.string().min(1, 'Title is required').max(256),
  source:    z.string().min(1, 'Source is required').max(128),
  language:  PostLanguage,
  immediate: z.string().optional(),   // multipart sends strings; parsed as boolean in controller
});

// ── Admin password reset ──────────────────────────────────────────────────────

export const resetPasswordSchema = z.object({
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
});

// ── Model Health ──────────────────────────────────────────────────────────────

export const triggerRetrainSchema = z.object({
  reason: z.string().max(500).optional(),
});
