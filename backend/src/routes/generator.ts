import { Prisma, GeneratorAccessMode } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { appConfig } from '../config';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { mapModelAsset, type HydratedModelAsset } from '../lib/mappers/model';
import { resolveStorageLocation, storageClient } from '../lib/storage';

const generatorRouter = Router();

const generatorBaseModelBucket = appConfig.generator.baseModelBucket.trim();
const normalizedGeneratorBaseBucket = generatorBaseModelBucket.toLowerCase();

type HydratedGeneratorRequest = Prisma.GeneratorRequestGetPayload<{
  include: {
    user: { select: { id: true; displayName: true; role: true } };
    baseModel: {
      include: {
        tags: { include: { tag: true } };
      };
    };
  };
}>;

const ensureSettings = async () => {
  const existing = await prisma.generatorSettings.findFirst({ orderBy: { id: 'asc' } });
  if (existing) {
    return existing;
  }

  return prisma.generatorSettings.create({ data: {} });
};

const mapGeneratorRequest = (request: HydratedGeneratorRequest) => {
  const basePreview = resolveStorageLocation(request.baseModel.previewImage);

  return {
    id: request.id,
    status: request.status,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    seed: request.seed,
    guidanceScale: request.guidanceScale,
    steps: request.steps,
    width: request.width,
    height: request.height,
    loras:
      Array.isArray(request.loraSelections) && request.loraSelections
        ? (request.loraSelections as Array<{ id: string; strength?: number; title?: string | null; slug?: string | null }>)
        : [],
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    baseModel: {
      id: request.baseModel.id,
      title: request.baseModel.title,
      slug: request.baseModel.slug,
      version: request.baseModel.version,
      previewImage: basePreview.url ?? request.baseModel.previewImage ?? null,
      previewImageBucket: basePreview.bucket,
      previewImageObject: basePreview.objectName,
      tags: request.baseModel.tags.map(({ tag }) => ({
        id: tag.id,
        label: tag.label,
        category: tag.category,
      })),
    },
    owner: {
      id: request.user.id,
      displayName: request.user.displayName,
      role: request.user.role,
    },
  };
};

const settingsSchema = z.object({
  accessMode: z.nativeEnum(GeneratorAccessMode),
});

const generatorRequestSchema = z.object({
  baseModelId: z.string().min(1, 'Base model is required.'),
  loras: z
    .array(
      z.object({
        id: z.string().min(1, 'LoRA id required.'),
        strength: z.coerce.number().min(-2).max(2).default(1),
      }),
    )
    .max(12)
    .default([]),
  prompt: z.string().min(1, 'Prompt is required.').max(4000),
  negativePrompt: z.string().max(4000).optional(),
  seed: z.string().max(64).optional(),
  guidanceScale: z.coerce.number().min(0).max(40).optional(),
  steps: z.coerce.number().int().min(1).max(200).optional(),
  width: z.coerce.number().int().min(256).max(2048),
  height: z.coerce.number().int().min(256).max(2048),
});

generatorRouter.get('/base-models', requireAuth, async (req, res, next) => {
  try {
    if (!generatorBaseModelBucket) {
      res.json([]);
      return;
    }

    const objectNames = new Set<string>();

    try {
      const stream = storageClient.listObjects(generatorBaseModelBucket, '', true);
      for await (const item of stream) {
        if (item.name) {
          objectNames.add(item.name);
        }
      }
    } catch (error) {
      console.error('Failed to enumerate generator base-model bucket', error);
      res.status(502).json({ message: 'Could not list base models from storage.' });
      return;
    }

    const viewer = req.user!;
    const isAdmin = viewer.role === 'ADMIN';
    const visibilityFilter: Prisma.ModelAssetWhereInput = isAdmin
      ? {}
      : { OR: [{ ownerId: viewer.id }, { isPublic: true }] };

    const assets = (await prisma.modelAsset.findMany({
      where: visibilityFilter,
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
        versions: { orderBy: { createdAt: 'desc' } },
      },
    })) as HydratedModelAsset[];

    const baseModels = assets
      .map(mapModelAsset)
      .filter((asset) => {
        if (!asset.storageBucket || asset.storageBucket.toLowerCase() !== normalizedGeneratorBaseBucket) {
          return false;
        }

        if (!asset.storageObject) {
          return false;
        }

        if (objectNames.size === 0) {
          return true;
        }

        return objectNames.has(asset.storageObject);
      })
      .sort((a, b) => a.title.localeCompare(b.title));

    res.json(baseModels);
  } catch (error) {
    next(error);
  }
});

generatorRouter.get('/settings', async (_req, res, next) => {
  try {
    const settings = await ensureSettings();
    res.json({
      settings: {
        id: settings.id,
        accessMode: settings.accessMode,
        createdAt: settings.createdAt.toISOString(),
        updatedAt: settings.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

generatorRouter.put('/settings', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        message: 'Invalid generator settings payload.',
        errors: parsed.error.flatten(),
      });
      return;
    }

    const current = await ensureSettings();
    const updated = await prisma.generatorSettings.update({
      where: { id: current.id },
      data: { accessMode: parsed.data.accessMode },
    });

    res.json({
      settings: {
        id: updated.id,
        accessMode: updated.accessMode,
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

generatorRouter.post('/requests', requireAuth, async (req, res, next) => {
  try {
    const parsed = generatorRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid generator request payload.', errors: parsed.error.flatten() });
      return;
    }

    const baseModel = await prisma.modelAsset.findUnique({
      where: { id: parsed.data.baseModelId },
      select: { id: true, isPublic: true, ownerId: true, title: true },
    });

    if (!baseModel) {
      res.status(404).json({ message: 'Base model not found.' });
      return;
    }

    const viewer = req.user!;
    if (!baseModel.isPublic && viewer.role !== 'ADMIN' && baseModel.ownerId !== viewer.id) {
      res.status(403).json({ message: 'No permission to use this base model.' });
      return;
    }

    const loraIds = parsed.data.loras.map((entry) => entry.id);
    let loraDetails: Array<{ id: string; strength: number; title: string | null; slug: string | null }> = [];

    if (loraIds.length > 0) {
      const records = await prisma.modelAsset.findMany({
        where: { id: { in: loraIds } },
        select: { id: true, title: true, slug: true, isPublic: true, ownerId: true },
      });

      const byId = new Map(records.map((entry) => [entry.id, entry]));

      for (const entry of parsed.data.loras) {
        const record = byId.get(entry.id);
        if (!record) {
          res.status(400).json({ message: `LoRA ${entry.id} not found.` });
          return;
        }

        if (!record.isPublic && viewer.role !== 'ADMIN' && record.ownerId !== viewer.id) {
          res.status(403).json({ message: 'No permission to use one or more LoRAs.' });
          return;
        }

        loraDetails.push({
          id: record.id,
          strength: entry.strength,
          title: record.title ?? null,
          slug: record.slug ?? null,
        });
      }
    }

    const created = await prisma.generatorRequest.create({
      data: {
        userId: viewer.id,
        baseModelId: baseModel.id,
        prompt: parsed.data.prompt,
        negativePrompt: parsed.data.negativePrompt ?? null,
        seed: parsed.data.seed ?? null,
        guidanceScale: parsed.data.guidanceScale ?? null,
        steps: parsed.data.steps ?? null,
        width: parsed.data.width,
        height: parsed.data.height,
        loraSelections: loraDetails,
      },
      include: {
        user: { select: { id: true, displayName: true, role: true } },
        baseModel: {
          include: {
            tags: { include: { tag: true } },
          },
        },
      },
    });

    res.status(201).json({ request: mapGeneratorRequest(created as HydratedGeneratorRequest) });
  } catch (error) {
    next(error);
  }
});

generatorRouter.get('/requests', requireAuth, async (req, res, next) => {
  try {
    const scope = typeof req.query.scope === 'string' ? req.query.scope : 'mine';

    if (scope === 'all' && req.user?.role !== 'ADMIN') {
      res.status(403).json({ message: 'Administrator privileges required to inspect all generator requests.' });
      return;
    }

    const where = scope === 'all' ? {} : { userId: req.user!.id };

    const requests = await prisma.generatorRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: {
        user: { select: { id: true, displayName: true, role: true } },
        baseModel: {
          include: {
            tags: { include: { tag: true } },
          },
        },
      },
    });

    res.json({ requests: requests.map((request) => mapGeneratorRequest(request as HydratedGeneratorRequest)) });
  } catch (error) {
    next(error);
  }
});

export { generatorRouter };
