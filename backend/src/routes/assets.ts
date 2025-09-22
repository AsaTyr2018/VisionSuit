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
  Tag,
  User,
} from '@prisma/client';
import type { Express, Response } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { determineAdultForImage, determineAdultForModel } from '../lib/adult-content';
import { requireAdmin, requireAuth, requireCurator } from '../lib/middleware/auth';
import { extractModelMetadataFromFile } from '../lib/metadata';
import { buildGalleryInclude, mapGallery } from '../lib/mappers/gallery';
import { MAX_TOTAL_SIZE_BYTES } from '../lib/uploadLimits';
import {
  mapModelAsset,
  type HydratedModelAsset,
  type MappedModerationReport,
} from '../lib/mappers/model';
import { resolveStorageLocation, storageBuckets, storageClient } from '../lib/storage';

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
  trigger: z
    .string()
    .trim()
    .max(180)
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) {
        return null;
      }

      return value.length > 0 ? value : null;
    }),
  version: z.string().trim().max(80).optional(),
  tags: z.array(z.string()).optional(),
  ownerId: z.string().trim().min(1).optional(),
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

export const assetsRouter = Router();

assetsRouter.get('/models', async (req, res, next) => {
  try {
    const viewer = req.user;
    const isAdmin = viewer?.role === 'ADMIN';
    const allowAdultContent = viewer?.showAdultContent ?? false;
    const visibilityFilter: Prisma.ModelAssetWhereInput = isAdmin
      ? {}
      : viewer
        ? {
            AND: [
              { moderationStatus: { not: ModerationStatus.REMOVED } },
              {
                OR: [
                  { ownerId: viewer.id },
                  {
                    AND: [
                      { isPublic: true },
                      { moderationStatus: ModerationStatus.ACTIVE },
                    ],
                  },
                ],
              },
            ],
          }
        : {
            AND: [
              { isPublic: true },
              { moderationStatus: ModerationStatus.ACTIVE },
            ],
          };

    const filters: Prisma.ModelAssetWhereInput[] = [];

    if (Object.keys(visibilityFilter).length > 0) {
      filters.push(visibilityFilter);
    }

    if (!allowAdultContent) {
      filters.push({ isAdult: false });
    }

    let where: Prisma.ModelAssetWhereInput = {};
    if (filters.length === 1) {
      where = filters[0] ?? {};
    } else if (filters.length > 1) {
      where = { AND: filters };
    }

    const assets = await prisma.modelAsset.findMany({
      where,
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
        flaggedBy: { select: { id: true, displayName: true, email: true } },
        versions: { orderBy: { createdAt: 'desc' } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(assets.map(mapModelAsset));
  } catch (error) {
    next(error);
  }
});

assetsRouter.get('/images', async (req, res, next) => {
  try {
    const viewer = req.user;
    const isAdmin = viewer?.role === 'ADMIN';
    const allowAdultContent = viewer?.showAdultContent ?? false;
    const visibilityFilter: Prisma.ImageAssetWhereInput = isAdmin
      ? {}
      : viewer
        ? {
            AND: [
              { moderationStatus: { not: ModerationStatus.REMOVED } },
              {
                OR: [
                  { ownerId: viewer.id },
                  {
                    AND: [
                      { isPublic: true },
                      { moderationStatus: ModerationStatus.ACTIVE },
                    ],
                  },
                ],
              },
            ],
          }
        : {
            AND: [
              { isPublic: true },
              { moderationStatus: ModerationStatus.ACTIVE },
            ],
          };

    const filters: Prisma.ImageAssetWhereInput[] = [];

    if (Object.keys(visibilityFilter).length > 0) {
      filters.push(visibilityFilter);
    }

    if (!allowAdultContent) {
      filters.push({ isAdult: false });
    }

    let where: Prisma.ImageAssetWhereInput = {};
    if (filters.length === 1) {
      where = filters[0] ?? {};
    } else if (filters.length > 1) {
      where = { AND: filters };
    }

    const images = await prisma.imageAsset.findMany({
      where,
      include: buildImageInclude(viewer?.id),
      orderBy: { createdAt: 'desc' },
    });

    res.json(images.map((image) => mapImageAsset(image, { viewerId: viewer?.id ?? null })));
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

    res.json({
      models: models.map(mapModelAsset),
      images: images.map((image) => mapImageAsset(image, { viewerId: req.user?.id ?? null })),
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
    select: { id: true, ownerId: true, isPublic: true, moderationStatus: true },
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
    select: { id: true, ownerId: true, isPublic: true, moderationStatus: true },
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

    await prisma.imageLike.upsert({
      where: { userId_imageId: { userId: req.user.id, imageId } },
      update: {},
      create: { userId: req.user.id, imageId },
    });

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

      const asset = await prisma.modelAsset.findUnique({
        where: { id: assetId },
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
      const metadataPayload: Prisma.JsonObject = {
        originalFileName: modelFile.originalname,
        checksum,
      };

      if (extractedMetadata) {
        metadataPayload.baseModel = extractedMetadata.baseModel ?? null;
        metadataPayload.modelName = extractedMetadata.modelName ?? extractedMetadata.baseModel ?? null;
        if (extractedMetadata.modelAliases && extractedMetadata.modelAliases.length > 0) {
          metadataPayload.modelAliases = extractedMetadata.modelAliases;
        }
        if (extractedMetadata.metadata && typeof extractedMetadata.metadata === 'object') {
          metadataPayload.extracted = extractedMetadata.metadata as Prisma.JsonObject;
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

      res.status(201).json(mapModelAsset(updatedAsset));
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

    const updatedAsset = await prisma.$transaction(async (tx) => {
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

    const updatedAsset = await prisma.$transaction(async (tx) => {
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

    const updatedAsset = await prisma.$transaction(async (tx) => {
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

    await Promise.all([
      removeStorageObject(versionStorage.bucket, versionStorage.objectName),
      removeStorageObject(versionPreview.bucket, versionPreview.objectName),
    ]);

    res.json(mapModelAsset(updatedAsset));
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

    if (asset.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Keine Berechtigung zum Bearbeiten dieses Modells.' });
      return;
    }

    if (parsed.data.ownerId && parsed.data.ownerId !== asset.ownerId && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Nur Administrator:innen können den Besitz ändern.' });
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

      if (shouldUpdateTags) {
        await tx.assetTag.deleteMany({ where: { assetId: asset.id } });
        if (normalizedTags.length > 0) {
          const tagRecords = await ensureTags(tx, normalizedTags);
          data.tags = {
            create: tagRecords.map((tag) => ({ tagId: tag.id })),
          };
        }
      }

      const updatedAsset = await tx.modelAsset.update({
        where: { id: asset.id },
        data,
        include: {
          tags: { include: { tag: true } },
          owner: { select: { id: true, displayName: true, email: true } },
          versions: { orderBy: { createdAt: 'desc' } },
        },
      });

      const nextIsAdult = determineAdultForModel({
        title: updatedAsset.title,
        description: updatedAsset.description,
        trigger: updatedAsset.trigger,
        metadata: updatedAsset.metadata ?? null,
        tags: updatedAsset.tags,
      });

      if (updatedAsset.isAdult !== nextIsAdult) {
        return tx.modelAsset.update({
          where: { id: updatedAsset.id },
          data: { isAdult: nextIsAdult },
          include: {
            tags: { include: { tag: true } },
            owner: { select: { id: true, displayName: true, email: true } },
            versions: { orderBy: { createdAt: 'desc' } },
          },
        });
      }

      return updatedAsset;
    });

    res.json(mapModelAsset(updated));
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

    if (image.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Keine Berechtigung zum Bearbeiten dieses Bildes.' });
      return;
    }

    if (parsed.data.ownerId && parsed.data.ownerId !== image.ownerId && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Nur Administrator:innen können den Besitz ändern.' });
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

      const nextIsAdult = determineAdultForImage({
        title: updatedImage.title,
        description: updatedImage.description,
        prompt: updatedImage.prompt,
        negativePrompt: updatedImage.negativePrompt,
        model: updatedImage.model,
        sampler: updatedImage.sampler,
        metadata: metadataInput,
        tags: updatedImage.tags,
      });

      if (updatedImage.isAdult !== nextIsAdult) {
        return tx.imageAsset.update({
          where: { id: updatedImage.id },
          data: { isAdult: nextIsAdult },
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
