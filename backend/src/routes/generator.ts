import { Prisma, GeneratorAccessMode } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { mapModelAsset, type HydratedModelAsset } from '../lib/mappers/model';
import { resolveStorageLocation } from '../lib/storage';

const generatorRouter = Router();

const generatorBaseModelTypeSchema = z.enum(['SD1.5', 'SDXL', 'PonyXL']);

const generatorBaseModelConfigSchema = z.object({
  type: generatorBaseModelTypeSchema,
  name: z.string().trim().min(1).max(120),
  filename: z.string().trim().min(1).max(512),
});

type GeneratorBaseModelConfig = z.infer<typeof generatorBaseModelConfigSchema>;

const generatorBaseModelSettingsSchema = z.array(generatorBaseModelConfigSchema).max(32).default([]);

const parseGeneratorBaseModels = (value: unknown): GeneratorBaseModelConfig[] => {
  const parsed = generatorBaseModelSettingsSchema.safeParse(value ?? []);
  if (!parsed.success) {
    return [];
  }

  return parsed.data.map((entry) => ({
    type: entry.type,
    name: entry.name.trim(),
    filename: entry.filename.trim(),
  }));
};

const extractObjectKey = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith('s3://')) {
    const withoutScheme = trimmed.slice('s3://'.length);
    const [, ...rest] = withoutScheme.split('/');
    const objectKey = rest.join('/');
    return objectKey.trim() || null;
  }

  return trimmed.replace(/^\/+/, '') || null;
};

const registerAssetKeys = (
  map: Map<string, ReturnType<typeof mapModelAsset>>,
  asset: ReturnType<typeof mapModelAsset>,
  key: string | null | undefined,
) => {
  const normalized = extractObjectKey(key);
  if (!normalized) {
    return;
  }

  if (!map.has(normalized)) {
    map.set(normalized, asset);
  }

  const tail = normalized.includes('/') ? normalized.slice(normalized.lastIndexOf('/') + 1) : normalized;
  if (tail && !map.has(tail)) {
    map.set(tail, asset);
  }
};

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

  return prisma.generatorSettings.create({ data: { baseModels: [] } });
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
  baseModels: generatorBaseModelSettingsSchema,
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
    const settings = await ensureSettings();
    const configured = parseGeneratorBaseModels(settings.baseModels);

    if (configured.length === 0) {
      res.json([]);
      return;
    }

    const filenames = Array.from(new Set(configured.map((entry) => entry.filename))).filter((entry) => entry.length > 0);

    let assets: HydratedModelAsset[] = [];
    if (filenames.length > 0) {
      const lookupConditions = filenames.map<Prisma.ModelAssetWhereInput>((filename) => ({
        OR: [
          { storagePath: filename },
          { storagePath: { endsWith: `/${filename}` } },
          {
            versions: {
              some: {
                OR: [
                  { storagePath: filename },
                  { storagePath: { endsWith: `/${filename}` } },
                ],
              },
            },
          },
        ],
      }));

      assets = (await prisma.modelAsset.findMany({
        where: { OR: lookupConditions },
        include: {
          tags: { include: { tag: true } },
          owner: { select: { id: true, displayName: true, email: true } },
          versions: { orderBy: { createdAt: 'desc' } },
        },
      })) as HydratedModelAsset[];
    }

    const mappedAssets = assets.map(mapModelAsset);
    const assetLookup = new Map<string, ReturnType<typeof mapModelAsset>>();

    mappedAssets.forEach((asset) => {
      registerAssetKeys(assetLookup, asset, asset.storagePath);
      registerAssetKeys(assetLookup, asset, asset.storageObject);
      asset.versions.forEach((version) => {
        registerAssetKeys(assetLookup, asset, version.storagePath);
        registerAssetKeys(assetLookup, asset, version.storageObject);
      });
    });

    const payload = configured.map((entry, index) => {
      const asset = assetLookup.get(entry.filename) ?? null;
      return {
        id: asset?.id ?? `config-${index}`,
        type: entry.type,
        name: entry.name,
        filename: entry.filename,
        asset,
        isMissing: !asset,
      };
    });

    res.json(payload);
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
        baseModels: parseGeneratorBaseModels(settings.baseModels),
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
    const parsed = settingsSchema.safeParse(req.body ?? {});
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
      data: { accessMode: parsed.data.accessMode, baseModels: parsed.data.baseModels },
    });

    res.json({
      settings: {
        id: updated.id,
        accessMode: updated.accessMode,
        baseModels: parseGeneratorBaseModels(updated.baseModels),
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
