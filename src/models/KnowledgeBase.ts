import mongoose, { Document, Schema } from 'mongoose';
import { PostLanguage, ObjectId } from '../types';

export interface IKnowledgeBase extends Document {
  title:               string;
  content:             string;
  summary?:            string;
  source:              string;
  sourceDate?:         Date;
  language:            PostLanguage;
  cloudinaryUrl?:      string;
  cloudinaryPublicId?: string;
  embeddingVector?:    number[];
  embedded:            boolean;
  mlDocId?:            string;    // doc_id returned by the ML service KB (for ChromaDB sync)
  mlIndexed:           boolean;   // true when successfully indexed in ChromaDB
  confidenceScore:     number;
  tags:                string[];
  createdBy:           ObjectId;
  organizationId?:     ObjectId;
}

const knowledgeBaseSchema = new Schema<IKnowledgeBase>(
  {
    title:   { type: String, required: true, trim: true },
    content: { type: String, required: true },
    summary: { type: String },
    source:  { type: String, required: true },
    sourceDate: { type: Date },
    language: { type: String, enum: Object.values(PostLanguage), default: PostLanguage.ENGLISH },
    cloudinaryUrl:      { type: String },
    cloudinaryPublicId: { type: String },
    embeddingVector:    { type: [Number], select: false },
    embedded:           { type: Boolean, default: false },
    mlDocId:            { type: String },    // ML service ChromaDB document ID
    mlIndexed:          { type: Boolean, default: false },
    confidenceScore:    { type: Number, default: 0.8, min: 0, max: 1 },
    tags:               [{ type: String, trim: true }],
    createdBy:          { type: Schema.Types.ObjectId, ref: 'User', required: true },
    organizationId:     { type: Schema.Types.ObjectId, ref: 'Organization' },
  },
  { timestamps: true },
);

knowledgeBaseSchema.index(
  { content: 'text', title: 'text' },
  { default_language: 'none', language_override: 'text_lang' },
);
knowledgeBaseSchema.index({ organizationId: 1, embedded: 1 });
knowledgeBaseSchema.index({ tags: 1 });

export const KnowledgeBase = mongoose.model<IKnowledgeBase>('KnowledgeBase', knowledgeBaseSchema);
