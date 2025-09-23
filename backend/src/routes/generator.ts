import { Prisma, GeneratorAccessMode } from '@prisma/client';
import type { GeneratorQueueState } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { appConfig } from '../config';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { mapModelAsset, type HydratedModelAsset } from '../lib/mappers/model';
import { resolveStorageLocation } from '../lib/storage';
import { dispatchGeneratorRequest } from '../lib/generator/dispatcher';

const generatorRouter = Router();

const generatorBaseModelTypeSchema = z.enum(['SD1.5', 'SDXL', 'PonyXL']);

const generatorBaseModelConfigSchema = z.object({
  type: generatorBaseModelTypeSchema,
  name: z.string().trim().min(1).max(120),
  filename: z.string().trim().min(1).max(512),
});

type GeneratorBaseModelConfig = z.infer<typeof generatorBaseModelConfigSchema>;

const generatorBaseModelSettingsSchema = z.array(generatorBaseModelConfigSchema).max(32).default([]);

const CONFIGURED_BASE_MODEL_PREFIX = 'config-';

const normalizeGeneratorBaseModelSource = (value: unknown): unknown => {
  if (value === null || value === undefined) {
    return [];
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return [];
    }

    try {
      return JSON.parse(trimmed);
    } catch (error) {
      console.warn('Failed to parse generator baseModels JSON string.', error);
      return [];
    }
  }

  if (Buffer.isBuffer(value)) {
    const asString = value.toString('utf-8').trim();
    if (asString.length === 0) {
      return [];
    }

    try {
      return JSON.parse(asString);
    } catch (error) {
      console.warn('Failed to parse generator baseModels buffer payload.', error);
      return [];
    }
  }

  return value;
};

const parseGeneratorBaseModels = (value: unknown): GeneratorBaseModelConfig[] => {
  const parsed = generatorBaseModelSettingsSchema.safeParse(normalizeGeneratorBaseModelSource(value));
  if (!parsed.success) {
    return [];
  }

  return parsed.data.map((entry) => ({
    type: entry.type,
    name: entry.name.trim(),
    filename: entry.filename.trim(),
  }));
};

const extractSettingsBaseModels = (settings: unknown): unknown => {
  if (!settings || typeof settings !== 'object') {
    return [];
  }

  if ('baseModels' in settings) {
    const payload = (settings as { baseModels?: unknown }).baseModels;
    return payload ?? [];
  }

  return [];
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

type StoredBaseModelSelection = {
  id: string;
  name: string | null;
  type: string | null;
  title: string | null;
  slug: string | null;
  version: string | null;
  storagePath: string | null;
  filename: string | null;
  source: 'catalog' | 'configured';
};

const parseStoredBaseModelSelections = (value: unknown): StoredBaseModelSelection[] => {
  if (!value) {
    return [];
  }

  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch (error) {
            console.warn('Failed to parse baseModelSelections JSON string.', error);
            return [];
          }
        })()
      : value;

  if (!Array.isArray(raw)) {
    return [];
  }

  const selections: StoredBaseModelSelection[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }

    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    if (!id) {
      continue;
    }

    selections.push({
      id,
      name: typeof record.name === 'string' ? record.name : null,
      type: typeof record.type === 'string' ? record.type : null,
      title: typeof record.title === 'string' ? record.title : null,
      slug: typeof record.slug === 'string' ? record.slug : null,
      version: typeof record.version === 'string' ? record.version : null,
      storagePath: typeof record.storagePath === 'string' ? record.storagePath : null,
      filename: typeof record.filename === 'string' ? record.filename : null,
      source: record.source === 'configured' ? 'configured' : 'catalog',
    });
  }

  return selections;
};

type EnumeratedBaseModelConfig = GeneratorBaseModelConfig & {
  id: string;
  storagePath: string | null;
};

const normalizeConfiguredBucket = (bucketValue: string | null | undefined): string => {
  const value = bucketValue?.trim() ?? '';
  if (!value) {
    return '';
  }

  return value.replace(/^s3:\/\//i, '').replace(/\/+$/, '');
};

const configuredBucket = normalizeConfiguredBucket(appConfig.generator.baseModelBucket);

const buildConfiguredBaseModelStoragePath = (filename: string): string | null => {
  const normalizedKey = filename.trim().replace(/^\/+/, '');
  if (!configuredBucket || !normalizedKey) {
    return null;
  }

  return `s3://${configuredBucket}/${normalizedKey}`;
};

const enumerateConfiguredBaseModels = (entries: GeneratorBaseModelConfig[]): EnumeratedBaseModelConfig[] =>
  entries.map((entry, index) => ({
    ...entry,
    id: `${CONFIGURED_BASE_MODEL_PREFIX}${index}`,
    storagePath: buildConfiguredBaseModelStoragePath(entry.filename),
  }));

const generatorRequestInclude = {
  user: { select: { id: true, displayName: true, email: true, role: true } },
  baseModel: {
    include: {
      tags: { include: { tag: true } },
    },
  },
  artifacts: true,
} as const;

type HydratedGeneratorRequest = Prisma.GeneratorRequestGetPayload<{
  include: typeof generatorRequestInclude;
}>;

const sanitizeGeneratorSettingsBaseModels = async () => {
  try {
    await prisma.$executeRawUnsafe(`
      UPDATE "GeneratorSettings"
      SET "baseModels" = '[]'
      WHERE "baseModels" IS NULL OR json_valid("baseModels") = 0
    `);
  } catch (rawError) {
    await prisma.$executeRawUnsafe(`
      UPDATE "GeneratorSettings"
      SET "baseModels" = '[]'
      WHERE "baseModels" IS NULL OR trim("baseModels") = ''
    `);
  }
};

const loadGeneratorSettings = () => prisma.generatorSettings.findFirst({ orderBy: { id: 'asc' } });

const ensureSettings = async () => {
  try {
    const existing = await loadGeneratorSettings();
    if (existing) {
      return existing;
    }
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2023') {
      await sanitizeGeneratorSettingsBaseModels();
      try {
        const existing = await loadGeneratorSettings();
        if (existing) {
          return existing;
        }
      } catch (retryError) {
        throw retryError;
      }
    } else {
      throw error;
    }
  }

  return prisma.generatorSettings.create({ data: {} });
};

const loadQueueState = () => prisma.generatorQueueState.findFirst({ orderBy: { id: 'asc' } });

const ensureQueueState = async () => {
  const existing = await loadQueueState();
  if (existing) {
    return existing;
  }

  return prisma.generatorQueueState.create({ data: {} });
};

const mapQueueStateRecord = (state: GeneratorQueueState) => ({
  id: state.id,
  isPaused: state.isPaused,
  declineNewRequests: state.declineNewRequests,
  pausedAt: state.pausedAt ? state.pausedAt.toISOString() : null,
  createdAt: state.createdAt.toISOString(),
  updatedAt: state.updatedAt.toISOString(),
});

const mapQueueActivitySnapshot = (state: GeneratorQueueState) => {
  if (!state.activity) {
    return null;
  }

  return {
    data: state.activity,
    updatedAt: state.activityUpdatedAt ? state.activityUpdatedAt.toISOString() : null,
  };
};

const computeQueueStats = async () => {
  const grouped = await prisma.generatorRequest.groupBy({
    by: ['status'],
    _count: { _all: true },
  });

  const counts = grouped.reduce<Record<string, number>>((accumulator, entry) => {
    accumulator[entry.status] = entry._count._all;
    return accumulator;
  }, {});

  const getCount = (...statuses: string[]) =>
    statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);

  const total = grouped.reduce((sum, entry) => sum + entry._count._all, 0);

  return {
    total,
    queued: counts['queued'] ?? 0,
    pending: counts['pending'] ?? 0,
    held: counts['held'] ?? 0,
    running: getCount('running', 'uploading'),
    completed: counts['completed'] ?? 0,
    failed: getCount('failed', 'error', 'cancelled'),
    statuses: counts,
  };
};

type RedispatchSummary = {
  attempted: number;
  queued: number;
  busy: number;
  errors: Array<{ id: string; message: string }>;
};

const redispatchPendingRequests = async (): Promise<RedispatchSummary> => {
  const state = await ensureQueueState();
  if (state.isPaused) {
    return { attempted: 0, queued: 0, busy: 0, errors: [] };
  }

  const candidates = await prisma.generatorRequest.findMany({
    where: { status: { in: ['pending', 'held', 'error'] } },
    include: generatorRequestInclude,
    orderBy: { createdAt: 'asc' },
  });

  const summary: RedispatchSummary = { attempted: candidates.length, queued: 0, busy: 0, errors: [] };

  for (const candidate of candidates) {
    await prisma.generatorRequest.update({
      where: { id: candidate.id },
      data: { status: 'pending', errorReason: null },
    });

    try {
      const result = await dispatchGeneratorRequest(candidate as HydratedGeneratorRequest);

      if (result.status === 'queued') {
        summary.queued += 1;
        await prisma.generatorRequest.update({
          where: { id: candidate.id },
          data: { status: 'queued', errorReason: null },
        });
        continue;
      }

      if (result.status === 'busy') {
        summary.busy += 1;
        await prisma.generatorRequest.update({
          where: { id: candidate.id },
          data: { status: 'pending' },
        });
        continue;
      }

      const message = result.message ?? 'GPU agent rejected the request.';
      summary.errors.push({ id: candidate.id, message });
      await prisma.generatorRequest.update({
        where: { id: candidate.id },
        data: { status: 'error', errorReason: message },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to dispatch generator request.';
      summary.errors.push({ id: candidate.id, message });
      await prisma.generatorRequest.update({
        where: { id: candidate.id },
        data: { status: 'error', errorReason: message },
      });
    }
  }

  return summary;
};

const mapQueueBlock = (
  block: Prisma.GeneratorQueueBlockGetPayload<{
    include: { user: { select: { id: true; displayName: true; email: true; role: true } } };
  }>,
) => ({
  user: {
    id: block.user.id,
    displayName: block.user.displayName,
    email: block.user.email,
    role: block.user.role,
  },
  reason: block.reason ?? null,
  createdAt: block.createdAt.toISOString(),
  updatedAt: block.updatedAt.toISOString(),
});

const buildQueueResponse = async (viewer: { id: string; role: string }) => {
  const [state, stats, viewerBlock] = await Promise.all([
    ensureQueueState(),
    computeQueueStats(),
    prisma.generatorQueueBlock.findUnique({ where: { userId: viewer.id } }),
  ]);

  const blocks =
    viewer.role === 'ADMIN'
      ? (
          await prisma.generatorQueueBlock.findMany({
            include: { user: { select: { id: true, displayName: true, email: true, role: true } } },
            orderBy: { createdAt: 'asc' },
          })
        ).map(mapQueueBlock)
      : undefined;

  return {
    state: mapQueueStateRecord(state),
    stats,
    activity: mapQueueActivitySnapshot(state),
    viewer: {
      isBlocked: Boolean(viewerBlock),
      reason: viewerBlock?.reason ?? null,
    },
    ...(blocks ? { blocks } : {}),
  };
};

const mapGeneratorRequest = (request: HydratedGeneratorRequest) => {
  const storedSelections = parseStoredBaseModelSelections(request.baseModelSelections);
  const primarySelection = storedSelections[0] ?? null;
  const baseModelRecord = request.baseModel ?? null;
  const basePreview = baseModelRecord
    ? resolveStorageLocation(baseModelRecord.previewImage)
    : { bucket: null, objectName: null, url: null };

  const inferredTitle =
    baseModelRecord?.title ?? primarySelection?.title ?? primarySelection?.name ?? 'Base model';
  const inferredSlug = baseModelRecord?.slug ?? primarySelection?.slug ?? primarySelection?.id ?? '';
  const inferredVersion = baseModelRecord?.version ?? primarySelection?.version ?? null;

  const baseModels = (storedSelections.length > 0
    ? storedSelections
    : baseModelRecord
        ? [
            {
              id: baseModelRecord.id,
              name: baseModelRecord.title,
              type: null,
              title: baseModelRecord.title,
              slug: baseModelRecord.slug,
              version: baseModelRecord.version,
              storagePath: baseModelRecord.storagePath ?? null,
              filename: null,
              source: 'catalog' as const,
            },
          ]
        : []
  ).map((entry) => ({
    id: entry.id,
    name: entry.name ?? inferredTitle,
    type: entry.type,
    title: entry.title ?? entry.name ?? inferredTitle,
    slug: entry.slug,
    version: entry.version,
    filename: entry.filename ?? null,
    source: entry.source,
  }));

  return {
    id: request.id,
    status: request.status,
    errorReason: request.errorReason ?? null,
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
    baseModels,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
    baseModel: {
      id: baseModelRecord?.id ?? primarySelection?.id ?? 'configured-base-model',
      title: inferredTitle,
      slug: inferredSlug,
      version: inferredVersion ?? 'configured',
      previewImage: basePreview.url ?? baseModelRecord?.previewImage ?? null,
      previewImageBucket: basePreview.bucket,
      previewImageObject: basePreview.objectName,
      tags: baseModelRecord
        ? baseModelRecord.tags.map(({ tag }) => ({
            id: tag.id,
            label: tag.label,
            category: tag.category,
          }))
        : [],
    },
    owner: {
      id: request.user.id,
      displayName: request.user.displayName,
      role: request.user.role,
    },
    artifacts: request.artifacts
      .slice()
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((artifact) => {
        const location = resolveStorageLocation(artifact.storagePath);
        return {
          id: artifact.id,
          bucket: artifact.bucket,
          objectKey: artifact.objectKey,
          storagePath: artifact.storagePath,
          url: location.url,
          createdAt: artifact.createdAt.toISOString(),
        };
      }),
    output: {
      bucket: request.outputBucket ?? appConfig.generator.output.bucket,
      prefix: request.outputPrefix ?? null,
    },
  };
};

const settingsSchema = z.object({
  accessMode: z.nativeEnum(GeneratorAccessMode),
  baseModels: generatorBaseModelSettingsSchema,
});

generatorRouter.get('/base-models/catalog', requireAuth, async (_req, res, next) => {
  try {
    const bucket = appConfig.generator.baseModelBucket?.trim() ?? '';
    const normalizedBucket = bucket.replace(/^s3:\/\//i, '').replace(/\/+$/, '');

    const conditions: Prisma.ModelAssetWhereInput[] = [
      {
        metadata: {
          path: 'generatorBaseModel',
          equals: true,
        },
      },
    ];

    if (normalizedBucket) {
      const bucketPrefix = `s3://${normalizedBucket}/`;
      conditions.push(
        {
          metadata: {
            path: 'sourceBucket',
            equals: normalizedBucket,
          },
        },
        { storagePath: { startsWith: bucketPrefix } },
        {
          versions: {
            some: {
              storagePath: { startsWith: bucketPrefix },
            },
          },
        },
      );
    }

    const assets = (await prisma.modelAsset.findMany({
      where: { OR: conditions },
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
        versions: { orderBy: { createdAt: 'desc' } },
      },
    })) as HydratedModelAsset[];

    const mapped = assets.map(mapModelAsset);
    const unique = new Map<string, ReturnType<typeof mapModelAsset>>();
    mapped.forEach((asset) => {
      if (!unique.has(asset.id)) {
        unique.set(asset.id, asset);
      }
    });

    const payload = Array.from(unique.values()).sort((a, b) => a.title.localeCompare(b.title));

    res.json({ baseModels: payload });
  } catch (error) {
    next(error);
  }
});

const generatorRequestSchema = z.object({
  baseModels: z
    .array(
      z.object({
        id: z.string().trim().min(1, 'Base model id required.'),
        name: z.string().trim().min(1, 'Base model name required.'),
        type: generatorBaseModelTypeSchema,
      }),
    )
    .min(1, 'Select at least one base model.')
    .max(32),
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

const generatorStatusCallbackSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(['queued', 'running', 'uploading']),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const generatorCompletionCallbackSchema = z.object({
  jobId: z.string().min(1),
  status: z.literal('completed'),
  artifacts: z.array(z.string().min(1)).default([]),
});

const generatorFailureCallbackSchema = z.object({
  jobId: z.string().min(1),
  status: z.enum(['failed', 'error']).default('failed'),
  reason: z.string().optional(),
});

const generatorQueueBlockSchema = z.object({
  userId: z.string().min(1),
  reason: z.string().trim().max(512).optional(),
});

generatorRouter.get('/base-models', requireAuth, async (req, res, next) => {
  try {
    const settings = await ensureSettings();
    const configured = parseGeneratorBaseModels(extractSettingsBaseModels(settings));
    const enumeratedConfigured = enumerateConfiguredBaseModels(configured);

    if (enumeratedConfigured.length === 0) {
      res.json([]);
      return;
    }

    const filenames = Array.from(new Set(enumeratedConfigured.map((entry) => entry.filename))).filter(
      (entry) => entry.length > 0,
    );

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

    const payload = enumeratedConfigured.map((entry) => {
      const asset = assetLookup.get(entry.filename) ?? null;
      const storagePath = asset?.storagePath ?? entry.storagePath ?? null;
      const isConfigured = !asset;
      return {
        id: asset?.id ?? entry.id,
        type: entry.type,
        name: entry.name,
        filename: entry.filename,
        asset,
        isMissing: storagePath ? false : isConfigured,
        storagePath,
        source: isConfigured ? 'configured' : 'catalog',
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
        baseModels: parseGeneratorBaseModels(extractSettingsBaseModels(settings)),
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
      data: {
        accessMode: parsed.data.accessMode,
        baseModels: parsed.data.baseModels,
      } as unknown as Prisma.GeneratorSettingsUpdateInput,
    });

    res.json({
      settings: {
        id: updated.id,
        accessMode: updated.accessMode,
        baseModels: parseGeneratorBaseModels(extractSettingsBaseModels(updated)),
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

generatorRouter.get('/queue', requireAuth, async (req, res, next) => {
  try {
    const viewer = req.user!;
    const response = await buildQueueResponse({ id: viewer.id, role: viewer.role });
    res.json(response);
  } catch (error) {
    next(error);
  }
});

generatorRouter.post('/queue/actions/pause', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const state = await ensureQueueState();
    const now = new Date();
    await prisma.generatorQueueState.update({
      where: { id: state.id },
      data: {
        isPaused: true,
        declineNewRequests: true,
        pausedAt: now,
      },
    });

    await prisma.generatorRequest.updateMany({
      where: { status: 'pending' },
      data: { status: 'held' },
    });

    const viewer = req.user!;
    const response = await buildQueueResponse({ id: viewer.id, role: viewer.role });
    res.json(response);
  } catch (error) {
    next(error);
  }
});

generatorRouter.post('/queue/actions/resume', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const state = await ensureQueueState();
    await prisma.generatorQueueState.update({
      where: { id: state.id },
      data: {
        isPaused: false,
        declineNewRequests: false,
        pausedAt: null,
      },
    });

    await prisma.generatorRequest.updateMany({
      where: { status: 'held' },
      data: { status: 'pending' },
    });

    const summary = await redispatchPendingRequests();
    const viewer = req.user!;
    const response = await buildQueueResponse({ id: viewer.id, role: viewer.role });
    res.json({ ...response, redispatch: summary });
  } catch (error) {
    next(error);
  }
});

generatorRouter.post('/queue/actions/retry', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    await prisma.generatorRequest.updateMany({
      where: { status: 'held' },
      data: { status: 'pending' },
    });

    const summary = await redispatchPendingRequests();
    const viewer = req.user!;
    const response = await buildQueueResponse({ id: viewer.id, role: viewer.role });
    res.json({ ...response, redispatch: summary });
  } catch (error) {
    next(error);
  }
});

generatorRouter.post('/queue/actions/clear', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const statusesToClear = ['pending', 'queued', 'held', 'error'];
    const result = await prisma.generatorRequest.updateMany({
      where: { status: { in: statusesToClear } },
      data: { status: 'cancelled', errorReason: 'Cleared by administrator.' },
    });

    const viewer = req.user!;
    const response = await buildQueueResponse({ id: viewer.id, role: viewer.role });
    res.json({ ...response, cleared: { removed: result.count } });
  } catch (error) {
    next(error);
  }
});

generatorRouter.post('/queue/blocks', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const parsed = generatorQueueBlockSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid block payload.', errors: parsed.error.flatten() });
      return;
    }

    const targetUser = await prisma.user.findUnique({ where: { id: parsed.data.userId } });
    if (!targetUser) {
      res.status(404).json({ message: 'User not found for generator block.' });
      return;
    }

    await prisma.generatorQueueBlock.upsert({
      where: { userId: parsed.data.userId },
      update: { reason: parsed.data.reason ?? null },
      create: { userId: parsed.data.userId, reason: parsed.data.reason ?? null },
    });

    const viewer = req.user!;
    const response = await buildQueueResponse({ id: viewer.id, role: viewer.role });
    res.status(201).json(response);
  } catch (error) {
    next(error);
  }
});

generatorRouter.delete('/queue/blocks/:userId', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { userId } = req.params;
    if (!userId) {
      res.status(400).json({ message: 'User id is required to remove a generator block.' });
      return;
    }

    try {
      await prisma.generatorQueueBlock.delete({ where: { userId } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
        res.status(404).json({ message: 'No generator block found for that user.' });
        return;
      }

      throw error;
    }

    const viewer = req.user!;
    const response = await buildQueueResponse({ id: viewer.id, role: viewer.role });
    res.json(response);
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

    const viewer = req.user!;
    const [queueState, blockRecord] = await Promise.all([
      ensureQueueState(),
      prisma.generatorQueueBlock.findUnique({ where: { userId: viewer.id } }),
    ]);

    if (blockRecord) {
      const reason = blockRecord.reason?.trim();
      res.status(403).json({
        message: reason && reason.length > 0
          ? `Generation access suspended: ${reason}`
          : 'Generation access has been suspended by an administrator.',
      });
      return;
    }

    if (queueState.isPaused || queueState.declineNewRequests) {
      res.status(503).json({
        message: 'Generator queue is currently paused. Try again once processing resumes.',
      });
      return;
    }

    const settings = await ensureSettings();
    const configuredEntries = enumerateConfiguredBaseModels(
      parseGeneratorBaseModels(extractSettingsBaseModels(settings)),
    );
    const configuredById = new Map(configuredEntries.map((entry) => [entry.id, entry]));

    const baseModelIds = parsed.data.baseModels.map((entry) => entry.id);

    const baseModelRecords = await prisma.modelAsset.findMany({
      where: { id: { in: baseModelIds } },
      select: {
        id: true,
        title: true,
        slug: true,
        version: true,
        isPublic: true,
        ownerId: true,
        storagePath: true,
      },
    });

    const baseModelsById = new Map(baseModelRecords.map((entry) => [entry.id, entry]));
    const orderedBaseModels: StoredBaseModelSelection[] = [];

    for (const selection of parsed.data.baseModels) {
      const record = baseModelsById.get(selection.id);
      if (record) {
        if (!record.isPublic && viewer.role !== 'ADMIN' && record.ownerId !== viewer.id) {
          res.status(403).json({ message: 'No permission to use one or more base models.' });
          return;
        }

        const normalizedName = selection.name.trim();
        const displayName = normalizedName.length > 0 ? normalizedName : record.title ?? 'Base model';

        orderedBaseModels.push({
          id: record.id,
          name: displayName,
          type: selection.type,
          title: record.title ?? null,
          slug: record.slug ?? null,
          version: record.version ?? null,
          storagePath: record.storagePath ?? null,
          filename: null,
          source: 'catalog',
        });
        continue;
      }

      const configured = configuredById.get(selection.id);
      if (!configured) {
        res.status(404).json({ message: `Base model ${selection.id} not found.` });
        return;
      }

      const normalizedName = selection.name.trim();
      const displayName = normalizedName.length > 0 ? normalizedName : configured.name;

      orderedBaseModels.push({
        id: configured.id,
        name: displayName,
        type: selection.type ?? configured.type,
        title: configured.name,
        slug: null,
        version: null,
        storagePath: configured.storagePath,
        filename: configured.filename,
        source: 'configured',
      });
    }

    const primaryBaseModel = orderedBaseModels[0];
    if (!primaryBaseModel) {
      res.status(400).json({ message: 'Select at least one base model.' });
      return;
    }

    const primaryRecord = baseModelsById.get(primaryBaseModel.id) ?? null;
    const primaryStoragePath = primaryRecord?.storagePath ?? primaryBaseModel.storagePath ?? null;
    if (!primaryStoragePath) {
      res.status(400).json({ message: 'Selected base model is missing a storage location.' });
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
        baseModelId: primaryRecord?.id ?? null,
        baseModelSelections: orderedBaseModels as unknown as Prisma.JsonArray,
        prompt: parsed.data.prompt,
        negativePrompt: parsed.data.negativePrompt ?? null,
        seed: parsed.data.seed ?? null,
        guidanceScale: parsed.data.guidanceScale ?? null,
        steps: parsed.data.steps ?? null,
        width: parsed.data.width,
        height: parsed.data.height,
        loraSelections: loraDetails,
      },
      include: generatorRequestInclude,
    });

    const outputPrefixTemplate = appConfig.generator.output.prefixTemplate || 'generated/{userId}/{jobId}';
    const outputPrefix = outputPrefixTemplate
      .replace(/\{userId\}/g, created.user.id)
      .replace(/\{jobId\}/g, created.id);

    await prisma.generatorRequest.update({
      where: { id: created.id },
      data: {
        outputBucket: appConfig.generator.output.bucket,
        outputPrefix,
      },
    });

    const latestQueueState = await ensureQueueState();
    if (latestQueueState.isPaused || latestQueueState.declineNewRequests) {
      await prisma.generatorRequest.update({
        where: { id: created.id },
        data: { status: 'held' },
      });
    } else {
      try {
        const dispatchResult = await dispatchGeneratorRequest(created as HydratedGeneratorRequest);

        if (dispatchResult.status === 'queued') {
          await prisma.generatorRequest.update({
            where: { id: created.id },
            data: { status: 'queued' },
          });
        } else if (dispatchResult.status === 'busy') {
          await prisma.generatorRequest.update({
            where: { id: created.id },
            data: { status: 'pending' },
          });
          if (dispatchResult.message) {
            // eslint-disable-next-line no-console
            console.warn(`Generator agent busy: ${dispatchResult.message}`);
          }
        } else if (dispatchResult.status === 'error') {
          await prisma.generatorRequest.update({
            where: { id: created.id },
            data: { status: 'error', errorReason: dispatchResult.message ?? null },
          });
          if (dispatchResult.message) {
            // eslint-disable-next-line no-console
            console.error(`Generator agent rejected request ${created.id}: ${dispatchResult.message}`);
          }
        }
      } catch (dispatchError) {
        // eslint-disable-next-line no-console
        console.error('Failed to dispatch generator request', dispatchError);
        await prisma.generatorRequest.update({
          where: { id: created.id },
          data: { status: 'error', errorReason: dispatchError instanceof Error ? dispatchError.message : null },
        });
      }
    }

    const refreshed = await prisma.generatorRequest.findUnique({
      where: { id: created.id },
      include: generatorRequestInclude,
    });

    res.status(201).json({ request: mapGeneratorRequest(refreshed as HydratedGeneratorRequest) });
  } catch (error) {
    next(error);
  }
});

generatorRouter.post('/requests/:id/callbacks/status', async (req, res, next) => {
  try {
    const parsed = generatorStatusCallbackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid status callback payload.', errors: parsed.error.flatten() });
      return;
    }

    const jobId = req.params.id;
    if (!jobId || parsed.data.jobId !== jobId) {
      res.status(400).json({ message: 'Status callback job ID mismatch.' });
      return;
    }

    const updated = await prisma.generatorRequest.update({
      where: { id: jobId },
      data: { status: parsed.data.status, errorReason: null },
      include: generatorRequestInclude,
    });

    const activityPayload = parsed.data.extra?.activity;
    if (activityPayload && typeof activityPayload === 'object') {
      try {
        const state = await ensureQueueState();
        await prisma.generatorQueueState.update({
          where: { id: state.id },
          data: {
            activity: activityPayload as Prisma.InputJsonValue,
            activityUpdatedAt: new Date(),
          },
        });
      } catch (activityError) {
        if (process.env.NODE_ENV === 'development') {
          // eslint-disable-next-line no-console
          console.warn('Failed to persist generator queue activity snapshot:', activityError);
        }
      }
    }

    res.json({ request: mapGeneratorRequest(updated as HydratedGeneratorRequest) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ message: 'Generator request not found for status update.' });
      return;
    }

    next(error);
  }
});

generatorRouter.post('/requests/:id/callbacks/completion', async (req, res, next) => {
  try {
    const parsed = generatorCompletionCallbackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid completion callback payload.', errors: parsed.error.flatten() });
      return;
    }

    const jobId = req.params.id;
    if (!jobId || parsed.data.jobId !== jobId) {
      res.status(400).json({ message: 'Completion callback job ID mismatch.' });
      return;
    }

    const requestRecord = await prisma.generatorRequest.findUnique({
      where: { id: jobId },
      select: { id: true, outputBucket: true },
    });

    if (!requestRecord) {
      res.status(404).json({ message: 'Generator request not found for completion callback.' });
      return;
    }

    const bucket = requestRecord.outputBucket ?? appConfig.generator.output.bucket;
    const uniqueKeys = Array.from(new Set(parsed.data.artifacts));

    await prisma.$transaction(async (tx) => {
      await tx.generatorArtifact.deleteMany({ where: { requestId: jobId } });

      if (uniqueKeys.length > 0) {
        await tx.generatorArtifact.createMany({
          data: uniqueKeys.map((objectKey) => ({
            requestId: jobId,
            bucket,
            objectKey,
            storagePath: `s3://${bucket}/${objectKey.replace(/^\/+/, '')}`,
          })),
        });
      }

      await tx.generatorRequest.update({
        where: { id: jobId },
        data: { status: 'completed', errorReason: null },
      });
    });

    const updated = await prisma.generatorRequest.findUnique({
      where: { id: jobId },
      include: generatorRequestInclude,
    });

    res.json({ request: mapGeneratorRequest(updated as HydratedGeneratorRequest) });
  } catch (error) {
    next(error);
  }
});

generatorRouter.post('/requests/:id/callbacks/failure', async (req, res, next) => {
  try {
    const parsed = generatorFailureCallbackSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid failure callback payload.', errors: parsed.error.flatten() });
      return;
    }

    const jobId = req.params.id;
    if (!jobId || parsed.data.jobId !== jobId) {
      res.status(400).json({ message: 'Failure callback job ID mismatch.' });
      return;
    }

    const reason = parsed.data.reason?.trim() ?? null;

    const updated = await prisma.generatorRequest.update({
      where: { id: jobId },
      data: { status: parsed.data.status, errorReason: reason },
      include: generatorRequestInclude,
    });

    res.json({ request: mapGeneratorRequest(updated as HydratedGeneratorRequest) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ message: 'Generator request not found for failure callback.' });
      return;
    }

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
      include: generatorRequestInclude,
    });

    res.json({ requests: requests.map((request) => mapGeneratorRequest(request as HydratedGeneratorRequest)) });
  } catch (error) {
    next(error);
  }
});

export { generatorRouter };
