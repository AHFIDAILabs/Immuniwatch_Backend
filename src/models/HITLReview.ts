import mongoose, { Document, Schema } from 'mongoose';
import { HITLPriority, HITLStatus, ClassificationLabel, ObjectId } from '../types';

export interface IHITLReview extends Document {
  postId: ObjectId;
  classificationId: ObjectId;
  priority: HITLPriority;
  status: HITLStatus;
  assignedTo?: ObjectId;
  reviewedBy?: ObjectId;
  reviewedAt?: Date;
  notes?: string;
  overriddenLabel?: ClassificationLabel;
  proposedResponse?: string;
  approvedResponse?: string;
  dispatchedAt?: Date;
  dispatchStatus?: 'pending' | 'sent' | 'retrying' | 'failed';
}

const hitlReviewSchema = new Schema<IHITLReview>(
  {
    postId: { type: Schema.Types.ObjectId, ref: 'Post', required: true },
    classificationId: { type: Schema.Types.ObjectId, ref: 'Classification', required: true },
    priority: {
      type: String,
      enum: Object.values(HITLPriority),
      default: HITLPriority.STANDARD,
    },
    status: {
      type: String,
      enum: Object.values(HITLStatus),
      default: HITLStatus.PENDING,
    },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date },
    notes: { type: String },
    overriddenLabel: {
      type: String,
      enum: Object.values(ClassificationLabel),
    },
    proposedResponse: { type: String },
    approvedResponse: { type: String },
    dispatchedAt: { type: Date },
    dispatchStatus: {
      type: String,
      enum: ['pending', 'sent', 'retrying', 'failed'],
    },
  },
  { timestamps: true }
);

hitlReviewSchema.index({ status: 1, priority: -1, createdAt: 1 });
hitlReviewSchema.index({ postId: 1 });
hitlReviewSchema.index({ reviewedBy: 1 });

export const HITLReview = mongoose.model<IHITLReview>('HITLReview', hitlReviewSchema);
