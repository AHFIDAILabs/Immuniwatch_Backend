import mongoose, { Document, Schema, Types } from 'mongoose';
import { PostPlatform, PostLanguage } from '../types';

export interface IPost extends Document {
  externalId?:    string;
  platform:       PostPlatform;
  content:        string;
  author?:        string;
  url?:           string;
  language:       PostLanguage;
  postedAt?:      Date;
  ingestedAt:     Date;
  labels?:         string[];
  metadata?:      Record<string, unknown>;
  isProcessed:    boolean;
  archivedAt?:    Date;
  archivedBy?:    Types.ObjectId;
  organizationId?: Types.ObjectId;
}

const postSchema = new Schema<IPost>(
  {
    externalId: { type: String },
    platform: {
      type: String,
      enum: Object.values(PostPlatform),
      required: true,
    },
    content: { type: String, required: true },
    author: { type: String },
    url: { type: String },
    language: {
      type: String,
      enum: Object.values(PostLanguage),
      required: true,
    },
    labels: [{ type: String }],
    postedAt: { type: Date },
    ingestedAt: { type: Date, default: Date.now },
    metadata: { type: Schema.Types.Mixed },
    isProcessed:    { type: Boolean, default: false },
    archivedAt:     { type: Date },
    archivedBy:     { type: Schema.Types.ObjectId, ref: 'User' },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },
  },
  { timestamps: true }
);

postSchema.index({ externalId: 1, platform: 1 }, { unique: true, partialFilterExpression: { externalId: { $exists: true, $ne: null } } });
postSchema.index({ ingestedAt: -1 });
postSchema.index({ language: 1 });
postSchema.index({ platform: 1 });
postSchema.index({ content: 'text' }, { default_language: 'none', language_override: 'text_lang' });

export const Post = mongoose.model<IPost>('Post', postSchema);
