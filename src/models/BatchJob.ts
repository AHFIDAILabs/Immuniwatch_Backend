import mongoose, { Document, Schema } from 'mongoose';
import { BatchJobStatus, ObjectId } from '../types';

export interface IBatchJob extends Document {
  jobId: string;
  postIds: string[];
  status: BatchJobStatus;
  triggeredBy: ObjectId;
  progress: number;
  processedCount: number;
  failedCount: number;
  completedAt?: Date;
}

const batchJobSchema = new Schema<IBatchJob>(
  {
    jobId: { type: String, required: true, unique: true },
    postIds: [{ type: String, required: true }],
    status: {
      type: String,
      enum: Object.values(BatchJobStatus),
      default: BatchJobStatus.PENDING,
    },
    triggeredBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    progress: { type: Number, default: 0, min: 0, max: 1 },
    processedCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

batchJobSchema.index({ status: 1, createdAt: -1 });
batchJobSchema.index({ triggeredBy: 1 });

export const BatchJob = mongoose.model<IBatchJob>('BatchJob', batchJobSchema);
