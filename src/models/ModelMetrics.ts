// Changes vs. original:
//   • ILanguageMetrics: added `recall`, made `sampleCount` optional (the ML
//     service v1.0.0 does NOT return sample_count in by_language — having it
//     required: true caused every ModelMetrics upsert from live data to fail
//     Mongoose validation with a silent 500 that fell back to stale seed data)
//   • languageMetricsSchema: sampleCount now defaults to 0, recall added

import mongoose, { Document, Schema } from "mongoose";
import { PostLanguage } from "../types";

export interface ILanguageMetrics {
  macroF1: number;
  recall: number; // added — provided by ML service per language
  psi: number;
  sampleCount?: number; // optional — ML service v1.0.0 does not return this
}

export interface IModelMetrics extends Document {
  modelVersion: string;
  macroF1: number;
  recall: number;
  precision: number;
  inferenceP95ms: number;
  perLanguage: Partial<Record<PostLanguage, ILanguageMetrics>>;
  computedAt?: Date; // when the ML service computed these metrics
  lastRetrain?: Date;
  feedbackQueue: number;
  promoted: boolean;
  stale?: boolean; // true when served from cache due to ML service unavailability
  updatedAt?: Date;
  createdAt?: Date;
}

const languageMetricsSchema = new Schema<ILanguageMetrics>(
  {
    macroF1: { type: Number, required: true },
    recall: { type: Number, required: true },
    psi: { type: Number, required: true },
    sampleCount: { type: Number, default: 0 }, // 0 when not provided by service
  },
  { _id: false },
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
    computedAt: { type: Date },
    lastRetrain: { type: Date },
    feedbackQueue: { type: Number, default: 0 },
    promoted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// Allow fast lookup of the most-recently-updated record (used by cache check)
modelMetricsSchema.index({ updatedAt: -1 });

export const ModelMetrics = mongoose.model<IModelMetrics>(
  "ModelMetrics",
  modelMetricsSchema,
);
