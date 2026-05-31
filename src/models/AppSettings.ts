// AppSettings — single-document collection for operator-configurable thresholds.
//
// Uses a singleton pattern (one document, always upserted by the fixed key
// 'singleton'). All fields have sensible defaults that mirror config.ts so
// the system works correctly even if no settings have ever been saved.

import mongoose, { Document, Schema } from 'mongoose';

export interface IAppSettings extends Document {
  _key: string;  // always 'singleton'

  // ── Alert thresholds ───────────────────────────────────────────────────────
  surgePosts:           number;  // posts on one claim in 2h before surge alert
  hitlAutoEscalateAbove: number; // confidence % above which HITL → high priority
  psiDriftAlert:        number;  // PSI threshold for drift alert
  overrideRateAlert:    number;  // analyst override % that triggers alert

  // ── Model performance targets ──────────────────────────────────────────────
  macroF1Target:    number;  // minimum acceptable macro-F1 before retrain alert
  inferenceP95Ms:   number;  // maximum acceptable p95 latency (ms)
  feedbackQueueMax: number;  // trigger retrain when feedback queue exceeds this

  // ── Notifications ──────────────────────────────────────────────────────────
  notifEmail: string;

  updatedAt?: Date;
  createdAt?: Date;
}

const appSettingsSchema = new Schema<IAppSettings>(
  {
    _key: { type: String, default: 'singleton', immutable: true, unique: true },

    // Alert thresholds
    surgePosts:            { type: Number, default: 200   },
    hitlAutoEscalateAbove: { type: Number, default: 85    },
    psiDriftAlert:         { type: Number, default: 0.20  },
    overrideRateAlert:     { type: Number, default: 25    },

    // Model targets
    macroF1Target:    { type: Number, default: 0.80  },
    inferenceP95Ms:   { type: Number, default: 200   },
    feedbackQueueMax: { type: Number, default: 5000  },

    // Notifications
    notifEmail: { type: String, default: '' },
  },
  { timestamps: true },
);

export const AppSettings = mongoose.model<IAppSettings>('AppSettings', appSettingsSchema);