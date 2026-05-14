import mongoose, { Document, Schema } from 'mongoose';
import { RetrainingType, RetrainingStatus } from '../types';

export interface IRetrainingHistory extends Document {
  runId: string;
  modelVersionBefore: string;
  modelVersionAfter?: string;
  type: RetrainingType;
  f1Before: number;
  f1After?: number;
  status: RetrainingStatus;
  triggeredBy: string;
  reason?: string;
  startedAt: Date;
  completedAt?: Date;
  totalEpochs?: number;
}

const retrainingHistorySchema = new Schema<IRetrainingHistory>(
  {
    runId: { type: String, required: true, unique: true },
    modelVersionBefore: { type: String, required: true },
    modelVersionAfter: { type: String },
    type: {
      type: String,
      enum: Object.values(RetrainingType),
      required: true,
    },
    f1Before: { type: Number, required: true },
    f1After: { type: Number },
    status: {
      type: String,
      enum: Object.values(RetrainingStatus),
      default: RetrainingStatus.IN_PROGRESS,
    },
    triggeredBy: { type: String, required: true },
    reason: { type: String },
    startedAt: { type: Date, required: true, default: Date.now },
    completedAt: { type: Date },
    totalEpochs: { type: Number },
  },
  { timestamps: true }
);

retrainingHistorySchema.index({ status: 1, startedAt: -1 });

export const RetrainingHistory = mongoose.model<IRetrainingHistory>(
  'RetrainingHistory',
  retrainingHistorySchema
);
