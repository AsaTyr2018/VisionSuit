import { ModerationStatus, Prisma } from '@prisma/client';

import type { ImageMetadataResult } from '../metadata';
import { prisma } from '../prisma';
import { runImageModerationWorkflow } from '../nsfw/workflow';
import type { AutoTagSummary } from './wdSwinv2';
import { WdSwinv2Tagger } from './wdSwinv2';

export interface AutoTaggingJobInput {
  imageId: string;
  buffer: Buffer;
  finalTitle: string;
  finalDescription: string | null;
  visibility: 'public' | 'private';
  adultKeywords: string[];
  illegalKeywords: string[];
  assignedTags: { label: string; isAdult: boolean }[];
  metadata?: ImageMetadataResult | null;
  metadataPayload?: Prisma.JsonObject | null;
  metadataList?: Prisma.JsonValue[];
}

interface InternalAutoTaggingJob extends AutoTaggingJobInput {
  enqueuedAt: number;
}

const tagger = new WdSwinv2Tagger();

let autoTaggerReady = false;
let autoTaggerInitializationError: Error | null = null;

const getAutoTaggerFailureMessage = () =>
  autoTaggerInitializationError?.message ??
  'Auto-tagging is currently unavailable because the ONNX Runtime backend could not be initialized.';

const markAutoTaggingJobAsFailed = async (
  job: AutoTaggingJobInput,
  failureMessage: string,
) => {
  try {
    await prisma.imageAsset.update({
      where: { id: job.imageId },
      data: {
        tagScanPending: false,
        tagScanStatus: 'failed',
        tagScanCompletedAt: new Date(),
        tagScanError: failureMessage,
        moderationStatus: ModerationStatus.FLAGGED,
        isPublic: false,
      },
    });
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('[autoTagger] Failed to mark job as failed', job.imageId, error);
  }
};

const clampSummary = (summary: AutoTagSummary): AutoTagSummary => ({
  general: summary.general.slice(0, 50),
  characters: summary.characters.slice(0, 25),
  ratings: summary.ratings,
  thresholds: summary.thresholds,
});

const serializeSummary = (summary: AutoTagSummary): Prisma.JsonValue =>
  JSON.parse(JSON.stringify(summary)) as Prisma.JsonValue;

const buildAutoTagTexts = (summary: AutoTagSummary) => [
  ...summary.general.slice(0, 50).map((entry) => entry.label),
  ...summary.characters.slice(0, 25).map((entry) => entry.label),
];

class AutoTaggingQueue {
  private queue: InternalAutoTaggingJob[] = [];

  private active = false;

  enqueue(job: AutoTaggingJobInput) {
    const payload: InternalAutoTaggingJob = { ...job, enqueuedAt: Date.now() };
    this.queue.push(payload);
    if (!this.active) {
      void this.processNext();
    }
  }

  private async processNext(): Promise<void> {
    const nextJob = this.queue.shift();
    if (!nextJob) {
      this.active = false;
      return;
    }

    this.active = true;

    try {
      await this.executeJob(nextJob);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('[autoTagger] Failed to process job', nextJob.imageId, error);
    } finally {
      this.active = false;
      if (this.queue.length > 0) {
        void this.processNext();
      }
    }
  }

  private async executeJob(job: InternalAutoTaggingJob) {
    await tagger.initialize();

    await prisma.imageAsset.update({
      where: { id: job.imageId },
      data: {
        tagScanStatus: 'processing',
        tagScanError: null,
      },
    });

    try {
      const summary = await tagger.tag(job.buffer);
      const trimmedSummary = clampSummary(summary);
      const autoTagTexts = buildAutoTagTexts(trimmedSummary);

      const metadataList = [...(job.metadataList ?? [])];
      metadataList.push({
        autoTags: trimmedSummary,
      } as Prisma.JsonObject);

      const workflow = await runImageModerationWorkflow({
        buffer: job.buffer,
        adultKeywords: job.adultKeywords,
        illegalKeywords: job.illegalKeywords,
        context: {
          title: job.finalTitle,
          description: job.finalDescription,
          prompt: job.metadata?.prompt ?? null,
          negativePrompt: job.metadata?.negativePrompt ?? null,
          model: job.metadata?.model ?? null,
          sampler: job.metadata?.sampler ?? null,
          metadata: job.metadataPayload ?? null,
          metadataList,
          tags: job.assignedTags.map((tag) => ({ tag })),
          additionalTexts: autoTagTexts,
        },
      });

      const update: Prisma.ImageAssetUpdateInput = {
        title: job.finalTitle,
        description: job.finalDescription,
        isAdult: workflow.decision.isAdult,
        isPublic: !workflow.decision.requiresModeration && job.visibility === 'public',
        moderationStatus: workflow.decision.requiresModeration ? ModerationStatus.FLAGGED : ModerationStatus.ACTIVE,
        flaggedAt: workflow.decision.requiresModeration ? new Date() : null,
        tagScanPending: false,
        tagScanStatus: 'completed',
        tagScanCompletedAt: new Date(),
        tagScanError: null,
        autoTagSummary: serializeSummary(trimmedSummary),
      };

      if (workflow.serializedSummary) {
        update.moderationSummary = workflow.serializedSummary;
      }

      await prisma.imageAsset.update({
        where: { id: job.imageId },
        data: update,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Auto-tagging failed.';
      await prisma.imageAsset.update({
        where: { id: job.imageId },
        data: {
          tagScanPending: false,
          tagScanStatus: 'failed',
          tagScanCompletedAt: new Date(),
          tagScanError: message,
          moderationStatus: ModerationStatus.FLAGGED,
          isPublic: false,
        },
      });
      throw error;
    }
  }
}

const queue = new AutoTaggingQueue();

export const initializeAutoTagger = async (): Promise<boolean> => {
  try {
    await tagger.initialize();
    autoTaggerReady = true;
    autoTaggerInitializationError = null;
    return true;
  } catch (error) {
    autoTaggerReady = false;
    autoTaggerInitializationError = error instanceof Error ? error : new Error('Auto-tagging failed to initialize.');
    const message = getAutoTaggerFailureMessage();
    // eslint-disable-next-line no-console
    console.error('[startup] Auto tagger disabled:', message);
    return false;
  }
};

export const enqueueAutoTaggingJob = (job: AutoTaggingJobInput) => {
  if (!autoTaggerReady) {
    const failureMessage = getAutoTaggerFailureMessage();
    // eslint-disable-next-line no-console
    console.warn('[autoTagger] Skipping queued job because auto-tagging is disabled:', job.imageId);
    void markAutoTaggingJobAsFailed(job, failureMessage);
    return;
  }

  queue.enqueue(job);
};
