import mongoose from "mongoose";

import { config } from "../config";
import { AuditLog } from "../models/AuditLog";
import { BatchJob } from "../models/BatchJob";
import { Classification } from "../models/Classification";
import { HITLReview, IHITLReview } from "../models/HITLReview";
import { Post } from "../models/Post";
import { User } from "../models/User";
import {
  AuditAction,
  BatchJobStatus,
  ClassificationLabel,
  HITLPriority,
  HITLStatus,
  PostLanguage,
  PostPlatform,
} from "../types";
import {
  MLClassifyRequest,
  MLFeedbackPayload,
  MLLabel,
  MLLanguage,
  MLPlatform,
} from "../types/ml.types";
import { AppError } from "../utils/AppError";
import { logger } from "../utils/logger";
import * as mlClient from "./mlClient";

// ── Language / platform mapping ───────────────────────────────────────────────

const LANG_MAP: Record<PostLanguage, MLLanguage> = {
  [PostLanguage.ENGLISH]: MLLanguage.EN,
  [PostLanguage.PIDGIN]: MLLanguage.PCM,
  [PostLanguage.HAUSA]: MLLanguage.HA,
  [PostLanguage.YORUBA]: MLLanguage.YO,
  [PostLanguage.IGBO]: MLLanguage.IG,
};

const PLATFORM_MAP: Record<PostPlatform, MLPlatform> = {
  [PostPlatform.TWITTER]:    MLPlatform.TWITTER,
  [PostPlatform.FACEBOOK]:   MLPlatform.FACEBOOK,
  [PostPlatform.YOUTUBE]:    MLPlatform.YOUTUBE,
  [PostPlatform.BLUESKY]:    MLPlatform.BLUESKY,
  [PostPlatform.SUBMISSION]: MLPlatform.SUBMISSION,
};

export function mapLanguage(lang: PostLanguage): MLLanguage {
  return LANG_MAP[lang] ?? MLLanguage.EN;
}

export function mapPlatform(platform: PostPlatform): MLPlatform {
  return PLATFORM_MAP[platform] ?? MLPlatform.TWITTER;
}

function mlLabelToClassificationLabel(label: MLLabel): ClassificationLabel {
  const map: Record<MLLabel, ClassificationLabel> = {
    [MLLabel.MISINFORMATION]: ClassificationLabel.MISINFORMATION,
    [MLLabel.FACTUAL]: ClassificationLabel.FACTUAL,
    [MLLabel.IRRELEVANT]: ClassificationLabel.IRRELEVANT,
  };
  return map[label] ?? ClassificationLabel.PENDING;
}

// ── KB search (lazy import to avoid circular dep) ─────────────────────────────

async function fetchKbSnippets(
  content: string,
  language: PostLanguage,
): Promise<string[]> {
  try {
    const { searchSimilar } = await import("./kbService");
    const results = await searchSimilar(content, 3, language);
    return results.map((r) => r.snippet);
  } catch {
    return [];
  }
}

// ── Create HITL review (idempotent) ───────────────────────────────────────────

async function ensureHITLReview(
  postId: string,
  classificationId: mongoose.Types.ObjectId,
  priority: HITLPriority,
  note: string,
): Promise<InstanceType<typeof HITLReview> | null> {
  const existing = await HITLReview.findOne({ postId }).lean();
  if (existing) return null;

  return HITLReview.create({
    postId,
    classificationId,
    priority,
    status: HITLStatus.PENDING,
    notes: note,
  });
}

// ── classifyPost ──────────────────────────────────────────────────────────────

export async function classifyPost(postId: string): Promise<{
  classification: InstanceType<typeof Classification>;
  hitlReview: InstanceType<typeof HITLReview> | null;
}> {
  const existing = await Classification.findOne({ postId });
  if (existing) {
    const review = await HITLReview.findOne({ postId });
    return { classification: existing, hitlReview: review };
  }

  const post = await Post.findById(postId);
  if (!post) throw new AppError(404, "NOT_FOUND", `Post ${postId} not found`);

  const kbSnippets = await fetchKbSnippets(
    post.content,
    post.language as PostLanguage,
  );

  const request: MLClassifyRequest = {
    post_id: postId,
    content: post.content,
    language: mapLanguage(post.language as PostLanguage),
    platform: mapPlatform(post.platform as PostPlatform),
    kb_snippets: kbSnippets,
  };

  const response = await mlClient.classifySingle(request);

  let classification: InstanceType<typeof Classification>;
  let hitlReview: InstanceType<typeof HITLReview> | null = null;

  if (response.fallback) {
    classification = await Classification.create({
      postId,
      label: ClassificationLabel.PENDING,
      confidence: 0,
      entropy: 1,
      modelVersion: "fallback",
      alternatives: [],
      kbEvidence: [],
      processingMs: 0,
      fallback: true,
    });

    hitlReview = await ensureHITLReview(
      postId,
      classification._id,
      HITLPriority.HIGH,
      "ML service fallback — manual review required",
    );
    logger.warn(
      `classifyPost fallback — post=${postId} circuitState=${mlClient.getCircuitState()}`,
    );
  } else {
    const label = mlLabelToClassificationLabel(response.label);
    const confidence = response.confidence;
    const entropy = response.entropy;

    classification = await Classification.create({
      postId,
      label,
      confidence,
      entropy,
      modelVersion: response.model_version,
      alternatives: response.alternatives,
      kbEvidence: response.kb_evidence,
      processingMs: response.processing_ms,
      fallback: false,
      counterResponseQueued: response.counter_response_queued ?? false,
    });

    // High-confidence factual predictions skip HITL — auto-approved
    const isAutoApproved =
      label === ClassificationLabel.FACTUAL && confidence >= 0.92;

    if (!isAutoApproved) {
      const needsReview =
        label === ClassificationLabel.MISINFORMATION &&
        confidence >= config.classification.hitlThreshold;

      if (needsReview) {
        // HIGH if confidence is very high OR entropy is elevated (model uncertain between labels)
        const priority =
          confidence >= config.classification.highPriorityThreshold ||
          entropy > 0.45
            ? HITLPriority.HIGH
            : HITLPriority.STANDARD;

        hitlReview = await ensureHITLReview(
          postId,
          classification._id,
          priority,
          `Auto-escalated: confidence=${confidence.toFixed(3)} entropy=${entropy.toFixed(3)} label=${label}`,
        );
      }
    }
  }

  setImmediate(async () => {
    try {
      const { publishClassified } = await import("../utils/kafkaProducer");
      await publishClassified(response, postId);
    } catch {
      /* logged by producer */
    }
  });

  await AuditLog.create({
    actor: "system",
    action: AuditAction.AUTO_CLASSIFY,
    resourceType: "Classification",
    resourceId: classification._id.toString(),
    newValue: {
      label: classification.label,
      confidence: classification.confidence,
      model_version: classification.modelVersion,
    },
  });

  return { classification, hitlReview };
}

// ── classifyBatch ─────────────────────────────────────────────────────────────

export async function classifyBatch(
  postIds: string[],
): Promise<{ jobId: string }> {
  const posts = await Post.find({ _id: { $in: postIds } });
  if (!posts.length)
    throw new AppError(400, "NO_POSTS", "No valid posts found");

  const requests: MLClassifyRequest[] = posts.map((p) => ({
    post_id: p._id.toString(),
    content: p.content,
    language: mapLanguage(p.language as PostLanguage),
    platform: mapPlatform(p.platform as PostPlatform),
  }));

  const response = await mlClient.classifyBatch(requests);

  await BatchJob.create({
    jobId: response.job_id,
    postIds,
    status: BatchJobStatus.PENDING,
  });

  return { jobId: response.job_id };
}

// ── pollBatchResult ───────────────────────────────────────────────────────────

export async function pollBatchResult(jobId: string): Promise<void> {
  const job = await BatchJob.findOne({ jobId });
  if (!job) throw new AppError(404, "NOT_FOUND", `BatchJob ${jobId} not found`);

  const result = await mlClient.pollBatch(jobId);
  job.status = result.status as BatchJobStatus;
  await job.save();

  // FIX: was 'completed' — API returns 'complete' (see MLBatchResult in ml.types.ts)
  if (result.status !== "complete" || !result.results) return;

  await Promise.allSettled(
    result.results.map(async (r) => {
      const label = mlLabelToClassificationLabel(r.label);
      const cls = await Classification.findOneAndUpdate(
        { postId: r.post_id },
        {
          $setOnInsert: {
            postId: r.post_id,
            label,
            confidence: r.confidence,
            entropy: r.entropy,
            modelVersion: r.model_version,
            alternatives: r.alternatives,
            kbEvidence: r.kb_evidence,
            processingMs: r.processing_ms,
            fallback: false,
          },
        },
        { upsert: true, new: true },
      );

      const isAutoApproved =
        label === ClassificationLabel.FACTUAL && r.confidence >= 0.92;

      const needsReview =
        !isAutoApproved &&
        label === ClassificationLabel.MISINFORMATION &&
        r.confidence >= config.classification.hitlThreshold;

      if (needsReview && cls) {
        const priority =
          r.confidence >= config.classification.highPriorityThreshold ||
          r.entropy > 0.45
            ? HITLPriority.HIGH
            : HITLPriority.STANDARD;
        await ensureHITLReview(
          r.post_id,
          cls._id,
          priority,
          "Batch classification escalation",
        );
      }
    }),
  );
}

// ── submitAnalystFeedback — MUST be called from hitlService overrides/rejections

export async function submitAnalystFeedback(
  reviewId: string,
  analystId: string,
): Promise<void> {
  const [review, analyst] = await Promise.all([
    HITLReview.findById(reviewId),
    User.findById(analystId).lean(),
  ]);

  if (!review)
    throw new AppError(404, "NOT_FOUND", `HITLReview ${reviewId} not found`);
  if (!analyst)
    throw new AppError(404, "NOT_FOUND", `User ${analystId} not found`);

  const classification = await Classification.findById(review.classificationId);
  if (!classification)
    throw new AppError(400, "INVALID_STATE", "Review has no classification");

  const correctedLabel = review.overriddenLabel
    ? (review.overriddenLabel as unknown as MLLabel)
    : (classification.label as unknown as MLLabel);

  const payload: MLFeedbackPayload = {
    post_id: classification.postId.toString(),
    original_label: classification.label as unknown as MLLabel,
    corrected_label: correctedLabel,
    analyst_role: analyst.role,
    confidence_was: classification.confidence,
  };

  const feedbackResponse = await mlClient.submitFeedback(payload);
  logger.info(
    `Analyst feedback — feedback_id=${feedbackResponse.feedback_id} queued=${feedbackResponse.queued_for_training}`,
  );

  setImmediate(async () => {
    try {
      const { publishFeedback } = await import("../utils/kafkaProducer");
      await publishFeedback(payload);
    } catch {
      /* logged by producer */
    }
  });

  await AuditLog.create({
    actor: analystId,
    actorName: analyst.name,
    action: AuditAction.ANALYST_FEEDBACK,
    resourceType: "HITLReview",
    resourceId: review._id.toString(),
    newValue: {
      original_label: payload.original_label,
      corrected_label: payload.corrected_label,
      feedback_id: feedbackResponse.feedback_id,
    },
  });
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function getClassificationStats(dateRange: {
  from: Date;
  to: Date;
}) {
  return Classification.aggregate([
    { $match: { createdAt: { $gte: dateRange.from, $lte: dateRange.to } } },
    {
      $group: {
        _id: "$label",
        count: { $sum: 1 },
        avgConfidence: { $avg: "$confidence" },
      },
    },
    { $sort: { count: -1 } },
  ]);
}
