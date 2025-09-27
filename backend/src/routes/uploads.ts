import crypto from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { ModerationStatus } from '@prisma/client';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { getAdultKeywordLabels } from '../lib/adult-keywords';
import { MAX_TOTAL_SIZE_BYTES, MAX_UPLOAD_FILES } from '../lib/uploadLimits';
import { storageBuckets, storageClient, getObjectUrl } from '../lib/storage';
import { buildUniqueSlug, slugify } from '../lib/slug';
import { requireAuth, requireCurator } from '../lib/middleware/auth';
import {
  extractImageMetadata,
  extractModelMetadataFromFile,
  toJsonImageMetadata,
  type ImageMetadataResult,
  type SafetensorsMetadataResult,
} from '../lib/metadata';
import { runNsfwImageAnalysis, toJsonImageAnalysis } from '../lib/nsfw/service';
import { evaluateImageModeration, evaluateModelModeration } from '../lib/nsfw/moderation';
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: MAX_UPLOAD_FILES,
    fileSize: MAX_TOTAL_SIZE_BYTES,
  },
});

type MulterFile = Express.Multer.File;

const toS3Uri = (bucket: string, objectName: string) => `s3://${bucket}/${objectName}`;

type StoredUploadFile = {
  index: number;
  file: MulterFile;
  isImage: boolean;
  storage: {
    id: string;
    name: string;
    size: number;
    type: string;
    bucket: string;
    objectName: string;
    url: string;
  };
  imageMetadata?: ImageMetadataResult;
  modelMetadata?: SafetensorsMetadataResult | null;
  moderationSummary?: ImageModerationSummary | null;
};

const ensureTags = async (tx: Prisma.TransactionClient, tags: string[], category?: string | null) => {
  const normalized = Array.from(
    new Set(
      tags
        .map((tag) => tag.trim().toLowerCase())
        .filter((tag) => tag.length > 0),
    ),
  );

  if (normalized.length === 0) {
    return [] as { id: string; label: string; isAdult: boolean }[];
  }

  return Promise.all(
    normalized.map((label) =>
      tx.tag.upsert({
        where: { label },
        update: category ? { category } : {},
        create: { label, category: category ?? null },
        select: { id: true, label: true, isAdult: true },
      }),
    ),
  );
};

const ensureLoraTypeTag = async (tx: Prisma.TransactionClient) =>
  tx.tag.upsert({
    where: { label: 'lora' },
    update: { category: 'model-type' },
    create: { label: 'lora', category: 'model-type' },
    select: { id: true, label: true, isAdult: true },
  });

const resolveGallery = async (
  tx: Prisma.TransactionClient,
  payload: z.infer<typeof createUploadSchema>,
  ownerId: string,
  actor: { id: string; role: string },
  fallbackCover?: string | null,
) => {
  if (payload.galleryMode === 'existing') {
    if (!payload.targetGallery) {
      return null;
    }

    const input = payload.targetGallery.trim();
    const slugCandidate = slugify(input);

    const gallery = await tx.gallery.findFirst({
      where: {
        OR: [
          { slug: input.toLowerCase() },
          { slug: slugCandidate },
          { title: input },
        ],
      },
    });

    if (!gallery) {
      return null;
    }

    if (actor.role !== 'ADMIN' && gallery.ownerId !== actor.id) {
      throw Object.assign(new Error('FORBIDDEN_GALLERY'), { statusCode: 403 });
    }

    return gallery;
  }

  const galleryTitle = payload.targetGallery?.trim() || `${payload.title.trim()} Collection`;
  const slugBase = galleryTitle.length > 0 ? galleryTitle : payload.title;
  const slug = await buildUniqueSlug(slugBase, (candidate) => tx.gallery.findUnique({ where: { slug: candidate } }).then(Boolean), 'gallery');

  return tx.gallery.create({
    data: {
      slug,
      title: galleryTitle,
      description: payload.description ?? null,
      coverImage: fallbackCover ?? null,
      isPublic: payload.visibility === 'public',
      ownerId,
    },
  });
};

const normalizeTagInput = (value: unknown): string[] => {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
};

const createUploadSchema = z
  .object({
    assetType: z.enum(['lora', 'image']),
    context: z.enum(['asset', 'gallery']).default('asset'),
    title: z.string().min(1).max(180),
    description: z
      .string()
      .trim()
      .max(1500)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    visibility: z.enum(['private', 'public']),
    category: z
      .string()
      .trim()
      .max(80)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    trigger: z
      .string()
      .trim()
      .max(180)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    galleryMode: z.enum(['existing', 'new']),
    targetGallery: z
      .string()
      .trim()
      .max(160)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    tags: z
      .array(z.string().trim().min(1).max(60))
      .max(24)
      .optional()
      .default([]),
  })
  .superRefine((data, ctx) => {
    if (data.galleryMode === 'existing' && !data.targetGallery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetGallery'],
        message: 'Bitte gib eine bestehende Galerie an oder wähle "Neue Galerie".',
      });
    }

    if (data.assetType === 'lora' && !data.trigger) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['trigger'],
        message: 'Bitte gib einen Trigger oder Aktivator für das Modell an.',
      });
    }
  });

export const uploadsRouter = Router();

uploadsRouter.post('/', requireAuth, requireCurator, upload.array('files'), async (req, res, next) => {
  try {
    const files = ((req as unknown as { files?: MulterFile[] }).files ?? []) as MulterFile[];

    if (files.length === 0) {
      res.status(400).json({ message: 'Mindestens eine Datei wird für den Upload benötigt.' });
      return;
    }

    const tags = normalizeTagInput(req.body.tags);
    const parseResult = createUploadSchema.safeParse({
      ...req.body,
      tags,
    });

    if (!parseResult.success) {
      const errors = parseResult.error.flatten();
      res.status(400).json({
        message: 'Übermittelte Upload-Daten sind nicht gültig.',
        errors,
      });
      return;
    }

    const payload = parseResult.data;
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    if (totalSize > MAX_TOTAL_SIZE_BYTES) {
      res.status(400).json({
        message: 'Gesamtgröße der Dateien überschreitet das Limit von 2 GB.',
      });
      return;
    }

    if (payload.context === 'gallery') {
      const invalidFiles = files.filter((file) => !file.mimetype.startsWith('image/'));
      if (invalidFiles.length > 0) {
        res.status(400).json({
          message: 'Galerie-Uploads akzeptieren ausschließlich Bilddateien (PNG, JPG, WebP).',
        });
        return;
      }
    }
    if (payload.galleryMode === 'existing' && payload.targetGallery) {
      const input = payload.targetGallery.trim();
      const slugCandidate = slugify(input);
      const gallery = await prisma.gallery.findFirst({
        where: {
          OR: [
            { slug: input.toLowerCase() },
            { slug: slugCandidate },
            { title: input },
          ],
        },
        select: { id: true },
      });

      if (!gallery) {
        res.status(404).json({ message: 'Die angegebene Galerie konnte nicht gefunden werden.' });
        return;
      }
    }

    const uploadReference = crypto.randomUUID();

    const storedEntries: StoredUploadFile[] = await Promise.all(
      files.map(async (file, index) => {
        const isImage = file.mimetype.startsWith('image/');
        const bucket = isImage ? storageBuckets.images : storageBuckets.models;
        const storageId = crypto.randomUUID();
        const objectName = storageId;

        const [imageMetadata, modelMetadata, moderationSummary] = await Promise.all([
          isImage ? extractImageMetadata(file).catch(() => undefined) : Promise.resolve(undefined),
          !isImage ? Promise.resolve(extractModelMetadataFromFile(file)) : Promise.resolve(null),
          isImage
            ? analyzeImageModeration(file.buffer).catch((error) => {
                console.warn('Failed to analyze image for moderation heuristics.', {
                  file: file.originalname,
                  error,
                });
                return null;
              })
            : Promise.resolve(null),
        ]);

        await storageClient.putObject(bucket, objectName, file.buffer, file.size, {
          'Content-Type': file.mimetype || undefined,
        });

        const entry: StoredUploadFile = {
          index,
          file,
          isImage,
          storage: {
            id: storageId,
            name: file.originalname,
            size: file.size,
            type: file.mimetype,
            bucket,
            objectName,
            url: getObjectUrl(bucket, objectName),
          },
        };

        if (imageMetadata) {
          entry.imageMetadata = imageMetadata;
        }

        if (modelMetadata) {
          entry.modelMetadata = modelMetadata;
        }

        if (moderationSummary) {
          entry.moderationSummary = moderationSummary;
        }

        return entry;
      }),
    );

    if (storedEntries.length === 0) {
      res.status(400).json({ message: 'Es wurden keine verarbeitbaren Dateien gefunden.' });
      return;
    }

    const modelEntry =
      payload.assetType === 'lora'
        ? storedEntries.find((entry) => !entry.isImage && entry.modelMetadata)
            ?? storedEntries.find((entry) => !entry.isImage)
            ?? storedEntries[0]
        : storedEntries[0];

    const primaryFile = modelEntry?.file;
    const primaryStored = modelEntry?.storage;

    if (!primaryFile || !primaryStored) {
      res.status(400).json({ message: 'Die Modelldatei konnte nicht verarbeitet werden.' });
      return;
    }

    const normalizedTags = Array.from(
      new Set(payload.tags.map((tag) => tag.trim().toLowerCase()).filter((tag) => tag.length > 0)),
    );

    const checksum =
      payload.assetType === 'lora'
        ? crypto.createHash('sha256').update(primaryFile.buffer).digest('hex')
        : undefined;

    const actor = req.user;
    if (!actor) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const previewEntry = storedEntries.find((entry) => entry.isImage);
    const previewStored = previewEntry?.storage ?? null;
    const imageFiles = storedEntries.filter((entry) => entry.isImage);
    const moderationSummaries = imageFiles
      .map((entry) => entry.moderationSummary)
      .filter((entry): entry is ImageModerationSummary => Boolean(entry));

    const result = await prisma.$transaction(async (tx) => {
      const gallery = await resolveGallery(
        tx,
        payload,
        actor.id,
        actor,
        previewStored ? toS3Uri(previewStored.bucket, previewStored.objectName) : null,
      );

      if (!gallery) {
        throw new Error('Gallery not found');
      }

      const tagRecords = await ensureTags(tx, normalizedTags, payload.category);
      const tagIds = tagRecords.map((tag) => tag.id);
      const assignedTags = [...tagRecords];
      const adultKeywords = await getAdultKeywordLabels(tx);

      if (payload.assetType === 'lora') {
        const loraTag = await ensureLoraTypeTag(tx);
        if (!tagIds.includes(loraTag.id)) {
          tagIds.push(loraTag.id);
        }
        assignedTags.push(loraTag);
      }

      const draftFiles: Prisma.JsonArray = storedEntries.map((entry) => {
        const file = entry.storage;
        const json: Prisma.JsonObject = {
          id: file.id,
          name: file.name,
          size: file.size,
          type: file.type,
          bucket: file.bucket,
          objectName: file.objectName,
          url: file.url,
        };

        if (entry.imageMetadata) {
          const metadata: Prisma.JsonObject = {
            width: entry.imageMetadata.width ?? null,
            height: entry.imageMetadata.height ?? null,
            prompt: entry.imageMetadata.prompt ?? null,
            negativePrompt: entry.imageMetadata.negativePrompt ?? null,
            seed: entry.imageMetadata.seed ?? null,
            model: entry.imageMetadata.model ?? null,
            sampler: entry.imageMetadata.sampler ?? null,
            cfgScale: entry.imageMetadata.cfgScale ?? null,
            steps: entry.imageMetadata.steps ?? null,
          };
          json.metadata = metadata;
        } else if (entry.modelMetadata) {
          const metadata: Prisma.JsonObject = {
            baseModel: entry.modelMetadata.baseModel ?? null,
            modelName: entry.modelMetadata.modelName ?? entry.modelMetadata.baseModel ?? null,
          };

          if (entry.modelMetadata.modelAliases && entry.modelMetadata.modelAliases.length > 0) {
            metadata.modelAliases = entry.modelMetadata.modelAliases;
          }

          json.metadata = metadata;
        }

        if (entry.moderationSummary) {
          json.moderation = serializeModerationSummary(entry.moderationSummary);
        }

        return json;
      });

      const draft = await tx.uploadDraft.create({
        data: {
          id: uploadReference,
          assetType: payload.assetType,
          title: payload.title,
          description: payload.description ?? null,
          visibility: payload.visibility,
          category: payload.category ?? null,
          galleryMode: payload.galleryMode,
          targetGallery: payload.galleryMode === 'existing' ? payload.targetGallery ?? null : null,
          tags: normalizedTags,
          files: draftFiles,
          fileCount: files.length,
          totalSize: BigInt(totalSize),
          status: 'processed',
          owner: { connect: { id: actor.id } },
        },
      });

      const lastEntry = await tx.galleryEntry.findFirst({
        where: { galleryId: gallery.id },
        orderBy: { position: 'desc' },
      });
      const nextPosition = (lastEntry?.position ?? 0) + 1;

      await Promise.all(
        storedEntries.map((entry) =>
          tx.storageObject.create({
            data: {
              id: entry.storage.id,
              bucket: entry.storage.bucket,
              objectName: entry.storage.objectName,
              originalName: entry.storage.name ?? null,
              contentType: entry.storage.type ?? null,
              size: BigInt(entry.storage.size),
            },
          }),
        ),
      );

      if (payload.assetType === 'lora') {
        const previewAnalysis = previewEntry?.file
          ? await runNsfwImageAnalysis(previewEntry.file.buffer, { priority: 'high' })
          : null;
        const previewAnalysisPayload = previewAnalysis ? toJsonImageAnalysis(previewAnalysis) : null;

        const slug = await buildUniqueSlug(
          payload.title,
          (candidate) => tx.modelAsset.findUnique({ where: { slug: candidate } }).then(Boolean),
          'model',
        );

        const modelMetadataPayload: Prisma.JsonObject = {
          originalFileName: primaryFile.originalname,
          visibility: payload.visibility,
          draftId: draft.id,
        };

        if (previewAnalysisPayload) {
          modelMetadataPayload.nsfwImageAnalysis = previewAnalysisPayload;
        }

        const previewMetadataPayload = toJsonImageMetadata(previewEntry?.imageMetadata ?? null);
        if (previewMetadataPayload) {
          if (previewAnalysisPayload) {
            const nsfwPayload = ((previewMetadataPayload.nsfw as Prisma.JsonObject | undefined) ?? {}) as Prisma.JsonObject;
            nsfwPayload.imageAnalysis = previewAnalysisPayload;
            previewMetadataPayload.nsfw = nsfwPayload;
          }
          modelMetadataPayload.preview = previewMetadataPayload;
        } else if (previewAnalysisPayload) {
          modelMetadataPayload.preview = {
            nsfw: {
              imageAnalysis: previewAnalysisPayload,
            },
          } as Prisma.JsonObject;
        }

        if (previewEntry?.moderationSummary) {
          modelMetadataPayload.moderation = serializeModerationSummary(previewEntry.moderationSummary);
        }

        if (modelEntry?.modelMetadata) {
          const extracted = modelEntry.modelMetadata;
          modelMetadataPayload.baseModel = extracted.baseModel ?? null;
          modelMetadataPayload.modelName = extracted.modelName ?? extracted.baseModel ?? null;
          if (extracted.modelAliases && extracted.modelAliases.length > 0) {
            modelMetadataPayload.modelAliases = extracted.modelAliases;
          }
          if (extracted.metadata && typeof extracted.metadata === 'object') {
            modelMetadataPayload.extracted = extracted.metadata as Prisma.JsonObject;
          }
          if (extracted.nsfwMetadata) {
            modelMetadataPayload.nsfwMetadata = JSON.parse(
              JSON.stringify(extracted.nsfwMetadata),
            ) as Prisma.JsonValue;
          }
        }

        const metadataList: Prisma.JsonValue[] = [];
        if (previewMetadataPayload) {
          metadataList.push(previewMetadataPayload);
        }

        const moderationDecision = evaluateModelModeration({
          title: payload.title,
          description: payload.description ?? null,
          trigger: payload.trigger ?? null,
          metadata: modelMetadataPayload,
          metadataList,
          tags: assignedTags.map((tag) => ({ tag })),
          adultKeywords,
          analysis: previewAnalysis ? { decisions: previewAnalysis.decisions, scores: previewAnalysis.scores } : null,
        });

        if (moderationDecision.metadataScreening) {
          modelMetadataPayload.nsfwMetadata = JSON.parse(
            JSON.stringify(moderationDecision.metadataScreening),
          ) as Prisma.JsonValue;
        }

        const requiresModeration = moderationDecision.requiresModeration;
        const modelIsAdult = moderationDecision.isAdult;

        const modelData: Prisma.ModelAssetCreateInput = {
          slug,
          title: payload.title,
          description: payload.description ?? null,
          trigger: payload.trigger ?? null,
          version: '1.0.0',
          fileSize: primaryFile.size,
          checksum: checksum ?? null,
          storagePath: toS3Uri(primaryStored.bucket, primaryStored.objectName),
          previewImage: previewStored ? toS3Uri(previewStored.bucket, previewStored.objectName) : null,
          metadata: modelMetadataPayload,
          isPublic: requiresModeration ? false : payload.visibility === 'public',
          isAdult: modelIsAdult,
          owner: { connect: { id: actor.id } },
          tags: {
            create: tagIds.map((tagId) => ({ tagId })),
          },
        };

        if (requiresModeration) {
          modelData.moderationStatus = ModerationStatus.FLAGGED;
          modelData.flaggedAt = new Date();
        }

        const modelAsset = await tx.modelAsset.create({
          data: modelData,
        });

        const entry = await tx.galleryEntry.create({
          data: {
            galleryId: gallery.id,
            assetId: modelAsset.id,
            position: nextPosition,
            note: payload.description ?? null,
          },
        });

        if (modelAsset.previewImage && !gallery.coverImage) {
          await tx.gallery.update({
            where: { id: gallery.id },
            data: { coverImage: modelAsset.previewImage },
          });
        }

        return {
          draftId: draft.id,
          assetId: modelAsset.id,
          gallerySlug: gallery.slug,
          assetSlug: modelAsset.slug,
          entryIds: [entry.id],
        };
      }

      let positionCursor = nextPosition;
      const imageEntries: { imageId: string; entryId: string }[] = [];

      for (const [index, entry] of imageFiles.entries()) {
        const stored = entry.storage;
        const source = entry.file;
        const metadata = entry.imageMetadata;

        const baseTitle = payload.title.trim().length > 0 ? payload.title.trim() : stored.name ?? '';
        const fallbackTitle = source.originalname?.replace(/\.[^/.]+$/, '')?.trim();
        const candidate = (baseTitle || fallbackTitle || `Bild ${index + 1}`).slice(0, 160);
        const title =
          imageFiles.length > 1
            ? `${candidate}${candidate.endsWith('#') ? '' : ' '}#${index + 1}`.trim()
            : candidate;

        const imageMetadataPayload: Prisma.JsonObject = {};
        if (metadata?.seed) {
          imageMetadataPayload.seed = metadata.seed;
        }
        if (metadata?.cfgScale != null) {
          imageMetadataPayload.cfgScale = metadata.cfgScale;
        }
        if (metadata?.steps != null) {
          imageMetadataPayload.steps = metadata.steps;
        }
        if (metadata?.extras && Object.keys(metadata.extras).length > 0) {
          imageMetadataPayload.extras = metadata.extras as Prisma.JsonObject;
        }

        const imageAnalysis = await runNsfwImageAnalysis(source.buffer, { priority: 'normal' });
        if (imageAnalysis) {
          imageMetadataPayload.nsfwImageAnalysis = toJsonImageAnalysis(imageAnalysis);
        }

        const metadataList: Prisma.JsonValue[] = [];
        const resolvedMetadata = Object.keys(imageMetadataPayload).length > 0 ? imageMetadataPayload : null;

        if (resolvedMetadata) {
          metadataList.push(resolvedMetadata);
        }

        const imageModeration = evaluateImageModeration({

          title,
          description: payload.description ?? null,
          prompt: metadata?.prompt ?? null,
          negativePrompt: metadata?.negativePrompt ?? null,
          model: metadata?.model ?? null,
          sampler: metadata?.sampler ?? null,
          metadata: resolvedMetadata,
          metadataList,
          tags: assignedTags.map((tag) => ({ tag })),
          adultKeywords,
          analysis: imageAnalysis,
        });

        const imageAdultFinal = imageModeration.isAdult;

        const imageData: Prisma.ImageAssetCreateInput = {
          title,
          description: payload.description ?? null,
          width: metadata?.width ?? null,
          height: metadata?.height ?? null,
          fileSize: source.size,
          storagePath: toS3Uri(stored.bucket, stored.objectName),
          prompt: metadata?.prompt ?? null,
          negativePrompt: metadata?.negativePrompt ?? null,
          seed: metadata?.seed ?? null,
          model: metadata?.model ?? null,
          sampler: metadata?.sampler ?? null,
          cfgScale: metadata?.cfgScale ?? null,
          steps: metadata?.steps ?? null,
          isPublic: imageModeration.requiresModeration ? false : payload.visibility === 'public',
          isAdult: imageAdultFinal,
          owner: { connect: { id: actor.id } },
          tags: {
            create: tagIds.map((tagId) => ({ tagId })),
          },
        };

        if (imageModeration.requiresModeration) {
          imageData.moderationStatus = ModerationStatus.FLAGGED;
          imageData.flaggedAt = new Date();
        }

        const imageAsset = await tx.imageAsset.create({
          data: imageData,
        });

        const entryRecord = await tx.galleryEntry.create({
          data: {
            galleryId: gallery.id,
            imageId: imageAsset.id,
            position: positionCursor,
            note: payload.description ?? null,
          },
        });

        imageEntries.push({ imageId: imageAsset.id, entryId: entryRecord.id });
        positionCursor += 1;
      }

      if (!gallery.coverImage && imageEntries.length > 0) {
        const coverSource = imageFiles[0]?.storage ?? primaryStored;
        if (coverSource) {
          await tx.gallery.update({
            where: { id: gallery.id },
            data: { coverImage: toS3Uri(coverSource.bucket, coverSource.objectName) },
          });
        }
      }

      return {
        draftId: draft.id,
        imageId: imageEntries[0]?.imageId,
        imageIds: imageEntries.map((entry) => entry.imageId),
        gallerySlug: gallery.slug,
        entryIds: imageEntries.map((entry) => entry.entryId),
      };
    });

    res.status(201).json({
      uploadId: result.draftId,
      assetId: result.assetId,
      imageId: result.imageId,
      imageIds: result.imageIds,
      gallerySlug: result.gallerySlug,
      assetSlug: result.assetSlug,
      entryIds: result.entryIds,
      message:
        result.imageIds && result.imageIds.length > 1
          ? `Upload abgeschlossen. ${result.imageIds.length} Bilder wurden hinzugefügt und stehen im Explorer zur Verfügung.`
          : 'Upload abgeschlossen. Dateien wurden nach MinIO übertragen und stehen im Explorer zur Verfügung.',
    });
  } catch (error) {
    if (error instanceof Error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 403) {
        res.status(403).json({ message: 'Zugriff auf die ausgewählte Galerie ist nicht gestattet.' });
        return;
      }

      if (error.message === 'Gallery not found') {
        res.status(404).json({ message: 'Die ausgewählte Galerie konnte nicht gefunden werden.' });
        return;
      }
    }

    next(error);
  }
});
