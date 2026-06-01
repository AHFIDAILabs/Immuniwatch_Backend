import mongoose, { Document, Schema } from "mongoose";
import { ObjectId } from "../types";

export type OrgPlan = "basic" | "standard" | "premium";
export type OrgStatus = "active" | "suspended" | "trial";

export interface IOrganization extends Document {
  name: string;
  slug: string; // URL-safe unique identifier
  description?: string;
  region: string; // e.g. "Lagos", "Kano"
  state: string; // Nigerian state
  contactEmail: string;
  phoneNumber?: string;
  logoUrl?: string;
  plan: OrgPlan;
  status: OrgStatus;
  userCount: number; // denormalized for fast listing
  createdBy: ObjectId; // super_admin who created this org
  settings?: {
    surgePosts?: number;
    hitlAutoEscalateAbove?: number;
    psiDriftAlert?: number;
    overrideRateAlert?: number;
    notifEmail?: string;
  };
}

const orgSchema = new Schema<IOrganization>(
  {
    name: { type: String, required: true, trim: true },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    description: { type: String },
    region: { type: String, required: true },
    state: { type: String, required: true },
    contactEmail: { type: String, required: true, lowercase: true, trim: true },
    phoneNumber: { type: String },
    logoUrl: { type: String },
    plan: {
      type: String,
      enum: ["basic", "standard", "premium"],
      default: "basic",
    },
    status: {
      type: String,
      enum: ["active", "suspended", "trial"],
      default: "active",
    },
    userCount: { type: Number, default: 0 },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    settings: {
      surgePosts: { type: Number },
      hitlAutoEscalateAbove: { type: Number },
      psiDriftAlert: { type: Number },
      overrideRateAlert: { type: Number },
      notifEmail: { type: String },
    },
  },
  { timestamps: true },
);

orgSchema.index({ status: 1 });
orgSchema.index({ region: 1 });

export const Organization = mongoose.model<IOrganization>(
  "Organization",
  orgSchema,
);
