import crypto from 'node:crypto';

import {
  Prisma,
  ImageAsset,
  ImageComment,
  ImageModerationReport,
  ModelComment,
  ModerationActionType,
  ModerationEntityType,
  ModerationStatus,
  NotificationType,
  Tag,
  User,
} from '@prisma/client';
import type { Express, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { appConfig } from '../config';
import { prisma } from '../lib/prisma';
import { determineAdultForImage, determineAdultForModel } from '../lib/adult-content';
import { getAdultKeywordLabels, getIllegalKeywordLabels } from '../lib/safety-keywords';
import { requireAdmin, requireAuth, requireCurator } from '../lib/middleware/auth';
import { extractImageMetadata, extractModelMetadataFromFile, toJsonImageMetadata } from '../lib/metadata';
import { buildGalleryInclude, mapGallery } from '../lib/mappers/gallery';
import { MAX_TOTAL_SIZE_BYTES } from '../lib/uploadLimits';
import {
  mapModelAsset,
  type HydratedModelAsset,
  type MappedModerationReport,
} from '../lib/mappers/model';
import {
  analyzeImageModeration,
  collectModerationSummaries,
  normalizeModerationSummary,
  serializeModerationSummary,
  type ImageModerationSummary,
} from '../lib/nsfw-open-cv';
import { resolveMetadataScreening } from '../lib/nsfw/moderation';
import { collectStringsFromJson, detectKeywordMatch } from '../lib/nsfw/keywordMatcher';
import type { MetadataEvaluationResult } from '../lib/nsfw/metadata';
import { resolveStorageLocation, storageBuckets, storageClient } from '../lib/storage';
import { runNsfwImageAnalysis, toJsonImageAnalysis } from '../lib/nsfw/service';
import { createNotification } from '../lib/notifications';

type ModerationReportSource = ImageModerationReport & {
  reporter: Pick<User, 'id' | 'displayName' | 'email'>;
};

type HydratedImageAsset = ImageAsset & {
  tags: { tag: Tag }[];
  owner: Pick<User, 'id' | 'displayName' | 'email'>;
  flaggedBy?: Pick<User, 'id' | 'displayName' | 'email'> | null;
  _count: { likes: number };
  likes?: { userId: string }[];
  moderationReports?: ModerationReportSource[];
  moderationSummary?: Prisma.JsonValue | null;
};

type CommentAuthor = Pick<User, 'id' | 'displayName' | 'avatarUrl' | 'role'>;

type HydratedModelComment = ModelComment & {
  author: CommentAuthor;
  _count: { likes: number };
  likes?: { userId: string }[];
};

type HydratedImageComment = ImageComment & {
  author: CommentAuthor;
  _count: { likes: number };
  likes?: { userId: string }[];
};

type NsfwVisibility = 'BLOCKED' | 'ADULT' | 'SUGGESTIVE';
type NsfwReason = 'KEYWORD' | 'METADATA' | 'OPENCV';

type NsfwSnapshot = {
  visibility: NsfwVisibility;
  pendingReview: boolean;
  reasons: NsfwReason[];
  reasonDetails: string[];
  signals: {
    moderationAdultScore: number | null;
    moderationSuggestiveScore: number | null;
  };
  metadata: {
    adultScore: number | null;
    minorScore: number | null;
    beastScore: number | null;
  } | null;
};

const NSFW_VISIBILITY_PRIORITY: Record<NsfwVisibility, number> = {
  BLOCKED: 0,
  ADULT: 1,
  SUGGESTIVE: 2,
};

const METADATA_MATCH_EXAMPLE_LIMIT = 3;

const sanitizeReasonDetails = (values: string[]): string[] => {
  const seen = new Set<string>();
  const sanitized: string[] = [];

  for (const entry of values) {
    const normalized = entry.trim();
    if (normalized.length === 0 || seen.has(normalized)) {
      continue;
    }
    sanitized.push(normalized);
    seen.add(normalized);
  }

  return sanitized;
};

const formatMatchExamples = (entries: ReadonlyArray<{ tag: string; count: number }>) => {
  const examples = entries
    .map((entry) => ({
      tag: typeof entry.tag === 'string' ? entry.tag.trim() : '',
      count: Number.isFinite(entry.count) ? Number(entry.count) : Number.NaN,
    }))
    .filter((entry) => entry.tag.length > 0)
    .slice(0, METADATA_MATCH_EXAMPLE_LIMIT)
    .map((entry) =>
      Number.isFinite(entry.count) && entry.count > 1
        ? `${entry.tag} (${Math.round(entry.count)})`
        : entry.tag,
    )
    .filter((entry) => entry.length > 0);

  return examples.length > 0 ? examples.join(', ') : null;
};

const elevateVisibility = (current: NsfwVisibility, next: NsfwVisibility | null): NsfwVisibility => {
  if (!next) {
    return current;
  }

  return NSFW_VISIBILITY_PRIORITY[next] < NSFW_VISIBILITY_PRIORITY[current] ? next : current;
};

const appendMetadataReason = (
  reasons: Set<NsfwReason>,
  details: string[],
  category: 'adult' | 'minor' | 'beast',
  score: number,
  threshold: number,
  matches: MetadataEvaluationResult['matches'][keyof MetadataEvaluationResult['matches']],
): NsfwVisibility | null => {
  if (threshold <= 0 || score < threshold) {
    return null;
  }

  reasons.add('METADATA');

  const label =
    category === 'adult'
      ? 'Adult'
      : category === 'minor'
        ? 'Minor-coded'
        : 'Bestiality';
  const formattedScore = Number.isFinite(score) ? Math.round(score) : score;
  const exampleText = formatMatchExamples(matches ?? []);
  const messageParts = [
    `${label} metadata score ${formattedScore} met the review threshold (${threshold}).`,
  ];

  if (exampleText) {
    messageParts.push(`Examples: ${exampleText}.`);
  }

  details.push(messageParts.join(' '));

  return category === 'adult' ? 'ADULT' : 'BLOCKED';
};

const selectLatestModerationSummary = (
  summaries: ImageModerationSummary[],
): ImageModerationSummary | null => {
  let latest: ImageModerationSummary | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const summary of summaries) {
    const timestamp = Date.parse(summary.analyzedAt ?? '');
    const normalized = Number.isFinite(timestamp) ? timestamp : 0;
    if (!latest || normalized > latestTimestamp) {
      latest = summary;
      latestTimestamp = normalized;
    }
  }

  return latest;
};

const buildModelModerationSnapshot = (asset: HydratedModelAsset): NsfwSnapshot | null => {
  const moderationSummaries = collectModerationSummaries([
    asset.moderationSummary ?? null,
    asset.metadata ?? null,
    ...asset.versions
      .map((version) => version.metadata ?? null)
      .filter((entry): entry is Prisma.JsonValue => entry != null),
  ]);
  const summary = selectLatestModerationSummary(moderationSummaries);
  const metadataScreening = resolveMetadataScreening(asset.metadata ?? null);

  const reasons = new Set<NsfwReason>();
  const details: string[] = [];
  let visibility: NsfwVisibility = 'SUGGESTIVE';
  let pendingReview = false;

  if (metadataScreening) {
    const thresholds = appConfig.nsfw.metadataFilters.thresholds;

    visibility = elevateVisibility(
      visibility,
      appendMetadataReason(
        reasons,
        details,
        'minor',
        metadataScreening.minorScore,
        thresholds.minor,
        metadataScreening.matches.minor,
      ),
    );
    visibility = elevateVisibility(
      visibility,
      appendMetadataReason(
        reasons,
        details,
        'beast',
        metadataScreening.beastScore,
        thresholds.beast,
        metadataScreening.matches.beast,
      ),
    );
    visibility = elevateVisibility(
      visibility,
      appendMetadataReason(
        reasons,
        details,
        'adult',
        metadataScreening.adultScore,
        thresholds.adult,
        metadataScreening.matches.adult,
      ),
    );
  }

  if (summary) {
    reasons.add('OPENCV');
    details.push(...summary.reasons);

    if (summary.classification === 'NUDE') {
      visibility = elevateVisibility(visibility, 'ADULT');
    } else if (summary.classification === 'BORDERLINE') {
      pendingReview = true;
      visibility = elevateVisibility(visibility, 'SUGGESTIVE');
    } else if (summary.classification === 'SWIMWEAR') {
      visibility = elevateVisibility(visibility, 'SUGGESTIVE');
    }
  }

  if (reasons.size === 0 && !asset.flaggedBy) {
    reasons.add('KEYWORD');
    details.push('Automatic metadata screening detected restricted language and queued this asset for review.');
    visibility = elevateVisibility(visibility, 'BLOCKED');
  }

  const reasonDetails = sanitizeReasonDetails(details);

  if (reasons.size === 0 && reasonDetails.length === 0 && !metadataScreening) {
    return null;
  }

  return {
    visibility,
    pendingReview,
    reasons: Array.from(reasons),
    reasonDetails,
    signals: {
      moderationAdultScore: summary?.adultScore ?? null,
      moderationSuggestiveScore: summary?.suggestiveScore ?? null,
    },
    metadata: metadataScreening
      ? {
          adultScore: metadataScreening.adultScore,
          minorScore: metadataScreening.minorScore,
          beastScore: metadataScreening.beastScore,
        }
      : null,
  };
};

const buildImageModerationSnapshot = (asset: HydratedImageAsset): NsfwSnapshot | null => {
  const summary = selectLatestModerationSummary(
    collectModerationSummaries([asset.moderationSummary ?? null]),
  );

  const reasons = new Set<NsfwReason>();
  const details: string[] = [];
  let visibility: NsfwVisibility = 'SUGGESTIVE';
  let pendingReview = false;

  if (summary) {
    reasons.add('OPENCV');
    details.push(...summary.reasons);

    if (summary.classification === 'NUDE') {
      visibility = elevateVisibility(visibility, 'ADULT');
    } else if (summary.classification === 'BORDERLINE') {
      pendingReview = true;
      visibility = elevateVisibility(visibility, 'SUGGESTIVE');
    } else if (summary.classification === 'SWIMWEAR') {
      visibility = elevateVisibility(visibility, 'SUGGESTIVE');
    }
  }

  if (reasons.size === 0 && !asset.flaggedBy) {
    reasons.add('KEYWORD');
    details.push('Automatic keyword screening detected restricted terms and queued this asset for review.');
    visibility = elevateVisibility(visibility, 'BLOCKED');
  }

  const reasonDetails = sanitizeReasonDetails(details);

  if (reasons.size === 0 && reasonDetails.length === 0) {
    return null;
  }

  return {
    visibility,
    pendingReview,
    reasons: Array.from(reasons),
    reasonDetails,
    signals: {
      moderationAdultScore: summary?.adultScore ?? null,
      moderationSuggestiveScore: summary?.suggestiveScore ?? null,
    },
    metadata: null,
  };
};

const buildImageInclude = (viewerId?: string | null) => ({
  tags: { include: { tag: true } },
  owner: { select: { id: true, displayName: true, email: true } },
  flaggedBy: { select: { id: true, displayName: true, email: true } },
  _count: { select: { likes: true } },
  ...(viewerId
    ? {
        likes: {
          where: { userId: viewerId },
          select: { userId: true },
        },
      }
    : {}),
});

const buildCommentInclude = (viewerId?: string | null) => ({
  author: { select: { id: true, displayName: true, avatarUrl: true, role: true } },
  _count: { select: { likes: true } },
  ...(viewerId
    ? {
        likes: {
          where: { userId: viewerId },
          select: { userId: true },
        },
      }
    : {}),
});

const mapCommentAuthor = (author: CommentAuthor) => ({
  id: author.id,
  displayName: author.displayName,
  role: author.role,
  avatarUrl: author.avatarUrl ?? null,
});

const mapModelComment = (comment: HydratedModelComment, viewerId?: string | null) => ({
  id: comment.id,
  content: comment.content,
  createdAt: comment.createdAt.toISOString(),
  updatedAt: comment.updatedAt.toISOString(),
  likeCount: comment._count.likes,
  viewerHasLiked: Boolean(viewerId && (comment.likes?.length ?? 0) > 0),
  author: mapCommentAuthor(comment.author),
});

const mapImageComment = (comment: HydratedImageComment, viewerId?: string | null) => ({
  id: comment.id,
  content: comment.content,
  createdAt: comment.createdAt.toISOString(),
  updatedAt: comment.updatedAt.toISOString(),
  likeCount: comment._count.likes,
  viewerHasLiked: Boolean(viewerId && (comment.likes?.length ?? 0) > 0),
  author: mapCommentAuthor(comment.author),
});

const commentInputSchema = z.object({
  content: z
    .string()
    .trim()
    .min(1, 'Kommentartext ist erforderlich.')
    .max(1000, 'Kommentare sind auf 1.000 Zeichen begrenzt.'),
});

const flagRequestSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Bitte gib eine kurze Begründung an.')
    .max(500, 'Begründungen sind auf 500 Zeichen begrenzt.')
    .optional(),
});

const moderationDecisionSchema = z.object({
  reason: z
    .string()
    .trim()
    .min(1, 'Bitte gib eine kurze Begründung an.')
    .max(500, 'Begründungen sind auf 500 Zeichen begrenzt.')
    .optional(),
});

const fetchModelComment = async (
  modelId: string,
  commentId: string,
  viewerId?: string | null,
) =>
  prisma.modelComment.findFirst({
    where: { id: commentId, modelId },
    include: buildCommentInclude(viewerId),
  });

const fetchImageComment = async (
  imageId: string,
  commentId: string,
  viewerId?: string | null,
) =>
  prisma.imageComment.findFirst({
    where: { id: commentId, imageId },
    include: buildCommentInclude(viewerId),
  });

const mapImageAsset = (asset: HydratedImageAsset, options: { viewerId?: string | null } = {}) => {
  const storage = resolveStorageLocation(asset.storagePath);
  const viewerId = options.viewerId;
  const likeCount = asset._count?.likes ?? 0;
  const viewerHasLiked = viewerId ? (asset.likes ?? []).some((entry) => entry.userId === viewerId) : false;

  return {
    id: asset.id,
    title: asset.title,
    description: asset.description,
    isPublic: asset.isPublic,
    isAdult: asset.isAdult,
    dimensions: asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined,
    fileSize: asset.fileSize,
    storagePath: storage.url ?? asset.storagePath,
    storageBucket: storage.bucket,
    storageObject: storage.objectName,
    prompt: asset.prompt,
    negativePrompt: asset.negativePrompt,
    metadata: {
      seed: asset.seed,
      model: asset.model,
      sampler: asset.sampler,
      cfgScale: asset.cfgScale,
      steps: asset.steps,
    },
    tagScan: {
      pending: asset.tagScanPending,
      status: asset.tagScanStatus,
      queuedAt: asset.tagScanQueuedAt ? asset.tagScanQueuedAt.toISOString() : null,
      completedAt: asset.tagScanCompletedAt ? asset.tagScanCompletedAt.toISOString() : null,
      error: asset.tagScanError ?? null,
    },
    autoTags: asset.autoTagSummary ?? null,
    owner: asset.owner,
    flaggedBy: asset.flaggedBy
      ? {
          id: asset.flaggedBy.id,
          displayName: asset.flaggedBy.displayName,
          email: asset.flaggedBy.email,
        }
      : null,
    tags: asset.tags.map(({ tag }) => tag),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    likeCount,
    viewerHasLiked,
    moderationStatus: asset.moderationStatus,
    flaggedAt: asset.flaggedAt,
    ...(asset.moderationReports
      ? {
          moderationReports: asset.moderationReports.map<MappedModerationReport>((report) => ({
            id: report.id,
            reason: report.reason ?? null,
            createdAt: report.createdAt.toISOString(),
            reporter: {
              id: report.reporter.id,
              displayName: report.reporter.displayName,
              email: report.reporter.email,
            },
          })),
        }
      : {}),
  };
};

const normalizeTagLabels = (tags?: string[]) => {
  if (!tags) {
    return [] as string[];
  }

  return Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  );
};

const ensureTags = async (tx: Prisma.TransactionClient, labels: string[]) =>
  Promise.all(
    labels.map((label) =>
      tx.tag.upsert({
        where: { label },
        update: {},
        create: { label },
        select: { id: true, label: true, isAdult: true },
      }),
    ),
  );

const removeStorageObject = async (bucket: string | null, objectName: string | null) => {
  if (!bucket || !objectName) {
    return;
  }

  try {
    await storageClient.removeObject(bucket, objectName);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[assets] Failed to delete object from storage', bucket, objectName, error);
  }
};

type ModelDeletionTarget = {
  id: string;
  ownerId: string;
  storagePath: string;
  previewImage: string | null;
  versions: { id: string; storagePath: string; previewImage: string | null }[];
};

type ImageDeletionTarget = {
  id: string;
  ownerId: string;
  storagePath: string;
};

const deleteModelAssetAndCleanup = async (asset: ModelDeletionTarget) => {
  const storage = resolveStorageLocation(asset.storagePath);
  const preview = resolveStorageLocation(asset.previewImage);
  const versionLocations = asset.versions.map((version) => ({
    id: version.id,
    storage: resolveStorageLocation(version.storagePath),
    preview: resolveStorageLocation(version.previewImage),
    previewImage: version.previewImage,
  }));

  await prisma.$transaction(async (tx) => {
    const linkedGalleries = await tx.galleryEntry.findMany({
      where: { assetId: asset.id },
      select: { galleryId: true },
    });
    const galleryIdsToDelete = Array.from(new Set(linkedGalleries.map((entry) => entry.galleryId)));

    await tx.galleryEntry.deleteMany({ where: { assetId: asset.id } });
    await tx.assetTag.deleteMany({ where: { assetId: asset.id } });
    await tx.modelVersion.deleteMany({ where: { modelId: asset.id } });

    if (storage.objectName) {
      await tx.storageObject.deleteMany({ where: { id: storage.objectName } });
    }

    if (preview.objectName) {
      await tx.storageObject.deleteMany({ where: { id: preview.objectName } });
    }

    for (const version of versionLocations) {
      if (version.storage.objectName) {
        await tx.storageObject.deleteMany({ where: { id: version.storage.objectName } });
      }

      if (version.preview.objectName) {
        await tx.storageObject.deleteMany({ where: { id: version.preview.objectName } });
      }

      if (version.previewImage) {
        await tx.gallery.updateMany({ where: { coverImage: version.previewImage }, data: { coverImage: null } });
      }
    }

    if (asset.previewImage) {
      await tx.gallery.updateMany({ where: { coverImage: asset.previewImage }, data: { coverImage: null } });
    }

    await tx.modelAsset.delete({ where: { id: asset.id } });

    if (galleryIdsToDelete.length > 0) {
      await tx.gallery.deleteMany({ where: { id: { in: galleryIdsToDelete } } });
    }
  });

  await Promise.all([
    removeStorageObject(storage.bucket, storage.objectName),
    removeStorageObject(preview.bucket, preview.objectName),
    ...versionLocations.flatMap((version) => [
      removeStorageObject(version.storage.bucket, version.storage.objectName),
      removeStorageObject(version.preview.bucket, version.preview.objectName),
    ]),
  ]);
};

const deleteImageAssetAndCleanup = async (image: ImageDeletionTarget) => {
  const storage = resolveStorageLocation(image.storagePath);

  await prisma.$transaction(async (tx) => {
    await tx.galleryEntry.deleteMany({ where: { imageId: image.id } });
    await tx.imageTag.deleteMany({ where: { imageId: image.id } });

    if (storage.objectName) {
      await tx.storageObject.deleteMany({ where: { id: storage.objectName } });
    }

    await tx.gallery.updateMany({ where: { coverImage: image.storagePath }, data: { coverImage: null } });
    await tx.imageAsset.delete({ where: { id: image.id } });
  });

  await removeStorageObject(storage.bucket, storage.objectName);
};

const createModerationLogEntry = async (params: {
  entityType: ModerationEntityType;
  entityId: string;
  action: ModerationActionType;
  actorId?: string;
  targetUserId?: string;
  message?: string | null;
}) => {
  await prisma.moderationLog.create({
    data: {
      entityType: params.entityType,
      entityId: params.entityId,
      action: params.action,
      ...(params.actorId ? { actorId: params.actorId } : {}),
      ...(params.targetUserId ? { targetUserId: params.targetUserId } : {}),
      message: params.message ?? null,
    },
  });

  if (params.targetUserId) {
    const moderationActionLabels: Record<ModerationActionType, string> = {
      FLAGGED: 'flagged for review',
      APPROVED: 'approved',
      REMOVED: 'removed',
    };

    const moderationEntityLabels: Record<ModerationEntityType, { noun: string; type: 'model' | 'image' }> = {
      MODEL: { noun: 'model', type: 'model' },
      IMAGE: { noun: 'image', type: 'image' },
    };

    const entityMeta = moderationEntityLabels[params.entityType];
    let entityTitle: string | null = null;

    if (params.entityType === ModerationEntityType.MODEL) {
      const asset = await prisma.modelAsset.findUnique({
        where: { id: params.entityId },
        select: { title: true },
      });
      entityTitle = asset?.title ?? null;
    } else if (params.entityType === ModerationEntityType.IMAGE) {
      const asset = await prisma.imageAsset.findUnique({
        where: { id: params.entityId },
        select: { title: true },
      });
      entityTitle = asset?.title ?? null;
    }

    const actionLabel = moderationActionLabels[params.action];
    const title = `Moderation update: Your ${entityMeta.noun} was ${actionLabel}.`;

    await createNotification({
      userId: params.targetUserId,
      type: NotificationType.MODERATION,
      title,
      body: params.message ?? null,
      data: {
        category: 'moderation',
        entityType: entityMeta.type,
        entityId: params.entityId,
        entityTitle,
        action: params.action,
        reason: params.message ?? null,
      },
    });
  }
};

const updateModelSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  description: z
    .string()
    .trim()
    .max(1500)
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) {
        return null;
      }

      return value.length > 0 ? value : null;
    }),
  trigger: z.string().trim().min(1).max(180).optional(),
  version: z.string().trim().max(80).optional(),
  tags: z.array(z.string()).optional(),
  ownerId: z.string().trim().min(1).optional(),
  isPublic: z.boolean().optional(),
});

const updateImageSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z
    .string()
    .trim()
    .max(1500)
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) {
        return null;
      }

      return value.length > 0 ? value : null;
    }),
  prompt: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) {
        return null;
      }

      return value.length > 0 ? value : null;
    }),
  negativePrompt: z
    .string()
    .trim()
    .max(2000)
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) {
        return null;
      }

      return value.length > 0 ? value : null;
    }),
  metadata: z
    .object({
      seed: z.string().trim().nullable().optional(),
      model: z.string().trim().nullable().optional(),
      sampler: z.string().trim().nullable().optional(),
      cfgScale: z.number().nullable().optional(),
      steps: z.number().nullable().optional(),
    })
    .partial()
    .optional(),
  tags: z.array(z.string()).optional(),
  ownerId: z.string().trim().min(1).optional(),
  isPublic: z.boolean().optional(),
});

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1),
});

const versionUploadSchema = z.object({
  version: z.string().trim().min(1).max(80),
});

const versionUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 2,
    fileSize: MAX_TOTAL_SIZE_BYTES,
  },
});

const versionUpdateSchema = z
  .object({
    version: z
      .string()
      .trim()
      .min(1, { message: 'Die Versionsbezeichnung darf nicht leer sein.' })
      .max(80, { message: 'Die Versionsbezeichnung ist zu lang.' })
      .optional(),
  })
  .refine((value) => value.version !== undefined, {
    message: 'Es wurden keine Änderungen übermittelt.',
    path: ['version'],
  });

const galleryLinkNoteSchema = z
  .string()
  .trim()
  .max(600)
  .nullable()
  .transform((value) => {
    if (value == null) {
      return null;
    }

    return value.length > 0 ? value : null;
  });

const linkModelToGallerySchema = z.object({
  galleryId: z.string().trim().min(1),
  note: galleryLinkNoteSchema.optional(),
});

const toS3Uri = (bucket: string, objectName: string) => `s3://${bucket}/${objectName}`;

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;

type PaginationConfig = {
  limit: number;
  cursor: string | null;
  skip?: number;
};

const coercePositiveInt = (value: unknown): number | null => {
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  return null;
};

const parsePagination = (query: Record<string, unknown>): PaginationConfig => {
  const cursor = typeof query.cursor === 'string' && query.cursor.trim().length > 0 ? query.cursor.trim() : null;
  const takeParam = coercePositiveInt(query.take);
  const pageParam = coercePositiveInt(query.page);
  const pageSizeParam = coercePositiveInt(query.pageSize);

  const requestedSize = pageSizeParam ?? takeParam ?? DEFAULT_PAGE_SIZE;
  const limit = Math.min(Math.max(requestedSize, 1), MAX_PAGE_SIZE);

  if (cursor) {
    return { limit, cursor };
  }

  if (pageParam && pageParam > 1) {
    const skip = (pageParam - 1) * limit;
    return { limit, cursor: null, skip };
  }

  return { limit, cursor: null };
};

export const assetsRouter = Router();

assetsRouter.get('/models', async (req, res, next) => {
  try {
    const viewer = req.user;
    const isAdmin = viewer?.role === 'ADMIN';
    const allowAdultContent = isAdmin ? true : viewer?.showAdultContent ?? false;
    const filters: Prisma.ModelAssetWhereInput[] = [];

    if (!isAdmin) {
      if (viewer) {
        filters.push({
          OR: [
            { ownerId: viewer.id },
            {
              AND: [
                { isPublic: true },
                { moderationStatus: ModerationStatus.ACTIVE },
              ],
            },
          ],
        });
      } else {
        filters.push({
          isPublic: true,
          moderationStatus: ModerationStatus.ACTIVE,
        });
      }
    }

    if (!allowAdultContent) {
      if (viewer) {
        filters.push({
          OR: [{ isAdult: false }, { ownerId: viewer.id }],
        });
      } else {
        filters.push({ isAdult: false });
      }
    }

    let where: Prisma.ModelAssetWhereInput = {};
    if (filters.length === 1) {
      where = filters[0] ?? {};
    } else if (filters.length > 1) {
      where = { AND: filters };
    }

    const pagination = parsePagination(req.query as Record<string, unknown>);
    const limitWithLookahead = pagination.limit + 1;

    const assets = await prisma.modelAsset.findMany({
      where,
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
        flaggedBy: { select: { id: true, displayName: true, email: true } },
        versions: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: limitWithLookahead,
      ...(pagination.cursor
        ? {
            cursor: { id: pagination.cursor },
            skip: 1,
          }
        : {}),
      ...(pagination.skip
        ? {
            skip: pagination.skip,
          }
        : {}),
    });

    const hasMore = assets.length > pagination.limit;
    const trimmed = hasMore ? assets.slice(0, pagination.limit) : assets;
    const nextCursor = hasMore ? trimmed[trimmed.length - 1]?.id ?? null : null;

    res.json({
      items: trimmed.map(mapModelAsset),
      nextCursor,
      hasMore,
    });
  } catch (error) {
    next(error);
  }
});

assetsRouter.get('/images', async (req, res, next) => {
  try {
    const viewer = req.user;
    const isAdmin = viewer?.role === 'ADMIN';
    const allowAdultContent = isAdmin ? true : viewer?.showAdultContent ?? false;
    const filters: Prisma.ImageAssetWhereInput[] = [];

    if (!isAdmin) {
      if (viewer) {
        filters.push({
          OR: [
            { ownerId: viewer.id },
            {
              AND: [
                { isPublic: true },
                { moderationStatus: ModerationStatus.ACTIVE },
              ],
            },
          ],
        });
      } else {
        filters.push({
          isPublic: true,
          moderationStatus: ModerationStatus.ACTIVE,
        });
      }
    }

    if (!allowAdultContent) {
      if (viewer) {
        filters.push({
          OR: [{ isAdult: false }, { ownerId: viewer.id }],
        });
      } else {
        filters.push({ isAdult: false });
      }
    }

    let where: Prisma.ImageAssetWhereInput = {};
    if (filters.length === 1) {
      where = filters[0] ?? {};
    } else if (filters.length > 1) {
      where = { AND: filters };
    }

    const pagination = parsePagination(req.query as Record<string, unknown>);
    const limitWithLookahead = pagination.limit + 1;

    const images = await prisma.imageAsset.findMany({
      where,
      include: buildImageInclude(viewer?.id),
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' },
      ],
      take: limitWithLookahead,
      ...(pagination.cursor
        ? {
            cursor: { id: pagination.cursor },
            skip: 1,
          }
        : {}),
      ...(pagination.skip
        ? {
            skip: pagination.skip,
          }
        : {}),
    });

    const hasMore = images.length > pagination.limit;
    const trimmed = hasMore ? images.slice(0, pagination.limit) : images;
    const nextCursor = hasMore ? trimmed[trimmed.length - 1]?.id ?? null : null;

    res.json({
      items: trimmed.map((image) => mapImageAsset(image, { viewerId: viewer?.id ?? null })),
      nextCursor,
      hasMore,
    });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/models/:id/flag', requireAuth, async (req, res, next) => {
  try {
    const parsed = flagRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    const { id: modelId } = req.params;
    if (!modelId) {
      res.status(400).json({ message: 'Model-ID fehlt.' });
      return;
    }

    const model = await prisma.modelAsset.findUnique({
      where: { id: modelId },
      select: { id: true, ownerId: true, moderationStatus: true },
    });

    if (!model) {
      res.status(404).json({ message: 'Das Modell wurde nicht gefunden.' });
      return;
    }

    if (model.moderationStatus === ModerationStatus.REMOVED) {
      res.status(404).json({ message: 'Das Modell wurde nicht gefunden.' });
      return;
    }

    const includeConfig = {
      tags: { include: { tag: true } },
      owner: { select: { id: true, displayName: true, email: true } },
      flaggedBy: { select: { id: true, displayName: true, email: true } },
      versions: { orderBy: { createdAt: 'desc' } },
      moderationReports: {
        include: { reporter: { select: { id: true, displayName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
      },
    } as const;

    const updated = await prisma.$transaction(async (tx) => {
      if (model.moderationStatus !== ModerationStatus.FLAGGED) {
        await tx.modelAsset.update({
          where: { id: modelId },
          data: {
            moderationStatus: ModerationStatus.FLAGGED,
            flaggedAt: new Date(),
            flaggedBy: { connect: { id: req.user!.id } },
          },
        });
      } else {
        await tx.modelAsset.update({
          where: { id: modelId },
          data: {
            flaggedBy: { connect: { id: req.user!.id } },
          },
        });
      }

      await tx.modelModerationReport.create({
        data: {
          modelId,
          reporterId: req.user!.id,
          reason: parsed.data.reason ?? null,
        },
      });

      return tx.modelAsset.findUnique({
        where: { id: modelId },
        include: includeConfig,
      });
    });

    if (!updated) {
      res.status(500).json({ message: 'Das Modell konnte nicht aktualisiert werden.' });
      return;
    }

    if (model.moderationStatus !== ModerationStatus.FLAGGED) {
      await createModerationLogEntry({
        entityType: ModerationEntityType.MODEL,
        entityId: updated.id,
        action: ModerationActionType.FLAGGED,
        actorId: req.user!.id,
        targetUserId: updated.owner.id,
        message: parsed.data.reason ?? null,
      });
    }

    res.json({ model: mapModelAsset(updated) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/images/:id/flag', requireAuth, async (req, res, next) => {
  try {
    const parsed = flagRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    const { id: imageId } = req.params;
    if (!imageId) {
      res.status(400).json({ message: 'Bild-ID fehlt.' });
      return;
    }

    const image = await prisma.imageAsset.findUnique({
      where: { id: imageId },
      select: { id: true, ownerId: true, moderationStatus: true },
    });

    if (!image) {
      res.status(404).json({ message: 'Bild konnte nicht gefunden werden.' });
      return;
    }

    if (image.moderationStatus === ModerationStatus.REMOVED) {
      res.status(404).json({ message: 'Bild konnte nicht gefunden werden.' });
      return;
    }

    const includeConfig = {
      ...buildImageInclude(req.user?.id),
      moderationReports: {
        include: { reporter: { select: { id: true, displayName: true, email: true } } },
        orderBy: { createdAt: 'desc' },
      },
    } as const;

    const updated = await prisma.$transaction(async (tx) => {
      if (image.moderationStatus !== ModerationStatus.FLAGGED) {
        await tx.imageAsset.update({
          where: { id: imageId },
          data: {
            moderationStatus: ModerationStatus.FLAGGED,
            flaggedAt: new Date(),
            flaggedBy: { connect: { id: req.user!.id } },
          },
        });
      } else {
        await tx.imageAsset.update({
          where: { id: imageId },
          data: {
            flaggedBy: { connect: { id: req.user!.id } },
          },
        });
      }

      await tx.imageModerationReport.create({
        data: {
          imageId,
          reporterId: req.user!.id,
          reason: parsed.data.reason ?? null,
        },
      });

      return tx.imageAsset.findUnique({
        where: { id: imageId },
        include: includeConfig,
      });
    });

    if (!updated) {
      res.status(500).json({ message: 'Bild konnte nicht aktualisiert werden.' });
      return;
    }

    if (image.moderationStatus !== ModerationStatus.FLAGGED) {
      await createModerationLogEntry({
        entityType: ModerationEntityType.IMAGE,
        entityId: updated.id,
        action: ModerationActionType.FLAGGED,
        actorId: req.user!.id,
        targetUserId: updated.owner.id,
        message: parsed.data.reason ?? null,
      });
    }

    res.json({ image: mapImageAsset(updated, { viewerId: req.user?.id ?? null }) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.get('/moderation/queue', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const [models, images] = await Promise.all([
      prisma.modelAsset.findMany({
        where: { moderationStatus: ModerationStatus.FLAGGED },
        include: {
          tags: { include: { tag: true } },
          owner: { select: { id: true, displayName: true, email: true } },
          flaggedBy: { select: { id: true, displayName: true, email: true } },
          versions: { orderBy: { createdAt: 'desc' } },
          moderationReports: {
            include: { reporter: { select: { id: true, displayName: true, email: true } } },
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: [{ flaggedAt: 'desc' }, { createdAt: 'desc' }],
      }),
      prisma.imageAsset.findMany({
        where: { moderationStatus: ModerationStatus.FLAGGED },
        include: {
          ...buildImageInclude(req.user?.id),
          moderationReports: {
            include: { reporter: { select: { id: true, displayName: true, email: true } } },
            orderBy: { createdAt: 'desc' },
          },
        },
        orderBy: [{ flaggedAt: 'desc' }, { createdAt: 'desc' }],
      }),
    ]);

    const mappedModels = models.map((model) => {
      const snapshot = buildModelModerationSnapshot(model);
      const mapped = mapModelAsset(model);
      return snapshot ? { ...mapped, nsfw: snapshot } : mapped;
    });

    const mappedImages = images.map((image) => {
      const snapshot = buildImageModerationSnapshot(image);
      const mapped = mapImageAsset(image, { viewerId: req.user?.id ?? null });
      return snapshot ? { ...mapped, nsfw: snapshot } : mapped;
    });

    res.json({
      models: mappedModels,
      images: mappedImages,
    });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/models/:id/moderation/approve', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id: modelId } = req.params;
    if (!modelId) {
      res.status(400).json({ message: 'Model-ID fehlt.' });
      return;
    }

    const model = await prisma.modelAsset.findUnique({
      where: { id: modelId },
      select: { id: true, ownerId: true, moderationStatus: true },
    });

    if (!model) {
      res.status(404).json({ message: 'Das Modell wurde nicht gefunden.' });
      return;
    }

    if (model.moderationStatus === ModerationStatus.REMOVED) {
      res.status(404).json({ message: 'Das Modell wurde nicht gefunden.' });
      return;
    }

    if (model.moderationStatus !== ModerationStatus.FLAGGED) {
      res.status(400).json({ message: 'Das Modell befindet sich nicht im Prüfstatus.' });
      return;
    }

    const refreshed = await prisma.modelAsset.update({
      where: { id: modelId },
      data: {
        moderationStatus: ModerationStatus.ACTIVE,
        flaggedAt: null,
        flaggedBy: { disconnect: true },
      },
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
        flaggedBy: { select: { id: true, displayName: true, email: true } },
        versions: { orderBy: { createdAt: 'desc' } },
      },
    });

    await createModerationLogEntry({
      entityType: ModerationEntityType.MODEL,
      entityId: refreshed.id,
      action: ModerationActionType.APPROVED,
      actorId: req.user!.id,
      targetUserId: refreshed.owner.id,
      message: 'Freigabe nach Überprüfung.',
    });

    res.json({ model: mapModelAsset(refreshed) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/models/:id/moderation/remove', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id: modelId } = req.params;
    if (!modelId) {
      res.status(400).json({ message: 'Model-ID fehlt.' });
      return;
    }

    const parsed = moderationDecisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    const trimmedReason = parsed.data.reason?.trim() ?? '';
    if (trimmedReason.length === 0) {
      res.status(400).json({ message: 'Bitte gib eine Begründung für die Ablehnung an.' });
      return;
    }

    const model = await prisma.modelAsset.findUnique({
      where: { id: modelId },
      select: {
        id: true,
        ownerId: true,
        moderationStatus: true,
        storagePath: true,
        previewImage: true,
        versions: { select: { id: true, storagePath: true, previewImage: true } },
      },
    });

    if (!model) {
      res.status(404).json({ message: 'Das Modell wurde nicht gefunden.' });
      return;
    }

    if (model.moderationStatus === ModerationStatus.REMOVED) {
      res.status(404).json({ message: 'Das Modell wurde nicht gefunden.' });
      return;
    }

    await deleteModelAssetAndCleanup(model);

    await createModerationLogEntry({
      entityType: ModerationEntityType.MODEL,
      entityId: model.id,
      action: ModerationActionType.REMOVED,
      actorId: req.user!.id,
      targetUserId: model.ownerId,
      message: trimmedReason,
    });

    res.json({ removed: model.id });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/images/:id/moderation/approve', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id: imageId } = req.params;
    if (!imageId) {
      res.status(400).json({ message: 'Bild-ID fehlt.' });
      return;
    }

    const image = await prisma.imageAsset.findUnique({
      where: { id: imageId },
      select: { id: true, ownerId: true, moderationStatus: true },
    });

    if (!image) {
      res.status(404).json({ message: 'Bild konnte nicht gefunden werden.' });
      return;
    }

    if (image.moderationStatus === ModerationStatus.REMOVED) {
      res.status(404).json({ message: 'Bild konnte nicht gefunden werden.' });
      return;
    }

    if (image.moderationStatus !== ModerationStatus.FLAGGED) {
      res.status(400).json({ message: 'Das Bild befindet sich nicht im Prüfstatus.' });
      return;
    }

    const refreshed = await prisma.imageAsset.update({
      where: { id: imageId },
      data: {
        moderationStatus: ModerationStatus.ACTIVE,
        flaggedAt: null,
        flaggedBy: { disconnect: true },
      },
      include: buildImageInclude(req.user?.id),
    });

    await createModerationLogEntry({
      entityType: ModerationEntityType.IMAGE,
      entityId: refreshed.id,
      action: ModerationActionType.APPROVED,
      actorId: req.user!.id,
      targetUserId: refreshed.owner.id,
      message: 'Freigabe nach Überprüfung.',
    });

    res.json({ image: mapImageAsset(refreshed, { viewerId: req.user?.id ?? null }) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/images/:id/moderation/remove', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { id: imageId } = req.params;
    if (!imageId) {
      res.status(400).json({ message: 'Bild-ID fehlt.' });
      return;
    }

    const parsed = moderationDecisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    const trimmedReason = parsed.data.reason?.trim() ?? '';
    if (trimmedReason.length === 0) {
      res.status(400).json({ message: 'Bitte gib eine Begründung für die Ablehnung an.' });
      return;
    }

    const image = await prisma.imageAsset.findUnique({
      where: { id: imageId },
      select: { id: true, ownerId: true, moderationStatus: true, storagePath: true },
    });

    if (!image) {
      res.status(404).json({ message: 'Bild konnte nicht gefunden werden.' });
      return;
    }

    if (image.moderationStatus === ModerationStatus.REMOVED) {
      res.status(404).json({ message: 'Bild konnte nicht gefunden werden.' });
      return;
    }

    await deleteImageAssetAndCleanup(image);

    await createModerationLogEntry({
      entityType: ModerationEntityType.IMAGE,
      entityId: image.id,
      action: ModerationActionType.REMOVED,
      actorId: req.user!.id,
      targetUserId: image.ownerId,
      message: trimmedReason,
    });

    res.json({ removed: image.id });
  } catch (error) {
    next(error);
  }
});

const ensureModelCommentAccess = async (modelId: string, viewerId: string | null, role: string | null) => {
  const model = await prisma.modelAsset.findUnique({
    where: { id: modelId },
    select: { id: true, ownerId: true, isPublic: true, moderationStatus: true, title: true },
  });

  if (!model) {
    return { status: 404, message: 'Modell konnte nicht gefunden werden.' } as const;
  }

  if (model.moderationStatus === ModerationStatus.REMOVED && role !== 'ADMIN') {
    return { status: 404, message: 'Modell konnte nicht gefunden werden.' } as const;
  }

  if (!model.isPublic && role !== 'ADMIN' && model.ownerId !== viewerId) {
    return { status: 403, message: 'Keine Berechtigung für dieses Modell.' } as const;
  }

  return { status: 200, model } as const;
};

const ensureImageVisibility = async (imageId: string, viewerId: string | null, role: string | null) => {
  const image = await prisma.imageAsset.findUnique({
    where: { id: imageId },
    select: { id: true, ownerId: true, isPublic: true, moderationStatus: true, title: true },
  });

  if (!image) {
    return { status: 404, message: 'Bild konnte nicht gefunden werden.' } as const;
  }

  if (image.moderationStatus === ModerationStatus.REMOVED && role !== 'ADMIN') {
    return { status: 404, message: 'Bild konnte nicht gefunden werden.' } as const;
  }

  if (!image.isPublic && role !== 'ADMIN' && image.ownerId !== viewerId) {
    return { status: 403, message: 'Keine Berechtigung für dieses Bild.' } as const;
  }

  return { status: 200, image } as const;
};

const ensureImageLikeAccess = async (imageId: string, userId: string, role: string) =>
  ensureImageVisibility(imageId, userId, role);

const respondWithUpdatedImage = async (
  res: Response,
  imageId: string,
  viewerId: string,
) => {
  const updated = await prisma.imageAsset.findUnique({
    where: { id: imageId },
    include: buildImageInclude(viewerId),
  });

  if (!updated) {
    res.status(404).json({ message: 'Bild konnte nicht gefunden werden.' });
    return;
  }

  res.json({ image: mapImageAsset(updated, { viewerId }) });
};

assetsRouter.post('/images/:id/likes', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { id: imageId } = req.params;
    if (!imageId) {
      res.status(400).json({ message: 'Bild-ID fehlt.' });
      return;
    }

    const access = await ensureImageLikeAccess(imageId, req.user.id, req.user.role);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    const { image } = access;

    await prisma.imageLike.upsert({
      where: { userId_imageId: { userId: req.user.id, imageId } },
      update: {},
      create: { userId: req.user.id, imageId },
    });

    if (image.ownerId !== req.user.id) {
      await createNotification({
        userId: image.ownerId,
        type: NotificationType.LIKE,
        title: `${req.user.displayName} liked your image${image.title ? ` "${image.title}"` : ''}.`,
        data: {
          category: 'like',
          entityType: 'image',
          entityId: image.id,
          entityTitle: image.title ?? null,
          actorId: req.user.id,
          actorName: req.user.displayName,
        },
      });
    }

    await respondWithUpdatedImage(res, imageId, req.user.id);
  } catch (error) {
    next(error);
  }
});

assetsRouter.delete('/images/:id/likes', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { id: imageId } = req.params;
    if (!imageId) {
      res.status(400).json({ message: 'Bild-ID fehlt.' });
      return;
    }

    const access = await ensureImageLikeAccess(imageId, req.user.id, req.user.role);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    await prisma.imageLike.deleteMany({ where: { userId: req.user.id, imageId } });

    await respondWithUpdatedImage(res, imageId, req.user.id);
  } catch (error) {
    next(error);
  }
});

assetsRouter.get('/models/:modelId/comments', async (req, res, next) => {
  try {
    const { modelId } = req.params;
    if (!modelId) {
      res.status(400).json({ message: 'Modell-ID fehlt.' });
      return;
    }

    const viewerId = req.user?.id ?? null;
    const viewerRole = req.user?.role ?? null;
    const access = await ensureModelCommentAccess(modelId, viewerId, viewerRole);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    const comments = await prisma.modelComment.findMany({
      where: { modelId },
      orderBy: { createdAt: 'asc' },
      include: buildCommentInclude(viewerId),
    });

    res.json({ comments: comments.map((comment) => mapModelComment(comment, viewerId)) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/models/:modelId/comments', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { modelId } = req.params;
    if (!modelId) {
      res.status(400).json({ message: 'Modell-ID fehlt.' });
      return;
    }

    const access = await ensureModelCommentAccess(modelId, req.user.id, req.user.role);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    const { model } = access;

    const parsed = commentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Kommentar konnte nicht gespeichert werden.', errors: parsed.error.flatten() });
      return;
    }

    const content = parsed.data.content.trim();

    const created = await prisma.modelComment.create({
      data: { modelId, authorId: req.user.id, content },
      include: buildCommentInclude(req.user.id),
    });

    if (model.ownerId !== req.user.id) {
      const snippet = content.length > 140 ? `${content.slice(0, 137)}...` : content;
      await createNotification({
        userId: model.ownerId,
        type: NotificationType.COMMENT,
        title: `${req.user.displayName} commented on your model${model.title ? ` "${model.title}"` : ''}.`,
        body: snippet,
        data: {
          category: 'comment',
          entityType: 'model',
          entityId: model.id,
          entityTitle: model.title ?? null,
          actorId: req.user.id,
          actorName: req.user.displayName,
          commentId: created.id,
          snippet,
        },
      });
    }

    res.status(201).json({ comment: mapModelComment(created, req.user.id) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/models/:modelId/comments/:commentId/like', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { modelId, commentId } = req.params;
    if (!modelId || !commentId) {
      res.status(400).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    const access = await ensureModelCommentAccess(modelId, req.user.id, req.user.role);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    const existing = await fetchModelComment(modelId, commentId, req.user.id);
    if (!existing) {
      res.status(404).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    await prisma.modelCommentLike.upsert({
      where: { commentId_userId: { commentId, userId: req.user.id } },
      update: {},
      create: { commentId, userId: req.user.id },
    });

    const refreshed = await fetchModelComment(modelId, commentId, req.user.id);
    if (!refreshed) {
      res.status(404).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    res.json({ comment: mapModelComment(refreshed, req.user.id) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.delete('/models/:modelId/comments/:commentId/like', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { modelId, commentId } = req.params;
    if (!modelId || !commentId) {
      res.status(400).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    const access = await ensureModelCommentAccess(modelId, req.user.id, req.user.role);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    const existing = await fetchModelComment(modelId, commentId, req.user.id);
    if (!existing) {
      res.status(404).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    await prisma.modelCommentLike.deleteMany({ where: { commentId, userId: req.user.id } });

    const refreshed = await fetchModelComment(modelId, commentId, req.user.id);
    if (!refreshed) {
      res.status(404).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    res.json({ comment: mapModelComment(refreshed, req.user.id) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.get('/images/:imageId/comments', async (req, res, next) => {
  try {
    const { imageId } = req.params;
    if (!imageId) {
      res.status(400).json({ message: 'Bild-ID fehlt.' });
      return;
    }

    const viewerId = req.user?.id ?? null;
    const viewerRole = req.user?.role ?? null;
    const access = await ensureImageVisibility(imageId, viewerId, viewerRole);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    const comments = await prisma.imageComment.findMany({
      where: { imageId },
      orderBy: { createdAt: 'asc' },
      include: buildCommentInclude(viewerId),
    });

    res.json({ comments: comments.map((comment) => mapImageComment(comment, viewerId)) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/images/:imageId/comments', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { imageId } = req.params;
    if (!imageId) {
      res.status(400).json({ message: 'Bild-ID fehlt.' });
      return;
    }

    const access = await ensureImageVisibility(imageId, req.user.id, req.user.role);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    const { image } = access;

    const parsed = commentInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Kommentar konnte nicht gespeichert werden.', errors: parsed.error.flatten() });
      return;
    }

    const content = parsed.data.content.trim();

    const created = await prisma.imageComment.create({
      data: { imageId, authorId: req.user.id, content },
      include: buildCommentInclude(req.user.id),
    });

    if (image.ownerId !== req.user.id) {
      const snippet = content.length > 140 ? `${content.slice(0, 137)}...` : content;
      await createNotification({
        userId: image.ownerId,
        type: NotificationType.COMMENT,
        title: `${req.user.displayName} commented on your image${image.title ? ` "${image.title}"` : ''}.`,
        body: snippet,
        data: {
          category: 'comment',
          entityType: 'image',
          entityId: image.id,
          entityTitle: image.title ?? null,
          actorId: req.user.id,
          actorName: req.user.displayName,
          commentId: created.id,
          snippet,
        },
      });
    }

    res.status(201).json({ comment: mapImageComment(created, req.user.id) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/images/:imageId/comments/:commentId/like', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { imageId, commentId } = req.params;
    if (!imageId || !commentId) {
      res.status(400).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    const access = await ensureImageVisibility(imageId, req.user.id, req.user.role);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    const existing = await fetchImageComment(imageId, commentId, req.user.id);
    if (!existing) {
      res.status(404).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    await prisma.imageCommentLike.upsert({
      where: { commentId_userId: { commentId, userId: req.user.id } },
      update: {},
      create: { commentId, userId: req.user.id },
    });

    const refreshed = await fetchImageComment(imageId, commentId, req.user.id);
    if (!refreshed) {
      res.status(404).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    res.json({ comment: mapImageComment(refreshed, req.user.id) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.delete('/images/:imageId/comments/:commentId/like', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { imageId, commentId } = req.params;
    if (!imageId || !commentId) {
      res.status(400).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    const access = await ensureImageVisibility(imageId, req.user.id, req.user.role);
    if (access.status !== 200) {
      res.status(access.status).json({ message: access.message });
      return;
    }

    const existing = await fetchImageComment(imageId, commentId, req.user.id);
    if (!existing) {
      res.status(404).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    await prisma.imageCommentLike.deleteMany({ where: { commentId, userId: req.user.id } });

    const refreshed = await fetchImageComment(imageId, commentId, req.user.id);
    if (!refreshed) {
      res.status(404).json({ message: 'Kommentar konnte nicht gefunden werden.' });
      return;
    }

    res.json({ comment: mapImageComment(refreshed, req.user.id) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/models/bulk-delete', requireAuth, requireCurator, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const parsed = bulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Ungültige Anfrage.', errors: parsed.error.flatten() });
      return;
    }

    const ids = Array.from(new Set(parsed.data.ids));
    const assets = await prisma.modelAsset.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        ownerId: true,
        storagePath: true,
        previewImage: true,
        versions: { select: { id: true, storagePath: true, previewImage: true } },
      },
    });

    if (assets.length === 0) {
      res.status(404).json({ message: 'Keine passenden Modelle gefunden.' });
      return;
    }

    const isAdmin = req.user.role === 'ADMIN';
    const unauthorized = assets.filter((asset) => !isAdmin && asset.ownerId !== req.user?.id);

    if (unauthorized.length > 0) {
      res.status(403).json({ message: 'Mindestens ein Modell gehört nicht zum eigenen Bestand.' });
      return;
    }

    const deletionPlan = assets.map((asset) => ({
      id: asset.id,
      storage: resolveStorageLocation(asset.storagePath),
      preview: resolveStorageLocation(asset.previewImage),
      previewImage: asset.previewImage,
      versions: asset.versions.map((version) => ({
        id: version.id,
        storage: resolveStorageLocation(version.storagePath),
        preview: resolveStorageLocation(version.previewImage),
        previewImage: version.previewImage,
      })),
    }));

    await prisma.$transaction(async (tx) => {
      for (const entry of deletionPlan) {
        await tx.galleryEntry.deleteMany({ where: { assetId: entry.id } });
        await tx.assetTag.deleteMany({ where: { assetId: entry.id } });
        await tx.modelVersion.deleteMany({ where: { modelId: entry.id } });
        if (entry.storage.objectName) {
          await tx.storageObject.deleteMany({ where: { id: entry.storage.objectName } });
        }
        if (entry.preview.objectName) {
          await tx.storageObject.deleteMany({ where: { id: entry.preview.objectName } });
        }
        for (const version of entry.versions) {
          if (version.storage.objectName) {
            await tx.storageObject.deleteMany({ where: { id: version.storage.objectName } });
          }
          if (version.preview.objectName) {
            await tx.storageObject.deleteMany({ where: { id: version.preview.objectName } });
          }
          if (version.previewImage) {
            await tx.gallery.updateMany({ where: { coverImage: version.previewImage }, data: { coverImage: null } });
          }
        }
        if (entry.previewImage) {
          await tx.gallery.updateMany({ where: { coverImage: entry.previewImage }, data: { coverImage: null } });
        }
        await tx.modelAsset.delete({ where: { id: entry.id } });
      }
    });

    await Promise.all(
      deletionPlan.map(async (entry) => {
        await removeStorageObject(entry.storage.bucket, entry.storage.objectName);
        await removeStorageObject(entry.preview.bucket, entry.preview.objectName);
        await Promise.all(
          entry.versions.map(async (version) => {
            await removeStorageObject(version.storage.bucket, version.storage.objectName);
            await removeStorageObject(version.preview.bucket, version.preview.objectName);
          }),
        );
      }),
    );

    res.json({ deleted: deletionPlan.map((entry) => entry.id) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.post(
  '/models/:id/versions',
  requireAuth,
  versionUpload.fields([
    { name: 'model', maxCount: 1 },
    { name: 'preview', maxCount: 1 },
  ]),
  async (req, res, next) => {
    try {
      if (!req.user) {
        res.status(401).json({ message: 'Authentifizierung erforderlich.' });
        return;
      }

      const { id: assetId } = req.params;
      if (!assetId) {
        res.status(400).json({ message: 'Model-ID fehlt.' });
        return;
      }

      const parseResult = versionUploadSchema.safeParse(req.body);
      if (!parseResult.success) {
        res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parseResult.error.flatten() });
        return;
      }

      const files = req.files as Record<string, Express.Multer.File[]> | undefined;
      const modelFile = files?.model?.[0];
      const previewFile = files?.preview?.[0];

      if (!modelFile) {
        res.status(400).json({ message: 'Es wurde keine Safetensors-Datei übermittelt.' });
        return;
      }

      if (!modelFile.originalname.toLowerCase().endsWith('.safetensors')) {
        res.status(400).json({ message: 'Nur Safetensors-Dateien werden als Modellversion akzeptiert.' });
        return;
      }

      if (!previewFile) {
        res.status(400).json({ message: 'Bitte lade ein Vorschaubild für die neue Version hoch.' });
        return;
      }

      if (!previewFile.mimetype.startsWith('image/')) {
        res.status(400).json({ message: 'Das Vorschaubild muss ein gültiges Bildformat besitzen.' });
        return;
      }

      const previewImageAnalysis = await runNsfwImageAnalysis(previewFile.buffer, { priority: 'high' });

      let previewMetadataPayload: Prisma.JsonObject | null = null;
      let previewModerationSummary: ImageModerationSummary | null = null;
      try {
        const extracted = await extractImageMetadata(previewFile);
        previewMetadataPayload = toJsonImageMetadata(extracted);
      } catch {
        previewMetadataPayload = null;
      }

      try {
        previewModerationSummary = await analyzeImageModeration(previewFile.buffer);
      } catch (error) {
        console.warn('Failed to analyze model preview for moderation heuristics.', {
          modelId: assetId,
          error,
        });
        previewModerationSummary = null;
      }

      const asset = await prisma.modelAsset.findUnique({
        where: { id: assetId },
        include: {
          owner: { select: { id: true, displayName: true, email: true } },
          tags: { include: { tag: true } },
          versions: { orderBy: { createdAt: 'desc' } },
          flaggedBy: { select: { id: true, displayName: true, email: true } },
        },
      });

      if (!asset) {
        res.status(404).json({ message: 'Das angeforderte Modell wurde nicht gefunden.' });
        return;
      }

      if (asset.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
        res.status(403).json({ message: 'Keine Berechtigung zum Aktualisieren dieses Modells.' });
        return;
      }

      const requestedVersion = parseResult.data.version.trim();
      const normalizedRequested = requestedVersion.toLowerCase();
      const existingVersions = [asset.version, ...asset.versions.map((entry) => entry.version.toLowerCase())];
      if (existingVersions.some((entry) => entry === normalizedRequested)) {
        res.status(409).json({ message: `Version "${requestedVersion}" ist bereits vorhanden.` });
        return;
      }

      const modelBucket = storageBuckets.models;
      const previewBucket = storageBuckets.images;
      const modelObjectName = crypto.randomUUID();
      const previewObjectName = crypto.randomUUID();

      let modelUpload: { bucket: string; objectName: string } | null = null;
      let previewUpload: { bucket: string; objectName: string } | null = null;

      try {
        await storageClient.putObject(modelBucket, modelObjectName, modelFile.buffer, modelFile.size, {
          'Content-Type': modelFile.mimetype || 'application/octet-stream',
        });
        modelUpload = { bucket: modelBucket, objectName: modelObjectName };

        await storageClient.putObject(previewBucket, previewObjectName, previewFile.buffer, previewFile.size, {
          'Content-Type': previewFile.mimetype || 'image/jpeg',
        });
        previewUpload = { bucket: previewBucket, objectName: previewObjectName };
      } catch (error) {
        if (modelUpload) {
          await removeStorageObject(modelUpload.bucket, modelUpload.objectName);
          modelUpload = null;
        }
        if (previewUpload) {
          await removeStorageObject(previewUpload.bucket, previewUpload.objectName);
          previewUpload = null;
        }
        throw error;
      }

      const checksum = crypto.createHash('sha256').update(modelFile.buffer).digest('hex');
      const extractedMetadata = extractModelMetadataFromFile(modelFile);
      const previewAnalysisPayload = previewImageAnalysis ? toJsonImageAnalysis(previewImageAnalysis) : null;

      const metadataPayload: Prisma.JsonObject = {
        originalFileName: modelFile.originalname,
        checksum,
      };

      if (previewAnalysisPayload) {
        metadataPayload.nsfwImageAnalysis = previewAnalysisPayload;
      }

      const metadataScreening = extractedMetadata?.nsfwMetadata ?? null;

      if (previewMetadataPayload) {
        if (previewAnalysisPayload) {
          const nsfwPayload = ((previewMetadataPayload.nsfw as Prisma.JsonObject | undefined) ?? {}) as Prisma.JsonObject;
          nsfwPayload.imageAnalysis = previewAnalysisPayload;
          previewMetadataPayload.nsfw = nsfwPayload;
        }
        metadataPayload.preview = previewMetadataPayload;
      } else if (previewAnalysisPayload) {
        metadataPayload.preview = {
          nsfw: {
            imageAnalysis: previewAnalysisPayload,
          },
        } as Prisma.JsonObject;
      }

      if (previewModerationSummary) {
        metadataPayload.moderation = serializeModerationSummary(previewModerationSummary);
      }

      if (extractedMetadata) {
        metadataPayload.baseModel = extractedMetadata.baseModel ?? null;
        metadataPayload.modelName = extractedMetadata.modelName ?? extractedMetadata.baseModel ?? null;
        if (extractedMetadata.modelAliases && extractedMetadata.modelAliases.length > 0) {
          metadataPayload.modelAliases = extractedMetadata.modelAliases;
        }
        if (extractedMetadata.metadata && typeof extractedMetadata.metadata === 'object') {
          metadataPayload.extracted = extractedMetadata.metadata as Prisma.JsonObject;
        }
        if (metadataScreening && metadataScreening.normalized.length > 0) {
          metadataPayload.nsfw = {
            normalized: metadataScreening.normalized.map(({ tag, count }) => ({ tag, count })),
            scores: {
              adult: metadataScreening.adultScore,
              minor: metadataScreening.minorScore,
              beast: metadataScreening.beastScore,
            },
            matches: {
              adult: metadataScreening.matches.adult.map(({ tag, count }) => ({ tag, count })),
              minor: metadataScreening.matches.minor.map(({ tag, count }) => ({ tag, count })),
              beast: metadataScreening.matches.beast.map(({ tag, count }) => ({ tag, count })),
            },
          } as Prisma.JsonObject;
          if (previewAnalysisPayload) {
            (metadataPayload.nsfw as Prisma.JsonObject).imageAnalysis = previewAnalysisPayload;
          }
        }
      }

      let updatedAsset: HydratedModelAsset;
      try {
        updatedAsset = await prisma.$transaction(async (tx) => {
          await tx.storageObject.create({
            data: {
              id: modelObjectName,
              bucket: modelBucket,
              objectName: modelObjectName,
              originalName: modelFile.originalname,
              contentType: modelFile.mimetype || null,
              size: BigInt(modelFile.size),
            },
          });

          if (previewUpload) {
            await tx.storageObject.create({
              data: {
                id: previewObjectName,
                bucket: previewBucket,
                objectName: previewObjectName,
                originalName: previewFile.originalname,
                contentType: previewFile.mimetype || null,
                size: BigInt(previewFile.size),
              },
            });
          }

          await tx.modelVersion.create({
            data: {
              modelId: asset.id,
              version: requestedVersion,
              storagePath: toS3Uri(modelBucket, modelObjectName),
              previewImage: toS3Uri(previewBucket, previewObjectName),
              fileSize: modelFile.size,
              checksum,
              metadata: metadataPayload,
            },
          });

          return tx.modelAsset.update({
            where: { id: asset.id },
            data: { updatedAt: new Date() },
            include: {
              owner: { select: { id: true, displayName: true, email: true } },
              tags: { include: { tag: true } },
              versions: { orderBy: { createdAt: 'desc' } },
              flaggedBy: { select: { id: true, displayName: true, email: true } },
            },
          });
        });
        modelUpload = null;
        previewUpload = null;
      } catch (error) {
        if (modelUpload) {
          await removeStorageObject(modelUpload.bucket, modelUpload.objectName);
          modelUpload = null;
        }
        if (previewUpload) {
          await removeStorageObject(previewUpload.bucket, previewUpload.objectName);
          previewUpload = null;
        }
        throw error;
      }

      const [adultKeywords, illegalKeywords] = await Promise.all([
        getAdultKeywordLabels(),
        getIllegalKeywordLabels(),
      ]);
      const versionMetadataList = updatedAsset.versions
        .map((entry) => entry.metadata ?? null)
        .filter((entry): entry is Prisma.JsonValue => entry != null);
      const moderationSummaries = collectModerationSummaries([
        updatedAsset.moderationSummary ?? null,
        updatedAsset.metadata ?? null,
        ...versionMetadataList,
      ]);

      const metadataStrings = [
        ...collectStringsFromJson(updatedAsset.metadata ?? null),
        ...versionMetadataList.flatMap((entry) => collectStringsFromJson(entry)),
      ];

      const keywordAdult = determineAdultForModel({
        title: updatedAsset.title,
        description: updatedAsset.description,
        trigger: updatedAsset.trigger,
        metadata: updatedAsset.metadata ?? null,
        metadataList: versionMetadataList,
        tags: updatedAsset.tags,
        adultKeywords,
        moderationSummaries,
      });

      const keywordIllegal = detectKeywordMatch(
        illegalKeywords,
        [
          updatedAsset.title ?? '',
          updatedAsset.description ?? '',
          updatedAsset.trigger ?? '',
          ...metadataStrings,
        ],
        updatedAsset.tags,
      );

      const metadataThresholds = appConfig.nsfw.metadataFilters.thresholds;
      const metadataAdult = Boolean(
        metadataScreening &&
          metadataThresholds.adult > 0 &&
          metadataScreening.adultScore >= metadataThresholds.adult,
      );
      const metadataMinor = Boolean(
        metadataScreening &&
          metadataThresholds.minor > 0 &&
          metadataScreening.minorScore >= metadataThresholds.minor,
      );
      const metadataBeast = Boolean(
        metadataScreening &&
          metadataThresholds.beast > 0 &&
          metadataScreening.beastScore >= metadataThresholds.beast,
      );

      const analysisAdult = Boolean(previewImageAnalysis?.decisions.isAdult);

      const requiresModeration = metadataMinor || metadataBeast || keywordIllegal;
      const desiredIsAdult = keywordAdult || metadataAdult || requiresModeration || analysisAdult;

      const updatePayload: Prisma.ModelAssetUpdateInput = {};

      if (updatedAsset.isAdult !== desiredIsAdult) {
        updatePayload.isAdult = desiredIsAdult;
      }

      const shouldFlag = requiresModeration && updatedAsset.moderationStatus !== ModerationStatus.FLAGGED;

      if (requiresModeration) {
        if (shouldFlag) {
          updatePayload.moderationStatus = ModerationStatus.FLAGGED;
          updatePayload.flaggedAt = new Date();
          updatePayload.flaggedBy = { disconnect: true };
        }
        if (updatedAsset.isPublic) {
          updatePayload.isPublic = false;
        }
      }

      let finalAsset = updatedAsset;
      if (Object.keys(updatePayload).length > 0) {
        finalAsset = await prisma.modelAsset.update({
          where: { id: updatedAsset.id },
          data: updatePayload,
          include: {
            owner: { select: { id: true, displayName: true, email: true } },
            tags: { include: { tag: true } },
            versions: { orderBy: { createdAt: 'desc' } },
            flaggedBy: { select: { id: true, displayName: true, email: true } },
          },
        });
      }

      if (shouldFlag) {
        await createModerationLogEntry({
          entityType: ModerationEntityType.MODEL,
          entityId: finalAsset.id,
          action: ModerationActionType.FLAGGED,
          targetUserId: finalAsset.owner.id,
          message: 'Automatically flagged by NSFW metadata screening.',
        });
      }

      res.status(201).json(mapModelAsset(finalAsset));
    } catch (error) {
      next(error);
    }
  },
);

assetsRouter.put('/models/:modelId/versions/:versionId', requireAuth, requireCurator, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { modelId, versionId } = req.params;
    if (!modelId || !versionId) {
      res.status(400).json({ message: 'Model-ID oder Versions-ID fehlt.' });
      return;
    }

    const parsed = versionUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    const asset = await prisma.modelAsset.findUnique({
      where: { id: modelId },
      include: {
        owner: { select: { id: true, displayName: true, email: true } },
        tags: { include: { tag: true } },
        versions: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!asset) {
      res.status(404).json({ message: 'Das angeforderte Modell wurde nicht gefunden.' });
      return;
    }

    if (asset.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Keine Berechtigung zum Bearbeiten dieser Version.' });
      return;
    }

    const candidateVersions = [
      { id: asset.id, version: asset.version },
      ...asset.versions.map((entry) => ({ id: entry.id, version: entry.version })),
    ];

    const targetVersion = candidateVersions.find((entry) => entry.id === versionId);
    if (!targetVersion) {
      res.status(404).json({ message: 'Die gewünschte Version gehört nicht zu diesem Modell.' });
      return;
    }

    const requestedVersion = parsed.data.version?.trim();
    if (!requestedVersion) {
      res.status(400).json({ message: 'Die Versionsbezeichnung darf nicht leer sein.' });
      return;
    }

    const normalizedRequested = requestedVersion.toLowerCase();
    const hasDuplicate = candidateVersions.some(
      (entry) => entry.id !== versionId && entry.version.trim().toLowerCase() === normalizedRequested,
    );

    if (hasDuplicate) {
      res.status(409).json({ message: `Version "${requestedVersion}" ist bereits vorhanden.` });
      return;
    }

    const updatedAssetRaw = await prisma.$transaction(async (tx) => {
      if (versionId === asset.id) {
        return tx.modelAsset.update({
          where: { id: asset.id },
          data: { version: requestedVersion },
          include: {
            owner: { select: { id: true, displayName: true, email: true } },
            tags: { include: { tag: true } },
            versions: { orderBy: { createdAt: 'desc' } },
          },
        });
      }

      await tx.modelVersion.update({
        where: { id: versionId },
        data: { version: requestedVersion },
      });

      return tx.modelAsset.update({
        where: { id: asset.id },
        data: { updatedAt: new Date() },
        include: {
          owner: { select: { id: true, displayName: true, email: true } },
          tags: { include: { tag: true } },
          versions: { orderBy: { createdAt: 'desc' } },
        },
      });
    });

    const updatedAsset = updatedAssetRaw as HydratedModelAsset;

    res.json(mapModelAsset(updatedAsset));
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/models/:modelId/versions/:versionId/promote', requireAuth, requireCurator, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { modelId, versionId } = req.params;
    if (!modelId || !versionId) {
      res.status(400).json({ message: 'Model-ID oder Versions-ID fehlt.' });
      return;
    }

    const asset = await prisma.modelAsset.findUnique({
      where: { id: modelId },
      include: {
        owner: { select: { id: true, displayName: true, email: true } },
        tags: { include: { tag: true } },
        versions: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!asset) {
      res.status(404).json({ message: 'Das angeforderte Modell wurde nicht gefunden.' });
      return;
    }

    if (asset.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Keine Berechtigung zum Bearbeiten dieses Modells.' });
      return;
    }

    if (versionId === asset.id) {
      res.status(400).json({ message: 'Diese Version ist bereits als Primärversion hinterlegt.' });
      return;
    }

    const targetVersion = asset.versions.find((entry) => entry.id === versionId);
    if (!targetVersion) {
      res.status(404).json({ message: 'Die gewünschte Version gehört nicht zu diesem Modell.' });
      return;
    }

    const updatedAssetRaw = await prisma.$transaction(async (tx) => {
      await tx.modelVersion.update({
        where: { id: targetVersion.id },
        data: {
          version: asset.version,
          storagePath: asset.storagePath,
          previewImage: asset.previewImage ?? null,
          fileSize: asset.fileSize ?? null,
          checksum: asset.checksum ?? null,
          metadata: asset.metadata ?? Prisma.JsonNull,
          createdAt: asset.createdAt,
        },
      });

      return tx.modelAsset.update({
        where: { id: asset.id },
        data: {
          version: targetVersion.version,
          storagePath: targetVersion.storagePath,
          previewImage: targetVersion.previewImage ?? null,
          fileSize: targetVersion.fileSize ?? null,
          checksum: targetVersion.checksum ?? null,
          metadata: targetVersion.metadata ?? Prisma.JsonNull,
        },
        include: {
          owner: { select: { id: true, displayName: true, email: true } },
          tags: { include: { tag: true } },
          versions: { orderBy: { createdAt: 'desc' } },
        },
      });
    });

    const updatedAsset = updatedAssetRaw as HydratedModelAsset;

    res.json(mapModelAsset(updatedAsset));
  } catch (error) {
    next(error);
  }
});

assetsRouter.delete('/models/:modelId/versions/:versionId', requireAuth, requireCurator, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const { modelId, versionId } = req.params;
    if (!modelId || !versionId) {
      res.status(400).json({ message: 'Model-ID oder Versions-ID fehlt.' });
      return;
    }

    const asset = await prisma.modelAsset.findUnique({
      where: { id: modelId },
      include: {
        owner: { select: { id: true, displayName: true, email: true } },
        tags: { include: { tag: true } },
        versions: { orderBy: { createdAt: 'desc' } },
      },
    });

    if (!asset) {
      res.status(404).json({ message: 'Das angeforderte Modell wurde nicht gefunden.' });
      return;
    }

    if (asset.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Keine Berechtigung zum Löschen dieser Version.' });
      return;
    }

    if (versionId === asset.id) {
      res.status(400).json({ message: 'Die Primärversion kann nicht gelöscht werden.' });
      return;
    }

    const targetVersion = asset.versions.find((entry) => entry.id === versionId);
    if (!targetVersion) {
      res.status(404).json({ message: 'Die gewünschte Version gehört nicht zu diesem Modell.' });
      return;
    }

    const versionStorage = resolveStorageLocation(targetVersion.storagePath);
    const versionPreview = resolveStorageLocation(targetVersion.previewImage);

    const updatedAssetRaw = await prisma.$transaction(async (tx) => {
      await tx.modelVersion.delete({ where: { id: targetVersion.id } });

      if (versionStorage.objectName) {
        await tx.storageObject.deleteMany({ where: { id: versionStorage.objectName } });
      }

      if (versionPreview.objectName) {
        await tx.storageObject.deleteMany({ where: { id: versionPreview.objectName } });
      }

      if (targetVersion.previewImage) {
        await tx.gallery.updateMany({
          where: { coverImage: targetVersion.previewImage },
          data: { coverImage: null },
        });
      }

      return tx.modelAsset.update({
        where: { id: asset.id },
        data: { updatedAt: new Date() },
        include: {
          owner: { select: { id: true, displayName: true, email: true } },
          tags: { include: { tag: true } },
          versions: { orderBy: { createdAt: 'desc' } },
        },
      });
    });

    const updatedAsset = updatedAssetRaw as HydratedModelAsset;

    await Promise.all([
      removeStorageObject(versionStorage.bucket, versionStorage.objectName),
      removeStorageObject(versionPreview.bucket, versionPreview.objectName),
    ]);

    const [adultKeywords, illegalKeywords] = await Promise.all([
      getAdultKeywordLabels(),
      getIllegalKeywordLabels(),
    ]);
    const versionMetadataList = updatedAsset.versions
      .map((entry) => entry.metadata ?? null)
      .filter((entry): entry is Prisma.JsonValue => entry != null);
    const moderationSummaries = collectModerationSummaries([
      updatedAsset.moderationSummary ?? null,
      updatedAsset.metadata ?? null,
      ...versionMetadataList,
    ]);

    const metadataStrings = [
      ...collectStringsFromJson(updatedAsset.metadata ?? null),
      ...versionMetadataList.flatMap((entry) => collectStringsFromJson(entry)),
    ];

    const keywordAdult = determineAdultForModel({
      title: updatedAsset.title,
      description: updatedAsset.description,
      trigger: updatedAsset.trigger,
      metadata: updatedAsset.metadata ?? null,
      metadataList: versionMetadataList,
      tags: updatedAsset.tags,
      adultKeywords,
      moderationSummaries,
    });

    const keywordIllegal = detectKeywordMatch(
      illegalKeywords,
      [
        updatedAsset.title ?? '',
        updatedAsset.description ?? '',
        updatedAsset.trigger ?? '',
        ...metadataStrings,
      ],
      updatedAsset.tags,
    );

    const metadataScreening = resolveMetadataScreening(updatedAsset.metadata ?? null);
    const metadataThresholds = appConfig.nsfw.metadataFilters.thresholds;
    const metadataAdult = Boolean(
      metadataScreening &&
        metadataThresholds.adult > 0 &&
        metadataScreening.adultScore >= metadataThresholds.adult,
    );

    const metadataMinor = Boolean(
      metadataScreening &&
        metadataThresholds.minor > 0 &&
        metadataScreening.minorScore >= metadataThresholds.minor,
    );
    const metadataBeast = Boolean(
      metadataScreening &&
        metadataThresholds.beast > 0 &&
        metadataScreening.beastScore >= metadataThresholds.beast,
    );

    const requiresModeration = metadataMinor || metadataBeast || keywordIllegal;
    const desiredIsAdult = keywordAdult || metadataAdult || requiresModeration;

    let finalAsset = updatedAsset;
    if (updatedAsset.isAdult !== desiredIsAdult) {
      finalAsset = await prisma.modelAsset.update({
        where: { id: updatedAsset.id },
        data: { isAdult: desiredIsAdult },
        include: {
          owner: { select: { id: true, displayName: true, email: true } },
          tags: { include: { tag: true } },
          versions: { orderBy: { createdAt: 'desc' } },
        },
      });
    }

    res.json(mapModelAsset(finalAsset));
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/images/bulk-delete', requireAuth, requireCurator, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const parsed = bulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Ungültige Anfrage.', errors: parsed.error.flatten() });
      return;
    }

    const ids = Array.from(new Set(parsed.data.ids));
    const images = await prisma.imageAsset.findMany({
      where: { id: { in: ids } },
      select: { id: true, ownerId: true, storagePath: true },
    });

    if (images.length === 0) {
      res.status(404).json({ message: 'Keine passenden Bilder gefunden.' });
      return;
    }

    const isAdmin = req.user.role === 'ADMIN';
    const unauthorized = images.filter((image) => !isAdmin && image.ownerId !== req.user?.id);

    if (unauthorized.length > 0) {
      res.status(403).json({ message: 'Mindestens ein Bild gehört nicht zum eigenen Bestand.' });
      return;
    }

    const deletionPlan = images.map((image) => ({
      id: image.id,
      storage: resolveStorageLocation(image.storagePath),
      storagePath: image.storagePath,
    }));

    await prisma.$transaction(async (tx) => {
      for (const entry of deletionPlan) {
        await tx.galleryEntry.deleteMany({ where: { imageId: entry.id } });
        await tx.imageTag.deleteMany({ where: { imageId: entry.id } });
        if (entry.storage.objectName) {
          await tx.storageObject.deleteMany({ where: { id: entry.storage.objectName } });
        }
        await tx.gallery.updateMany({ where: { coverImage: entry.storagePath }, data: { coverImage: null } });
        await tx.imageAsset.delete({ where: { id: entry.id } });
      }
    });

    await Promise.all(
      deletionPlan.map(async (entry) => {
        await removeStorageObject(entry.storage.bucket, entry.storage.objectName);
      }),
    );

    res.json({ deleted: deletionPlan.map((entry) => entry.id) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.put('/models/:id', requireAuth, requireCurator, async (req, res, next) => {
  try {
    const { id: assetId } = req.params;
    if (!assetId) {
      res.status(400).json({ message: 'Model-ID fehlt.' });
      return;
    }

    const parsed = updateModelSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    const asset = await prisma.modelAsset.findUnique({
      where: { id: assetId },
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
      },
    });

    if (!asset) {
      res.status(404).json({ message: 'Das angeforderte Modell wurde nicht gefunden.' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const isAdmin = req.user.role === 'ADMIN';

    if (asset.ownerId !== req.user.id && !isAdmin) {
      res.status(403).json({ message: 'Keine Berechtigung zum Bearbeiten dieses Modells.' });
      return;
    }

    if (parsed.data.ownerId && parsed.data.ownerId !== asset.ownerId && !isAdmin) {
      res.status(403).json({ message: 'Nur Administrator:innen können den Besitz ändern.' });
      return;
    }

    if (
      parsed.data.isPublic !== undefined &&
      parsed.data.isPublic &&
      !isAdmin &&
      (asset.moderationStatus === ModerationStatus.FLAGGED || asset.flaggedAt != null)
    ) {
      res.status(403).json({
        message: 'Dieses Modell befindet sich in der Moderationsprüfung und kann erst nach Freigabe wieder veröffentlicht werden.',
      });
      return;
    }

    const shouldUpdateTags = parsed.data.tags !== undefined;
    const normalizedTags = shouldUpdateTags ? normalizeTagLabels(parsed.data.tags) : [];

    const updated = await prisma.$transaction(async (tx) => {
      const data: Prisma.ModelAssetUpdateInput = {};

      if (parsed.data.title) {
        data.title = parsed.data.title;
      }

      if (parsed.data.description !== undefined) {
        data.description = parsed.data.description;
      }

      if (parsed.data.version) {
        data.version = parsed.data.version;
      }

      if (parsed.data.trigger !== undefined) {
        data.trigger = parsed.data.trigger;
      }

      if (parsed.data.ownerId && parsed.data.ownerId !== asset.ownerId) {
        data.owner = { connect: { id: parsed.data.ownerId } };
      }

      if (parsed.data.isPublic !== undefined) {
        data.isPublic = parsed.data.isPublic;
      }

      if (shouldUpdateTags) {
        await tx.assetTag.deleteMany({ where: { assetId: asset.id } });
        if (normalizedTags.length > 0) {
          const tagRecords = await ensureTags(tx, normalizedTags);
          data.tags = {
            create: tagRecords.map((tag) => ({ tagId: tag.id })),
          };
        }
      }

      const updatedAsset = (await tx.modelAsset.update({
        where: { id: asset.id },
        data,
        include: {
          tags: { include: { tag: true } },
          owner: { select: { id: true, displayName: true, email: true } },
          versions: { orderBy: { createdAt: 'desc' } },
        },
      })) as HydratedModelAsset;

      const [adultKeywords, illegalKeywords] = await Promise.all([
        getAdultKeywordLabels(tx),
        getIllegalKeywordLabels(tx),
      ]);
      const versionMetadataList = updatedAsset.versions
        .map((entry) => entry.metadata ?? null)
        .filter((entry): entry is Prisma.JsonValue => entry != null);
      const moderationSummaries = collectModerationSummaries([
        updatedAsset.moderationSummary ?? null,
        updatedAsset.metadata ?? null,
        ...versionMetadataList,
      ]);

      const metadataStrings = [
        ...collectStringsFromJson(updatedAsset.metadata ?? null),
        ...versionMetadataList.flatMap((entry) => collectStringsFromJson(entry)),
      ];

      const keywordAdult = determineAdultForModel({
        title: updatedAsset.title,
        description: updatedAsset.description,
        trigger: updatedAsset.trigger,
        metadata: updatedAsset.metadata ?? null,
        metadataList: versionMetadataList,
        tags: updatedAsset.tags,
        adultKeywords,
        moderationSummaries,
      });

      const keywordIllegal = detectKeywordMatch(
        illegalKeywords,
        [
          updatedAsset.title ?? '',
          updatedAsset.description ?? '',
          updatedAsset.trigger ?? '',
          ...metadataStrings,
        ],
        updatedAsset.tags,
      );

      const metadataScreening = resolveMetadataScreening(updatedAsset.metadata ?? null);
      const metadataThresholds = appConfig.nsfw.metadataFilters.thresholds;
      const metadataAdult = Boolean(
        metadataScreening &&
          metadataThresholds.adult > 0 &&
          metadataScreening.adultScore >= metadataThresholds.adult,
      );

      const metadataMinor = Boolean(
        metadataScreening &&
          metadataThresholds.minor > 0 &&
          metadataScreening.minorScore >= metadataThresholds.minor,
      );
      const metadataBeast = Boolean(
        metadataScreening &&
          metadataThresholds.beast > 0 &&
          metadataScreening.beastScore >= metadataThresholds.beast,
      );

      const requiresModeration = metadataMinor || metadataBeast || keywordIllegal;
      const desiredIsAdult = keywordAdult || metadataAdult || requiresModeration;

      if (updatedAsset.isAdult !== desiredIsAdult) {
        return (await tx.modelAsset.update({
          where: { id: updatedAsset.id },
          data: { isAdult: desiredIsAdult },
          include: {
            tags: { include: { tag: true } },
            owner: { select: { id: true, displayName: true, email: true } },
            versions: { orderBy: { createdAt: 'desc' } },
          },
        })) as HydratedModelAsset;
      }

      return updatedAsset;
    });

    const hydrated = updated as HydratedModelAsset;

    res.json(mapModelAsset(hydrated));
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/models/:id/galleries', requireAuth, requireCurator, async (req, res, next) => {
  try {
    const { id: modelId } = req.params;
    if (!modelId) {
      res.status(400).json({ message: 'Model-ID fehlt.' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const parsed = linkModelToGallerySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    const model = await prisma.modelAsset.findUnique({
      where: { id: modelId },
      select: { id: true, ownerId: true, previewImage: true },
    });

    if (!model) {
      res.status(404).json({ message: 'Das Modell wurde nicht gefunden.' });
      return;
    }

    const actor = req.user;
    const isAdmin = actor.role === 'ADMIN';
    if (!isAdmin && model.ownerId !== actor.id) {
      res.status(403).json({ message: 'Keine Berechtigung zur Verknüpfung dieses Modells.' });
      return;
    }

    const gallery = await prisma.gallery.findUnique({
      where: { id: parsed.data.galleryId },
      select: { id: true, ownerId: true, coverImage: true },
    });

    if (!gallery) {
      res.status(404).json({ message: 'Die Galerie wurde nicht gefunden.' });
      return;
    }

    if (!isAdmin && gallery.ownerId !== actor.id) {
      res.status(403).json({ message: 'Nur eigene Galerien können verknüpft werden.' });
      return;
    }

    const existingEntry = await prisma.galleryEntry.findFirst({
      where: { galleryId: gallery.id, assetId: model.id },
      select: { id: true },
    });

    if (existingEntry) {
      res.status(409).json({ message: 'Dieses Modell ist der Galerie bereits zugeordnet.' });
      return;
    }

    const linkNote = parsed.data.note ?? null;

    await prisma.$transaction(async (tx) => {
      const lastEntry = await tx.galleryEntry.findFirst({
        where: { galleryId: gallery.id },
        orderBy: { position: 'desc' },
      });

      const nextPosition = (lastEntry?.position ?? 0) + 1;

      await tx.galleryEntry.create({
        data: {
          galleryId: gallery.id,
          assetId: model.id,
          position: nextPosition,
          note: linkNote,
        },
      });

      if (!gallery.coverImage && model.previewImage) {
        await tx.gallery.update({
          where: { id: gallery.id },
          data: { coverImage: model.previewImage },
        });
      }
    });

      const refreshed = await prisma.gallery.findUnique({
        where: { id: gallery.id },
        include: buildGalleryInclude(req.user?.id),
      });

    if (!refreshed) {
      res.status(500).json({ message: 'Galerie konnte nach dem Verknüpfen nicht geladen werden.' });
      return;
    }

    res.status(201).json({ gallery: mapGallery(refreshed, { viewer: req.user, includePrivate: true }) });
  } catch (error) {
    next(error);
  }
});

assetsRouter.delete('/models/:id', requireAuth, requireCurator, async (req, res, next) => {
  try {
    const { id: assetId } = req.params;
    if (!assetId) {
      res.status(400).json({ message: 'Model-ID fehlt.' });
      return;
    }

    const asset = await prisma.modelAsset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        ownerId: true,
        storagePath: true,
        previewImage: true,
        versions: { select: { id: true, storagePath: true, previewImage: true } },
      },
    });

    if (!asset) {
      res.status(404).json({ message: 'Das Modell wurde nicht gefunden.' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    if (asset.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Keine Berechtigung zum Löschen dieses Modells.' });
      return;
    }

    await deleteModelAssetAndCleanup(asset);

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

assetsRouter.put('/images/:id', requireAuth, requireCurator, async (req, res, next) => {
  try {
    const parsed = updateImageSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    const { id: imageId } = req.params;
    if (!imageId) {
      res.status(400).json({ message: 'Bild-ID fehlt.' });
      return;
    }

    const image = await prisma.imageAsset.findUnique({
      where: { id: imageId },
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
      },
    });

    if (!image) {
      res.status(404).json({ message: 'Bild konnte nicht gefunden werden.' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const isAdmin = req.user.role === 'ADMIN';

    if (image.ownerId !== req.user.id && !isAdmin) {
      res.status(403).json({ message: 'Keine Berechtigung zum Bearbeiten dieses Bildes.' });
      return;
    }

    if (parsed.data.ownerId && parsed.data.ownerId !== image.ownerId && !isAdmin) {
      res.status(403).json({ message: 'Nur Administrator:innen können den Besitz ändern.' });
      return;
    }

    if (
      parsed.data.isPublic !== undefined &&
      parsed.data.isPublic &&
      !isAdmin &&
      (image.moderationStatus === ModerationStatus.FLAGGED || image.flaggedAt != null)
    ) {
      res.status(403).json({
        message: 'Dieses Bild befindet sich in der Moderationsprüfung und kann erst nach Freigabe wieder veröffentlicht werden.',
      });
      return;
    }

    const shouldUpdateTags = parsed.data.tags !== undefined;
    const normalizedTags = shouldUpdateTags ? normalizeTagLabels(parsed.data.tags) : [];

    const updated = await prisma.$transaction(async (tx) => {
      const data: Prisma.ImageAssetUpdateInput = {};

      if (parsed.data.title) {
        data.title = parsed.data.title;
      }

      if (parsed.data.description !== undefined) {
        data.description = parsed.data.description;
      }

      if (parsed.data.prompt !== undefined) {
        data.prompt = parsed.data.prompt;
      }

      if (parsed.data.negativePrompt !== undefined) {
        data.negativePrompt = parsed.data.negativePrompt;
      }

      if (parsed.data.metadata) {
        if (parsed.data.metadata.seed !== undefined) {
          data.seed = parsed.data.metadata.seed;
        }
        if (parsed.data.metadata.model !== undefined) {
          data.model = parsed.data.metadata.model;
        }
        if (parsed.data.metadata.sampler !== undefined) {
          data.sampler = parsed.data.metadata.sampler;
        }
        if (parsed.data.metadata.cfgScale !== undefined) {
          data.cfgScale = parsed.data.metadata.cfgScale ?? null;
        }
        if (parsed.data.metadata.steps !== undefined) {
          data.steps = parsed.data.metadata.steps ?? null;
        }
      }

      if (parsed.data.ownerId && parsed.data.ownerId !== image.ownerId) {
        data.owner = { connect: { id: parsed.data.ownerId } };
      }

      if (parsed.data.isPublic !== undefined) {
        data.isPublic = parsed.data.isPublic;
      }

      if (shouldUpdateTags) {
        await tx.imageTag.deleteMany({ where: { imageId: image.id } });
        if (normalizedTags.length > 0) {
          const tagRecords = await ensureTags(tx, normalizedTags);
          data.tags = {
            create: tagRecords.map((tag) => ({ tagId: tag.id })),
          };
        }
      }

      const updatedImage = await tx.imageAsset.update({
        where: { id: image.id },
        data,
        include: buildImageInclude(req.user?.id),
      });

      const metadataPayload: Prisma.JsonObject = {};
      if (updatedImage.seed) {
        metadataPayload.seed = updatedImage.seed;
      }
      if (updatedImage.cfgScale != null) {
        metadataPayload.cfgScale = updatedImage.cfgScale;
      }
      if (updatedImage.steps != null) {
        metadataPayload.steps = updatedImage.steps;
      }

      const metadataInput = Object.keys(metadataPayload).length > 0 ? metadataPayload : null;
      const moderationSummary = normalizeModerationSummary(updatedImage.moderationSummary);

      const [adultKeywords, illegalKeywords] = await Promise.all([
        getAdultKeywordLabels(tx),
        getIllegalKeywordLabels(tx),
      ]);

      const metadataList: Prisma.JsonValue[] = metadataInput ? [metadataInput] : [];

      const keywordAdult = determineAdultForImage({
        title: updatedImage.title,
        description: updatedImage.description,
        prompt: updatedImage.prompt,
        negativePrompt: updatedImage.negativePrompt,
        model: updatedImage.model,
        sampler: updatedImage.sampler,
        metadata: metadataInput,
        metadataList,
        tags: updatedImage.tags,
        adultKeywords,
        moderation: moderationSummary,
      });

      const metadataStrings = metadataList.flatMap((entry) => collectStringsFromJson(entry));

      const keywordIllegal = detectKeywordMatch(
        illegalKeywords,
        [
          updatedImage.title ?? '',
          updatedImage.description ?? '',
          updatedImage.prompt ?? '',
          updatedImage.negativePrompt ?? '',
          updatedImage.model ?? '',
          updatedImage.sampler ?? '',
          ...metadataStrings,
        ],
        updatedImage.tags,
      );

      const requiresModeration = keywordIllegal;
      const desiredIsAdult = keywordAdult || requiresModeration;

      if (updatedImage.isAdult !== desiredIsAdult) {
        return tx.imageAsset.update({
          where: { id: updatedImage.id },
          data: { isAdult: desiredIsAdult },
          include: buildImageInclude(req.user?.id),
        });
      }

      return updatedImage;
    });

    res.json(mapImageAsset(updated, { viewerId: req.user?.id }));
  } catch (error) {
    next(error);
  }
});

assetsRouter.delete('/images/:id', requireAuth, requireCurator, async (req, res, next) => {
  try {
    const { id: imageId } = req.params;
    if (!imageId) {
      res.status(400).json({ message: 'Bild-ID fehlt.' });
      return;
    }

    const image = await prisma.imageAsset.findUnique({
      where: { id: imageId },
      select: { id: true, ownerId: true, storagePath: true },
    });

    if (!image) {
      res.status(404).json({ message: 'Bild konnte nicht gefunden werden.' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    if (image.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Keine Berechtigung zum Löschen dieses Bildes.' });
      return;
    }

    await deleteImageAssetAndCleanup(image);

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
