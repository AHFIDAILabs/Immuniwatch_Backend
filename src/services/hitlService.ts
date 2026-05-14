import { FilterQuery } from 'mongoose';

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

// ── List reviews ──────────────────────────────────────────────────────────────

export async function listReviews(opts: {
  priority?: HITLPriority;
  status?:   HITLStatus;
  page:      number;
  limit:     number;
}) {
  const filter: FilterQuery<typeof HITLReview> = {};
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

export async function approveReview(reviewId: string, analystId: string, analystRole: string) {
  const review = await HITLReview.findById(reviewId);
  if (!review)                              throw new AppError(404, 'NOT_FOUND', 'Review not found');
  if (review.status !== HITLStatus.PENDING) throw new AppError(400, 'INVALID_STATE', 'Review already actioned');

  review.status     = HITLStatus.APPROVED;
  review.reviewedBy = analystId as unknown as typeof review.reviewedBy;
  review.reviewedAt = new Date();
  await review.save();

  await AuditLog.create({
    actor:        analystId,
    action:       AuditAction.HITL_APPROVE,
    resourceType: 'HITLReview',
    resourceId:   review._id.toString(),
  });

  return review;
}

// ── Override (relabel) ────────────────────────────────────────────────────────

export async function overrideReview(
  reviewId:       string,
  analystId:      string,
  analystRole:    string,
  newLabel:       ClassificationLabel,
  editedResponse: string,
) {
  const review = await HITLReview.findById(reviewId).populate('classificationId');
  if (!review) throw new AppError(404, 'NOT_FOUND', 'Review not found');

  const cls = review.classificationId as unknown as InstanceType<typeof Classification>;
  if (!cls)  throw new AppError(400, 'INVALID_STATE', 'Review has no classification');

  review.status         = HITLStatus.OVERRIDDEN;
  review.reviewedBy     = analystId as unknown as typeof review.reviewedBy;
  review.reviewedAt     = new Date();
  review.overriddenLabel = newLabel;
  review.approvedResponse = editedResponse;
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
    newValue:     { label: newLabel, approvedResponse: editedResponse },
  });

  return review;
}

// ── Reject ────────────────────────────────────────────────────────────────────

export async function rejectReview(reviewId: string, analystId: string, analystRole: string) {
  const review = await HITLReview.findById(reviewId);
  if (!review) throw new AppError(404, 'NOT_FOUND', 'Review not found');

  review.status     = HITLStatus.REJECTED;
  review.reviewedBy = analystId as unknown as typeof review.reviewedBy;
  review.reviewedAt = new Date();
  await review.save();

  // Submit negative training signal
  await submitAnalystFeedback(reviewId, analystId);

  await AuditLog.create({
    actor:        analystId,
    action:       AuditAction.HITL_REJECT,
    resourceType: 'HITLReview',
    resourceId:   review._id.toString(),
  });

  return review;
}
