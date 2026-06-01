import mongoose, { FilterQuery } from 'mongoose';

import { config } from '../config';
import { AuditLog } from '../models/AuditLog';
import { Classification } from '../models/Classification';
import { HITLReview } from '../models/HITLReview';
import { Post } from '../models/Post';
import {
  AuditAction,
  ClassificationLabel,
  HITLPriority,
  HITLStatus,
} from '../types';
import { AppError } from '../utils/AppError';
import { submitAnalystFeedback } from './classificationService';

// ── Shared populate helper ─────────────────────────────────────────────────────
// Always return a fully-populated review so the frontend can render content
// in the DispatchModal without a second fetch.

async function populateReview(reviewId: mongoose.Types.ObjectId | string) {
  return HITLReview.findById(reviewId)
    .populate('postId classificationId')
    .lean();
}

// ── List reviews ──────────────────────────────────────────────────────────────

export async function listReviews(opts: {
  priority?:  HITLPriority;
  status?:    HITLStatus;
  page:       number;
  limit:      number;
  orgFilter?: Record<string, unknown>;
}) {
  const filter: FilterQuery<typeof HITLReview> = { ...(opts.orgFilter ?? {}) };
  if (opts.priority) filter.priority = opts.priority;
  if (opts.status)   filter.status   = opts.status;

  const [items, total] = await Promise.all([
    HITLReview.find(filter)
      .sort({ priority: -1, createdAt: 1 })
      .skip((opts.page - 1) * opts.limit)
      .limit(opts.limit)
      .populate('postId classificationId')
      .lean(),
    HITLReview.countDocuments(filter),
  ]);

  return {
    data:       items,
    total,
    page:       opts.page,
    limit:      opts.limit,
    totalPages: Math.ceil(total / opts.limit),
  };
}

// ── Approve ───────────────────────────────────────────────────────────────────

export async function approveReview(
  reviewId:    string,
  analystId:   string,
  analystRole: string,
  reviewerNote?: string,
) {
  const review = await HITLReview.findById(reviewId);
  if (!review)                              throw new AppError(404, 'NOT_FOUND',      'Review not found');
  if (review.status !== HITLStatus.PENDING) throw new AppError(400, 'INVALID_STATE',  'Review has already been actioned');

  review.status     = HITLStatus.APPROVED;
  review.reviewedBy = new mongoose.Types.ObjectId(analystId) as unknown as typeof review.reviewedBy;
  review.reviewedAt = new Date();
  if (reviewerNote) review.reviewerNote = reviewerNote;
  await review.save();

  await AuditLog.create({
    actor:        analystId,
    action:       AuditAction.HITL_APPROVE,
    resourceType: 'HITLReview',
    resourceId:   review._id.toString(),
    newValue:     { reviewerNote },
  });

  return populateReview(review._id);
}

// ── Override (relabel) ────────────────────────────────────────────────────────

export async function overrideReview(
  reviewId:       string,
  analystId:      string,
  analystRole:    string,
  newLabel:       ClassificationLabel,
  editedResponse: string,
  reviewerNote?:  string,
) {
  const review = await HITLReview.findById(reviewId).populate('classificationId');
  if (!review) throw new AppError(404, 'NOT_FOUND', 'Review not found');
  if (review.status !== HITLStatus.PENDING) throw new AppError(400, 'INVALID_STATE', 'Review has already been actioned');

  const cls = review.classificationId as unknown as InstanceType<typeof Classification>;
  if (!cls)  throw new AppError(400, 'INVALID_STATE', 'Review has no classification');

  review.status           = HITLStatus.OVERRIDDEN;
  review.reviewedBy       = new mongoose.Types.ObjectId(analystId) as unknown as typeof review.reviewedBy;
  review.reviewedAt       = new Date();
  review.overriddenLabel  = newLabel;
  review.approvedResponse = editedResponse;
  if (reviewerNote) review.reviewerNote = reviewerNote;
  await review.save();

  await Classification.findByIdAndUpdate(cls._id, { label: newLabel });

  // Close the HITL training cycle — submit correction to ML service
  await submitAnalystFeedback(reviewId, analystId);

  await AuditLog.create({
    actor:        analystId,
    action:       AuditAction.HITL_OVERRIDE,
    resourceType: 'HITLReview',
    resourceId:   review._id.toString(),
    oldValue:     { label: cls.label },
    newValue:     { label: newLabel, approvedResponse: editedResponse, reviewerNote },
  });

  return populateReview(review._id);
}

// ── Reject ────────────────────────────────────────────────────────────────────

export async function rejectReview(
  reviewId:    string,
  analystId:   string,
  analystRole: string,
  reviewerNote?: string,
) {
  const review = await HITLReview.findById(reviewId);
  if (!review) throw new AppError(404, 'NOT_FOUND', 'Review not found');
  if (review.status !== HITLStatus.PENDING) throw new AppError(400, 'INVALID_STATE', 'Review has already been actioned');

  review.status     = HITLStatus.REJECTED;
  review.reviewedBy = new mongoose.Types.ObjectId(analystId) as unknown as typeof review.reviewedBy;
  review.reviewedAt = new Date();
  if (reviewerNote) review.reviewerNote = reviewerNote;
  await review.save();

  // Submit negative training signal
  await submitAnalystFeedback(reviewId, analystId);

  await AuditLog.create({
    actor:        analystId,
    action:       AuditAction.HITL_REJECT,
    resourceType: 'HITLReview',
    resourceId:   review._id.toString(),
    newValue:     { reviewerNote },
  });

  return populateReview(review._id);
}
