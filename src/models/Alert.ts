import mongoose, { Document, Schema } from 'mongoose';
import { AlertSeverity, AlertTriggerType, PostLanguage, PostPlatform, ObjectId } from '../types';

export interface IAlert extends Document {
  severity:          AlertSeverity;
  triggerType:       AlertTriggerType;
  title:             string;
  message:           string;
  affectedLanguage?: PostLanguage;
  platform?:         PostPlatform;
  psiValue?:         number;
  isResolved:        boolean;
  resolvedAt?:       Date;
  resolvedBy?:       ObjectId;
  organizationId?:   ObjectId;
}

const alertSchema = new Schema<IAlert>(
  {
    severity:    { type: String, enum: Object.values(AlertSeverity),    required: true },
    triggerType: { type: String, enum: Object.values(AlertTriggerType), required: true },
    title:       { type: String, required: true },
    message:     { type: String, required: true },
    affectedLanguage: { type: String, enum: Object.values(PostLanguage) },
    platform:         { type: String, enum: Object.values(PostPlatform) },
    psiValue:    { type: Number },
    isResolved:  { type: Boolean, default: false },
    resolvedAt:  { type: Date },
    resolvedBy:  { type: Schema.Types.ObjectId, ref: 'User' },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
  },
  { timestamps: true },
);

alertSchema.index({ organizationId: 1, isResolved: 1, createdAt: -1 });
alertSchema.index({ organizationId: 1, triggerType: 1, affectedLanguage: 1, isResolved: 1 });

export const Alert = mongoose.model<IAlert>('Alert', alertSchema);
