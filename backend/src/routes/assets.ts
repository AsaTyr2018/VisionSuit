import crypto from 'node:crypto';

import { Prisma, ImageAsset, ModelAsset, ModelVersion, Tag, User } from '@prisma/client';
import type { Express } from 'express';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { requireAuth } from '../lib/middleware/auth';
import { extractModelMetadataFromFile } from '../lib/metadata';
import { MAX_TOTAL_SIZE_BYTES } from '../lib/uploadLimits';
import { resolveStorageLocation, storageBuckets, storageClient } from '../lib/storage';

type HydratedModelAsset = ModelAsset & {
  tags: { tag: Tag }[];
  owner: Pick<User, 'id' | 'displayName' | 'email'>;
  versions: ModelVersion[];
};

type HydratedImageAsset = ImageAsset & {
  tags: { tag: Tag }[];
  owner: Pick<User, 'id' | 'displayName' | 'email'>;
};

type MappedModelVersion = {
  id: string;
  version: string;
  storagePath: string;
  storageBucket: string | null;
  storageObject: string | null;
  previewImage: string | null;
  previewImageBucket: string | null;
  previewImageObject: string | null;
  fileSize: number | null;
  checksum: string | null;
  metadata: unknown;
  createdAt: Date;
  updatedAt: Date;
  isPrimary: boolean;
};

const mapModelVersion = (
  version: {
    id: string;
    version: string;
    storagePath: string;
    previewImage?: string | null;
    fileSize?: number | null;
    checksum?: string | null;
    metadata?: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
  },
  options: { isPrimary?: boolean } = {},
): MappedModelVersion => {
  const storage = resolveStorageLocation(version.storagePath);
  const preview = resolveStorageLocation(version.previewImage);

  return {
    id: version.id,
    version: version.version,
    storagePath: storage.url ?? version.storagePath,
    storageBucket: storage.bucket,
    storageObject: storage.objectName,
    previewImage: preview.url ?? version.previewImage ?? null,
    previewImageBucket: preview.bucket,
    previewImageObject: preview.objectName,
    fileSize: version.fileSize ?? null,
    checksum: version.checksum ?? null,
    metadata: version.metadata ?? null,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    isPrimary: Boolean(options.isPrimary),
  };
};

const parseNumericVersion = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
};

const compareVersionLabels = (a: string, b: string) => {
  const numericA = parseNumericVersion(a);
  const numericB = parseNumericVersion(b);

  if (numericA !== null && numericB !== null && numericA !== numericB) {
    return numericA - numericB;
  }

  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
};

const sortVersionsForDisplay = (a: MappedModelVersion, b: MappedModelVersion) => {
  if (a.isPrimary && !b.isPrimary) {
    return -1;
  }
  if (b.isPrimary && !a.isPrimary) {
    return 1;
  }

  if (a.isPrimary && b.isPrimary) {
    return 0;
  }

  return compareVersionLabels(a.version, b.version);
};

const getVersionRecency = (entry: MappedModelVersion) => {
  const created = new Date(entry.createdAt).getTime();
  const updated = new Date(entry.updatedAt).getTime();
  return Math.max(created, updated);
};

const sortVersionsByCreatedAtDesc = (a: MappedModelVersion, b: MappedModelVersion) =>
  getVersionRecency(b) - getVersionRecency(a);

const mapModelAsset = (asset: HydratedModelAsset) => {
  const primaryVersionSource = asset.versions.find((entry) => entry.storagePath === asset.storagePath);
  const additionalVersionSources = asset.versions.filter((entry) => entry.storagePath !== asset.storagePath);

  const primaryVersion = mapModelVersion(
    {
      id: asset.id,
      version: asset.version,
      storagePath: asset.storagePath,
      previewImage: asset.previewImage,
      fileSize: asset.fileSize,
      checksum: asset.checksum,
      metadata: asset.metadata,
      createdAt: primaryVersionSource?.createdAt ?? asset.createdAt,
      updatedAt: primaryVersionSource?.updatedAt ?? asset.updatedAt,
    },
    { isPrimary: true },
  );

  const mappedAdditionalVersions = additionalVersionSources.map((entry) =>
    mapModelVersion(
      {
        id: entry.id,
        version: entry.version,
        storagePath: entry.storagePath,
        previewImage: entry.previewImage,
        fileSize: entry.fileSize,
        checksum: entry.checksum,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      },
      { isPrimary: false },
    ),
  );

  const combinedVersions = [primaryVersion, ...mappedAdditionalVersions];
  const orderedVersions = [...combinedVersions].sort(sortVersionsForDisplay);
  const latestVersion = [...combinedVersions].sort(sortVersionsByCreatedAtDesc)[0] ?? primaryVersion;

  return {
    id: asset.id,
    slug: asset.slug,
    title: asset.title,
    description: asset.description,
    trigger: asset.trigger,
    isPublic: asset.isPublic,
    version: latestVersion.version,
    fileSize: latestVersion.fileSize,
    checksum: latestVersion.checksum,
    storagePath: latestVersion.storagePath,
    storageBucket: latestVersion.storageBucket,
    storageObject: latestVersion.storageObject,
    previewImage: latestVersion.previewImage,
    previewImageBucket: latestVersion.previewImageBucket,
    previewImageObject: latestVersion.previewImageObject,
    metadata: latestVersion.metadata,
    owner: asset.owner,
    tags: asset.tags.map(({ tag }) => tag),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    versions: orderedVersions,
    latestVersionId: latestVersion.id,
    primaryVersionId: primaryVersion.id,
  };
};

const mapImageAsset = (asset: HydratedImageAsset) => {
  const storage = resolveStorageLocation(asset.storagePath);

  return {
    id: asset.id,
    title: asset.title,
    description: asset.description,
    isPublic: asset.isPublic,
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
    tags: asset.tags.map(({ tag }) => tag),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
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
        select: { id: true },
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

const toS3Uri = (bucket: string, objectName: string) => `s3://${bucket}/${objectName}`;

export const assetsRouter = Router();

assetsRouter.get('/models', async (req, res, next) => {
  try {
    const viewer = req.user;
    const visibilityFilter: Prisma.ModelAssetWhereInput = viewer
      ? { OR: [{ ownerId: viewer.id }, { isPublic: true }] }
      : { isPublic: true };

    const assets = await prisma.modelAsset.findMany({
      where: visibilityFilter,
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
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
    const visibilityFilter: Prisma.ImageAssetWhereInput = viewer
      ? { OR: [{ ownerId: viewer.id }, { isPublic: true }] }
      : { isPublic: true };

    const images = await prisma.imageAsset.findMany({
      where: visibilityFilter,
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(images.map(mapImageAsset));
  } catch (error) {
    next(error);
  }
});

assetsRouter.post('/models/bulk-delete', requireAuth, async (req, res, next) => {
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

assetsRouter.put('/models/:modelId/versions/:versionId', requireAuth, async (req, res, next) => {
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

assetsRouter.post('/models/:modelId/versions/:versionId/promote', requireAuth, async (req, res, next) => {
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

assetsRouter.delete('/models/:modelId/versions/:versionId', requireAuth, async (req, res, next) => {
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

assetsRouter.post('/images/bulk-delete', requireAuth, async (req, res, next) => {
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

assetsRouter.put('/models/:id', requireAuth, async (req, res, next) => {
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

      return tx.modelAsset.update({
        where: { id: asset.id },
        data,
        include: {
          tags: { include: { tag: true } },
          owner: { select: { id: true, displayName: true, email: true } },
          versions: { orderBy: { createdAt: 'desc' } },
        },
      });
    });

    res.json(mapModelAsset(updated));
  } catch (error) {
    next(error);
  }
});

assetsRouter.delete('/models/:id', requireAuth, async (req, res, next) => {
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

    const storage = resolveStorageLocation(asset.storagePath);
    const preview = resolveStorageLocation(asset.previewImage);
    const versionLocations = asset.versions.map((version) => ({
      id: version.id,
      storage: resolveStorageLocation(version.storagePath),
      preview: resolveStorageLocation(version.previewImage),
      previewImage: version.previewImage,
    }));

    await prisma.$transaction(async (tx) => {
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
        await tx.gallery.updateMany({
          where: { coverImage: asset.previewImage },
          data: { coverImage: null },
        });
      }
      await tx.modelAsset.delete({ where: { id: asset.id } });
    });

    await Promise.all([
      removeStorageObject(storage.bucket, storage.objectName),
      removeStorageObject(preview.bucket, preview.objectName),
      ...versionLocations.flatMap((version) => [
        removeStorageObject(version.storage.bucket, version.storage.objectName),
        removeStorageObject(version.preview.bucket, version.preview.objectName),
      ]),
    ]);

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

assetsRouter.put('/images/:id', requireAuth, async (req, res, next) => {
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

      return tx.imageAsset.update({
        where: { id: image.id },
        data,
        include: {
          tags: { include: { tag: true } },
          owner: { select: { id: true, displayName: true, email: true } },
        },
      });
    });

    res.json(mapImageAsset(updated));
  } catch (error) {
    next(error);
  }
});

assetsRouter.delete('/images/:id', requireAuth, async (req, res, next) => {
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

    const storage = resolveStorageLocation(image.storagePath);

    await prisma.$transaction(async (tx) => {
      await tx.galleryEntry.deleteMany({ where: { imageId: image.id } });
      await tx.imageTag.deleteMany({ where: { imageId: image.id } });
      if (storage.objectName) {
        await tx.storageObject.deleteMany({ where: { id: storage.objectName } });
      }
      await tx.gallery.updateMany({
        where: { coverImage: image.storagePath },
        data: { coverImage: null },
      });
      await tx.imageAsset.delete({ where: { id: image.id } });
    });

    await removeStorageObject(storage.bucket, storage.objectName);

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
