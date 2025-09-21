import { Prisma, GeneratorAccessMode } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { appConfig } from '../config';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { mapModelAsset, type HydratedModelAsset } from '../lib/mappers/model';
import {
  syncGeneratorBaseModels,
  type GeneratorBaseModelObject,
} from '../lib/generator/baseModelSync';
import { resolveStorageLocation, storageClient } from '../lib/storage';

const generatorRouter = Router();

const generatorBaseModelBucket = appConfig.generator.baseModelBucket.trim();
const normalizedGeneratorBaseBucket = generatorBaseModelBucket.toLowerCase();
const manifestCandidateObjects = Array.from(
  new Set(
    [
      appConfig.generator.baseModelManifestObject?.trim(),
      'minio-model-manifest.json',
      'model-manifest.json',
    ].filter((entry): entry is string => Boolean(entry && entry.length > 0)),
  ),
);

const readStreamToString = async (stream: NodeJS.ReadableStream): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    if (chunk instanceof Buffer) {
      chunks.push(chunk);
    } else if (typeof chunk === 'string') {
      chunks.push(Buffer.from(chunk));
    } else if (chunk) {
      const view = chunk as ArrayBufferView;
      const buffer = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
      chunks.push(buffer);
    }
  }

  return Buffer.concat(chunks).toString('utf-8');
};

const parseManifestSize = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return null;
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
};

const collectManifestEntries = (payload: unknown): GeneratorBaseModelObject[] => {
  if (!payload) {
    return [];
  }

  if (typeof payload === 'string') {
    return [{ name: payload, size: null }];
  }

  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => collectManifestEntries(entry));
  }

  if (typeof payload !== 'object') {
    return [];
  }

  const record = payload as Record<string, unknown>;
  const directKey =
    record.key ??
    record.Key ??
    record.name ??
    record.object ??
    record.objectName ??
    record.path ??
    record.storageObject ??
    record.storagePath ??
    record.location ??
    record.url ??
    record.file ??
    record.fileName ??
    record.filename;

  const sizeCandidates = [
    'size',
    'Size',
    'filesize',
    'fileSize',
    'length',
    'Length',
    'contentLength',
    'ContentLength',
    'bytes',
    'Bytes',
  ];

  let detectedSize: number | null = null;
  for (const key of sizeCandidates) {
    const parsed = parseManifestSize(record[key]);
    if (parsed !== null) {
      detectedSize = parsed;
      break;
    }
  }

  const results: GeneratorBaseModelObject[] = [];

  if (typeof directKey === 'string') {
    results.push({ name: directKey, size: detectedSize });
  }

  const nestedKeys = [
    'contents',
    'Contents',
    'objects',
    'Objects',
    'entries',
    'Entries',
    'items',
    'Items',
    'files',
    'Files',
    'data',
    'Data',
    'children',
    'Children',
  ];

  for (const key of nestedKeys) {
    const value = record[key];
    if (value) {
      results.push(...collectManifestEntries(value));
    }
  }

  return results;
};

const normalizeManifestObjectName = (value: string): string | null => {
  let trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('s3://')) {
    const withoutScheme = trimmed.slice('s3://'.length);
    const slashIndex = withoutScheme.indexOf('/');
    if (slashIndex === -1) {
      return null;
    }

    const possibleObject = withoutScheme.slice(slashIndex + 1);
    trimmed = possibleObject;
  }

  if (trimmed.startsWith(generatorBaseModelBucket + '/')) {
    trimmed = trimmed.slice(generatorBaseModelBucket.length + 1);
  }

  trimmed = trimmed.replace(/^\/+/, '');

  if (trimmed.length === 0 || trimmed.endsWith('/')) {
    return null;
  }

  return trimmed;
};

const loadObjectNamesFromManifest = async (): Promise<Map<string, GeneratorBaseModelObject>> => {
  const manifestNames = new Map<string, GeneratorBaseModelObject>();

  for (const objectName of manifestCandidateObjects) {
    try {
      const stream = await storageClient.getObject(generatorBaseModelBucket, objectName);
      const raw = await readStreamToString(stream);

      if (!raw || raw.trim().length === 0) {
        continue;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        console.warn('Failed to parse generator base-model manifest JSON', error);
        continue;
      }

      const entries = collectManifestEntries(parsed);
      for (const entry of entries) {
        const normalized = typeof entry.name === 'string' ? normalizeManifestObjectName(entry.name) : null;
        if (normalized) {
          manifestNames.set(normalized, { name: normalized, size: entry.size ?? null });
        }
      }

      if (manifestNames.size > 0) {
        break;
      }
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === 'NoSuchKey' || code === 'NotFound') {
        continue;
      }

      console.warn('Failed to load generator base-model manifest from storage', error);
    }
  }

  manifestCandidateObjects.forEach((candidate) => {
    if (candidate) {
      const normalized = normalizeManifestObjectName(candidate);
      if (normalized) {
        manifestNames.delete(normalized);
      }
    }
  });

  return manifestNames;
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

    const objectNames = await loadObjectNamesFromManifest();

    if (objectNames.size === 0) {
      try {
        const stream = storageClient.listObjects(generatorBaseModelBucket, '', true);
        for await (const item of stream) {
          if (item.name) {
            const size = typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : null;
            objectNames.set(item.name, { name: item.name, size });
          }
        }
      } catch (error) {
        console.error('Failed to enumerate generator base-model bucket', error);
        res.status(502).json({ message: 'Could not list base models from storage.' });
        return;
      }
    }

    try {
      await syncGeneratorBaseModels({
        prisma,
        bucket: generatorBaseModelBucket,
        ...(objectNames.size > 0 ? { objects: objectNames.values() } : {}),
      });
    } catch (error) {
      console.warn('Failed to synchronize generator base models automatically', error);
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
