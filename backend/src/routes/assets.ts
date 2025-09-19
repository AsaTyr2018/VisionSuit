import type { Prisma } from '@prisma/client';
import { ImageAsset, ModelAsset, Tag, User } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { requireAuth } from '../lib/middleware/auth';
import { resolveStorageLocation, storageClient } from '../lib/storage';

type HydratedModelAsset = ModelAsset & {
  tags: { tag: Tag }[];
  owner: Pick<User, 'id' | 'displayName' | 'email'>;
};

type HydratedImageAsset = ImageAsset & {
  tags: { tag: Tag }[];
  owner: Pick<User, 'id' | 'displayName' | 'email'>;
};

const mapModelAsset = (asset: HydratedModelAsset) => {
  const storage = resolveStorageLocation(asset.storagePath);
  const preview = resolveStorageLocation(asset.previewImage);

  return {
    id: asset.id,
    slug: asset.slug,
    title: asset.title,
    description: asset.description,
    version: asset.version,
    fileSize: asset.fileSize,
    checksum: asset.checksum,
    storagePath: storage.url ?? asset.storagePath,
    storageBucket: storage.bucket,
    storageObject: storage.objectName,
    previewImage: preview.url ?? asset.previewImage,
    previewImageBucket: preview.bucket,
    previewImageObject: preview.objectName,
    metadata: asset.metadata,
    owner: asset.owner,
    tags: asset.tags.map(({ tag }) => tag),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
};

const mapImageAsset = (asset: HydratedImageAsset) => {
  const storage = resolveStorageLocation(asset.storagePath);

  return {
    id: asset.id,
    title: asset.title,
    description: asset.description,
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

export const assetsRouter = Router();

assetsRouter.get('/models', async (_req, res, next) => {
  try {
    const assets = await prisma.modelAsset.findMany({
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(assets.map(mapModelAsset));
  } catch (error) {
    next(error);
  }
});

assetsRouter.get('/images', async (_req, res, next) => {
  try {
    const images = await prisma.imageAsset.findMany({
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
      select: { id: true, ownerId: true, storagePath: true, previewImage: true },
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

    await prisma.$transaction(async (tx) => {
      await tx.galleryEntry.deleteMany({ where: { assetId: asset.id } });
      await tx.assetTag.deleteMany({ where: { assetId: asset.id } });
      if (storage.objectName) {
        await tx.storageObject.deleteMany({ where: { id: storage.objectName } });
      }
      if (preview.objectName) {
        await tx.storageObject.deleteMany({ where: { id: preview.objectName } });
      }
      if (asset.previewImage) {
        await tx.gallery.updateMany({
          where: { coverImage: asset.previewImage },
          data: { coverImage: null },
        });
      }
      await tx.modelAsset.delete({ where: { id: asset.id } });
    });

    await removeStorageObject(storage.bucket, storage.objectName);
    await removeStorageObject(preview.bucket, preview.objectName);

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
