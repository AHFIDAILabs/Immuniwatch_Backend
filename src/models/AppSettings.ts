// AppSettings — per-organization configurable thresholds.
// _key pattern: 'platform' (super_admin platform defaults) or 'org_<orgId>'.
// Org settings inherit platform defaults for any field not explicitly set.

import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IAppSettings extends Document {
  _key:          string;        // 'platform' | 'org_<orgId>'
  organizationId?: Types.ObjectId; // absent for platform defaults

  surgePosts:            number;
  hitlAutoEscalateAbove: number;
  psiDriftAlert:         number;
  overrideRateAlert:     number;
  macroF1Target:         number;
  inferenceP95Ms:        number;
  feedbackQueueMax:      number;
  notifEmail:            string;

  updatedAt?: Date;
  createdAt?: Date;
}

const appSettingsSchema = new Schema<IAppSettings>(
  {
    _key:           { type: String, required: true, unique: true },
    organizationId: { type: Schema.Types.ObjectId, ref: 'Organization' },

    surgePosts:            { type: Number, default: 200   },
    hitlAutoEscalateAbove: { type: Number, default: 85    },
    psiDriftAlert:         { type: Number, default: 0.20  },
    overrideRateAlert:     { type: Number, default: 25    },
    macroF1Target:         { type: Number, default: 0.80  },
    inferenceP95Ms:        { type: Number, default: 200   },
    feedbackQueueMax:      { type: Number, default: 5000  },
    notifEmail:            { type: String, default: '' },
  },
  { timestamps: true },
);

export const AppSettings = mongoose.model<IAppSettings>('AppSettings', appSettingsSchema);
