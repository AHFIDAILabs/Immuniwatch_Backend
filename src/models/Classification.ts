import mongoose, { Document, Schema } from 'mongoose';
import { ClassificationLabel, ObjectId } from '../types';

export interface IClassificationAlternative {
  label: string;
  confidence: number;
}

export interface IKbEvidence {
  docId: string;
  title: string;
  snippet: string;
  score: number;
}

export interface IClassification extends Document {
  postId: ObjectId;
  label: ClassificationLabel;
  confidence: number;
  entropy: number;
  modelVersion: string;
  alternatives: IClassificationAlternative[];
  kbEvidence: IKbEvidence[];
  fallback: boolean;
  processingMs: number;
}

const classificationSchema = new Schema<IClassification>(
  {
    postId: {
      type: Schema.Types.ObjectId,
      ref: 'Post',
      required: true,
      unique: true,
    },
    label: {
      type: String,
      enum: Object.values(ClassificationLabel),
      required: true,
    },
    confidence: { type: Number, required: true, min: 0, max: 1 },
    entropy: { type: Number, required: true, min: 0 },
    modelVersion: { type: String, required: true },
    alternatives: [
      {
        label: { type: String, required: true },
        confidence: { type: Number, required: true },
      },
    ],
    kbEvidence: [
      {
        docId: { type: String, required: true },
        title: { type: String, required: true },
        snippet: { type: String, required: true },
        score: { type: Number, required: true },
      },
    ],
    fallback: { type: Boolean, default: false },
    processingMs: { type: Number, default: 0 },
  },
  { timestamps: true }
);

classificationSchema.index({ label: 1 });
classificationSchema.index({ createdAt: -1 });

export const Classification = mongoose.model<IClassification>('Classification', classificationSchema);
