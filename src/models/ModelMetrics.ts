import mongoose, { Document, Schema } from 'mongoose';
import { PostLanguage } from '../types';

export interface ILanguageMetrics {
  macroF1: number;
  psi: number;
  sampleCount: number;
}

export interface IModelMetrics extends Document {
  modelVersion: string;
  macroF1: number;
  recall: number;
  precision: number;
  inferenceP95ms: number;
  perLanguage: Partial<Record<PostLanguage, ILanguageMetrics>>;
  lastRetrain: Date;
  feedbackQueue: number;
  promoted: boolean;
  stale?: boolean;
  updatedAt?: Date;
  createdAt?: Date;
}

const languageMetricsSchema = new Schema<ILanguageMetrics>(
  {
    macroF1: { type: Number, required: true },
    psi: { type: Number, required: true },
    sampleCount: { type: Number, required: true },
  },
  { _id: false }
);

const modelMetricsSchema = new Schema<IModelMetrics>(
  {
    modelVersion: { type: String, required: true, unique: true },
    macroF1: { type: Number, required: true },
    recall: { type: Number, required: true },
    precision: { type: Number, required: true },
    inferenceP95ms: { type: Number, required: true },
    perLanguage: {
      type: Map,
      of: languageMetricsSchema,
      default: {},
    },
    lastRetrain: { type: Date, required: true },
    feedbackQueue: { type: Number, default: 0 },
    promoted: { type: Boolean, default: false },
  },
  { timestamps: true }
);

export const ModelMetrics = mongoose.model<IModelMetrics>('ModelMetrics', modelMetricsSchema);
