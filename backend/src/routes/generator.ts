import { Prisma, GeneratorAccessMode, ModerationStatus } from '@prisma/client';
import type { GeneratorQueueState } from '@prisma/client';
import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

import { appConfig } from '../config';
import { getAdultKeywordLabels } from '../lib/adult-keywords';
import { extractImageMetadata } from '../lib/metadata';
import {
  analyzeImageModeration,
  normalizeModerationSummary,
  serializeModerationSummary,
  type ImageModerationSummary,
} from '../lib/nsfw-open-cv';
import { evaluateImageModeration } from '../lib/nsfw/moderation';
import { runImageModerationWorkflow } from '../lib/nsfw/workflow';
import { prisma } from '../lib/prisma';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { mapModelAsset, type HydratedModelAsset } from '../lib/mappers/model';
import { buildUniqueSlug } from '../lib/slug';
import { resolveStorageLocation, storageClient } from '../lib/storage';
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

const STREAM_SIZE_LIMIT_ERROR = 'StreamSizeLimitError';
const MAX_GENERATOR_IMPORT_BUFFER_SIZE = 32 * 1024 * 1024; // 32 MiB guardrail for metadata extraction

const streamToBuffer = async (stream: Readable, limit?: number): Promise<Buffer> =>
  new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;

    stream.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;

      if (limit && total > limit) {
        stream.destroy();
        const error = new Error('Stream exceeded allowed buffer limit.');
        error.name = STREAM_SIZE_LIMIT_ERROR;
        reject(error);
        return;
      }

      chunks.push(buffer);
    });

    stream.on('error', (error) => reject(error));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });

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

const MAX_GENERATOR_ERROR_REASON_LENGTH = 1000;

const normalizeGeneratorErrorReason = (value?: string | null): string | null => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.length > MAX_GENERATOR_ERROR_REASON_LENGTH) {
    return `${trimmed.slice(0, MAX_GENERATOR_ERROR_REASON_LENGTH - 1)}…`;
  }

  return trimmed;
};

const buildPublicGeneratorErrorReason = (reason: string | null, viewerRole?: string): string | null => {
  if (!reason) {
    return null;
  }

  if (viewerRole === 'ADMIN') {
    return reason;
  }

  return 'Generation failed. Contact an administrator for the diagnostic log.';
};

const generatorFailureStatuses = ['error', 'failed', 'cancelled'] as const;
const generatorFailureStatusList = [...generatorFailureStatuses];
const generatorFinalStatuses = ['cancelled'] as const;
const isFinalGeneratorStatus = (status: string) =>
  generatorFinalStatuses.includes(status as (typeof generatorFinalStatuses)[number]);

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

const computeQueueStats = async (where?: Prisma.GeneratorRequestWhereInput) => {
  const grouped = await prisma.generatorRequest.groupBy({
    by: ['status'],
    _count: { _all: true },
    ...(where ? { where } : {}),
  });

  const counts = grouped.reduce<Record<string, number>>((accumulator, entry) => {
    const total = typeof entry._count === 'object' && entry._count ? entry._count._all ?? 0 : 0;
    accumulator[entry.status] = total;
    return accumulator;
  }, {});

  const getCount = (...statuses: string[]) =>
    statuses.reduce((total, status) => total + (counts[status] ?? 0), 0);

  const total = grouped.reduce((sum, entry) => {
    const aggregate = typeof entry._count === 'object' && entry._count ? entry._count._all ?? 0 : 0;
    return sum + aggregate;
  }, 0);

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

const generatorActiveStatuses = new Set(['queued', 'running', 'uploading']);
const generatorQueueLockTtlMs = 30_000;

const releaseQueueLock = async (
  stateId: number,
  extra?: Prisma.GeneratorQueueStateUpdateInput,
) => {
  try {
    await prisma.generatorQueueState.update({
      where: { id: stateId },
      data: { lockedAt: null, ...(extra ?? {}) },
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.warn('Failed to release generator queue lock:', error);
    }
  }
};

function scheduleGeneratorQueueProcessing(delayMs = 0): void {
  setTimeout(() => {
    void processGeneratorQueue().catch((error) => {
      if (process.env.NODE_ENV === 'development') {
        // eslint-disable-next-line no-console
        console.warn('Failed to process generator queue:', error);
      }
    });
  }, delayMs);
}

const acquireQueueLock = async (stateId: number) => {
  const now = new Date();
  const expiry = new Date(now.getTime() - generatorQueueLockTtlMs);
  const result = await prisma.generatorQueueState.updateMany({
    where: {
      id: stateId,
      OR: [{ lockedAt: null }, { lockedAt: { lt: expiry } }],
    },
    data: { lockedAt: now },
  });

  return result.count > 0;
};

const processGeneratorQueue = async (): Promise<void> => {
  const state = await ensureQueueState();
  if (state.isPaused || state.declineNewRequests) {
    return;
  }

  const lockAcquired = await acquireQueueLock(state.id);
  if (!lockAcquired) {
    return;
  }

  let candidate: HydratedGeneratorRequest | null = null;

  try {
    await prisma.$transaction(async (tx) => {
      const queueState = await tx.generatorQueueState.findUnique({ where: { id: state.id } });
      if (!queueState || queueState.isPaused || queueState.declineNewRequests) {
        return;
      }

      if (queueState.activeRequestId) {
        const activeRequest = await tx.generatorRequest.findUnique({
          where: { id: queueState.activeRequestId },
          select: { id: true, status: true },
        });

        if (activeRequest && generatorActiveStatuses.has(activeRequest.status)) {
          candidate = null;
          return;
        }

        await tx.generatorQueueState.update({
          where: { id: queueState.id },
          data: { activeRequestId: null },
        });
      }

      const next = await tx.generatorRequest.findFirst({
        where: { status: 'pending' },
        orderBy: { createdAt: 'asc' },
        include: generatorRequestInclude,
      });

      if (!next) {
        candidate = null;
        return;
      }

      await tx.generatorQueueState.update({
        where: { id: queueState.id },
        data: { activeRequestId: next.id },
      });

      candidate = next as HydratedGeneratorRequest;
    });
  } catch (error) {
    await releaseQueueLock(state.id);
    throw error;
  }

  if (!candidate) {
    await releaseQueueLock(state.id);
    return;
  }

  const job = candidate as HydratedGeneratorRequest;

  const dispatchResult = await dispatchGeneratorRequest(job);

  if (dispatchResult.status === 'queued') {
    await prisma.generatorRequest.update({
      where: { id: job.id },
      data: { status: 'queued', errorReason: null },
    });

    await releaseQueueLock(state.id);
    return;
  }

  const isBusy = dispatchResult.status === 'busy';
  const message = dispatchResult.message ?? 'GPU agent rejected the request.';
  const sanitizedMessage = normalizeGeneratorErrorReason(message) ?? message;

  await prisma.$transaction(async (tx) => {
    await tx.generatorRequest.update({
      where: { id: job.id },
      data: isBusy ? { status: 'pending' } : { status: 'error', errorReason: sanitizedMessage },
    });

    await tx.generatorQueueState.update({
      where: { id: state.id },
      data: { activeRequestId: null, lockedAt: null },
    });
  });

  if (isBusy) {
    scheduleGeneratorQueueProcessing(2000);
    return;
  }

  scheduleGeneratorQueueProcessing();
};

const releaseActiveRequest = async (requestId: string) => {
  const result = await prisma.generatorQueueState.updateMany({
    where: { activeRequestId: requestId },
    data: { activeRequestId: null },
  });

  if (result.count > 0) {
    scheduleGeneratorQueueProcessing();
  }
};

type RedispatchSummary = {
  attempted: number;
  queued: number;
  busy: number;
  errors: Array<{ id: string; message: string }>;
};

const redispatchPendingRequests = async (): Promise<RedispatchSummary> => {
  const state = await ensureQueueState();
  if (state.isPaused || state.declineNewRequests) {
    return { attempted: 0, queued: 0, busy: 0, errors: [] };
  }

  const candidates = await prisma.generatorRequest.findMany({
    where: { status: { in: ['pending', 'held', 'error', 'failed'] } },
    select: { id: true, status: true },
    orderBy: { createdAt: 'asc' },
  });

  if (candidates.length === 0) {
    return { attempted: 0, queued: 0, busy: 0, errors: [] };
  }

  await prisma.$transaction(
    candidates.map((candidate) =>
      prisma.generatorRequest.update({
        where: { id: candidate.id },
        data: {
          status: 'pending',
          ...(candidate.status === 'error' || candidate.status === 'failed'
            ? { errorReason: null }
            : {}),
        },
      }),
    ),
  );

  const summary: RedispatchSummary = { attempted: candidates.length, queued: 0, busy: 0, errors: [] };

  try {
    await processGeneratorQueue();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to process generator queue.';
    const sanitizedMessage = normalizeGeneratorErrorReason(message) ?? message;
    summary.errors.push({ id: 'queue', message: sanitizedMessage });
    return summary;
  }

  const queuedCount = await prisma.generatorRequest.count({
    where: { id: { in: candidates.map((entry) => entry.id) }, status: 'queued' },
  });

  summary.queued = queuedCount;
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
  const [state, globalStats, viewerStats, viewerBlock] = await Promise.all([
    ensureQueueState(),
    computeQueueStats(),
    computeQueueStats({ userId: viewer.id }),
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
    stats: viewerStats,
    ...(viewer.role === 'ADMIN' ? { globalStats } : {}),
    activity: mapQueueActivitySnapshot(state),
    viewer: {
      isBlocked: Boolean(viewerBlock),
      reason: viewerBlock?.reason ?? null,
    },
    ...(blocks ? { blocks } : {}),
  };
};

const mapGeneratorRequest = (
  request: HydratedGeneratorRequest,
  options?: { viewerRole?: string | null; includeErrorDetails?: boolean },
) => {
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

  const viewerRole = options?.viewerRole ?? null;
  const includeErrorDetails = options?.includeErrorDetails ?? viewerRole === 'ADMIN';
  const normalizedError = normalizeGeneratorErrorReason(request.errorReason);
  const publicErrorReason = includeErrorDetails
    ? normalizedError
    : buildPublicGeneratorErrorReason(normalizedError, viewerRole ?? undefined);

  return {
    id: request.id,
    status: request.status,
    errorReason: publicErrorReason,
    ...(includeErrorDetails ? { errorDetail: normalizedError ?? null } : {}),
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    seed: request.seed,
    guidanceScale: request.guidanceScale,
    steps: request.steps,
    sampler: request.sampler,
    scheduler: request.scheduler,
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
        const proxiedUrl =
          artifact.bucket && artifact.objectKey
            ? `/api/generator/requests/${request.id}/artifacts/${artifact.id}`
            : null;
        return {
          id: artifact.id,
          bucket: artifact.bucket,
          objectKey: artifact.objectKey,
          storagePath: artifact.storagePath,
          url: proxiedUrl ?? location.url,
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
  isGpuEnabled: z.boolean(),
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

const samplingParameterSchema = z
  .string()
  .trim()
  .min(1, 'Sampling parameter is required.')
  .max(64)
  .transform((value) => value.toLowerCase());

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
  sampler: samplingParameterSchema.refine((value) => value.length > 0, {
    message: 'Sampler selection is required.',
  }),
  scheduler: samplingParameterSchema.refine((value) => value.length > 0, {
    message: 'Scheduler selection is required.',
  }),
});

const generatorAgentStateEnum = z.enum([
  'QUEUED',
  'PREPARING',
  'MATERIALIZING',
  'SUBMITTED',
  'RUNNING',
  'UPLOADING',
  'SUCCESS',
  'FAILED',
  'CANCELED',
]);

type GeneratorAgentState = z.infer<typeof generatorAgentStateEnum>;
type GeneratorCallbackStatus = 'queued' | 'running' | 'uploading' | 'completed' | 'error' | 'cancelled';

const generatorStatusCallbackSchema = z
  .object({
    jobId: z.string().trim().min(1).optional(),
    job_id: z.string().trim().min(1).optional(),
    status: z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.enum(['queued', 'running', 'uploading', 'error', 'completed', 'cancelled']))
      .optional(),
    state: z
      .string()
      .transform((value) => value.trim().toUpperCase())
      .pipe(generatorAgentStateEnum)
      .optional(),
    reason: z.string().optional(),
    message: z.string().optional(),
    heartbeat_seq: z.coerce.number().int().min(0).optional(),
    timestamp: z.string().optional(),
    progress: z.unknown().optional(),
    activity: z.unknown().optional(),
    activity_snapshot: z.unknown().optional(),
    activitySnapshot: z.unknown().optional(),
    extra: z.record(z.string(), z.unknown()).optional(),
  })
  .refine((value) => value.jobId || value.job_id, {
    message: 'jobId is required in callback payloads.',
    path: ['jobId'],
  })
  .refine((value) => value.status || value.state, {
    message: 'status or state must be supplied in callback payloads.',
    path: ['status'],
  })
  .passthrough();

const completionArtifactSchema = z.union([
  z.string().min(1),
  z
    .object({
      bucket: z.string().trim().min(1).optional(),
      objectKey: z.string().trim().min(1).optional(),
      object_key: z.string().trim().min(1).optional(),
      key: z.string().trim().min(1).optional(),
      storagePath: z.string().trim().min(1).optional(),
      storage_path: z.string().trim().min(1).optional(),
      s3: z
        .object({
          bucket: z.string().trim().min(1).optional(),
          key: z.string().trim().min(1).optional(),
          url: z.string().optional(),
        })
        .optional(),
    })
    .passthrough(),
]);

const generatorCompletionCallbackSchema = z
  .object({
    jobId: z.string().trim().min(1).optional(),
    job_id: z.string().trim().min(1).optional(),
    status: z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.literal('completed'))
      .optional(),
    state: z
      .string()
      .transform((value) => value.trim().toUpperCase())
      .pipe(z.literal('SUCCESS'))
      .optional(),
    artifacts: z.array(completionArtifactSchema).default([]),
  })
  .refine((value) => value.jobId || value.job_id, {
    message: 'jobId is required in callback payloads.',
    path: ['jobId'],
  })
  .refine((value) => value.status || value.state, {
    message: 'status or state must be supplied in callback payloads.',
    path: ['status'],
  })
  .passthrough();

const generatorFailureCallbackSchema = z
  .object({
    jobId: z.string().trim().min(1).optional(),
    job_id: z.string().trim().min(1).optional(),
    status: z
      .string()
      .transform((value) => value.trim().toLowerCase())
      .pipe(z.enum(['failed', 'error', 'cancelled']))
      .optional(),
    state: z
      .string()
      .transform((value) => value.trim().toUpperCase())
      .pipe(z.enum(['FAILED', 'CANCELED']))
      .optional(),
    reason: z.string().optional(),
    reason_code: z.string().optional(),
    message: z.string().optional(),
    activity: z.unknown().optional(),
    activity_snapshot: z.unknown().optional(),
    activitySnapshot: z.unknown().optional(),
    last_activity: z.unknown().optional(),
  })
  .refine((value) => value.jobId || value.job_id, {
    message: 'jobId is required in callback payloads.',
    path: ['jobId'],
  })
  .refine((value) => value.status || value.state, {
    message: 'status or state must be supplied in callback payloads.',
    path: ['status'],
  })
  .passthrough();

const generatorArtifactImportSchema = z
  .object({
    mode: z.enum(['existing', 'new']).default('existing'),
    galleryId: z.string().trim().min(1).optional(),
    galleryTitle: z.string().trim().min(1).max(200).optional(),
    galleryDescription: z
      .string()
      .trim()
      .max(1500)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    galleryVisibility: z.enum(['public', 'private']).optional(),
    title: z
      .string()
      .trim()
      .max(160)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    note: z
      .string()
      .trim()
      .max(600)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
  })
  .superRefine((value, ctx) => {
    if (value.mode === 'existing' && !value.galleryId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A collection ID is required when importing into an existing collection.',
        path: ['galleryId'],
      });
    }

    if (value.mode === 'new' && !value.galleryTitle) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Provide a title to create a new collection.',
        path: ['galleryTitle'],
      });
    }
  });

const mapAgentStateToStatus = (state: GeneratorAgentState): GeneratorCallbackStatus => {
  switch (state) {
    case 'QUEUED':
      return 'queued';
    case 'PREPARING':
    case 'MATERIALIZING':
    case 'SUBMITTED':
    case 'RUNNING':
      return 'running';
    case 'UPLOADING':
      return 'uploading';
    case 'SUCCESS':
      return 'completed';
    case 'FAILED':
      return 'error';
    case 'CANCELED':
      return 'cancelled';
    default:
      return 'running';
  }
};

const resolveCallbackStatus = (
  payload: z.infer<typeof generatorStatusCallbackSchema>,
): GeneratorCallbackStatus | null => {
  if (payload.status) {
    return payload.status;
  }

  if (payload.state) {
    return mapAgentStateToStatus(payload.state);
  }

  return null;
};

type CompletionCallbackPayload = z.infer<typeof generatorCompletionCallbackSchema>;
type CompletionArtifactPayload = CompletionCallbackPayload['artifacts'][number];

const sanitizeObjectKey = (value: string) => value.replace(/^\/+/, '');

const parseStoragePath = (value: string): { bucket: string | null; key: string | null } => {
  const normalized = value.trim();
  if (!normalized.toLowerCase().startsWith('s3://')) {
    return { bucket: null, key: null };
  }

  const withoutScheme = normalized.slice(5);
  const firstSlash = withoutScheme.indexOf('/');
  if (firstSlash < 0) {
    return { bucket: withoutScheme || null, key: null };
  }

  const bucket = withoutScheme.slice(0, firstSlash);
  const key = withoutScheme.slice(firstSlash + 1);
  return { bucket: bucket || null, key: key || null };
};

const resolveCompletionArtifact = (
  artifact: CompletionArtifactPayload,
  fallbackBucket: string,
): { bucket: string; key: string } | null => {
  if (typeof artifact === 'string') {
    const key = sanitizeObjectKey(artifact);
    return key ? { bucket: fallbackBucket, key } : null;
  }

  if (!artifact || typeof artifact !== 'object') {
    return null;
  }

  const candidateBucket =
    (typeof artifact.bucket === 'string' && artifact.bucket.trim().length > 0
      ? artifact.bucket.trim()
      : null) ?? undefined;

  const s3Payload =
    artifact.s3 && typeof artifact.s3 === 'object'
      ? {
          bucket:
            typeof artifact.s3.bucket === 'string' && artifact.s3.bucket.trim().length > 0
              ? artifact.s3.bucket.trim()
              : null,
          key:
            typeof artifact.s3.key === 'string' && artifact.s3.key.trim().length > 0
              ? sanitizeObjectKey(artifact.s3.key)
              : null,
        }
      : { bucket: null, key: null };

  if (s3Payload.key) {
    const bucket = s3Payload.bucket ?? candidateBucket ?? fallbackBucket;
    return { bucket, key: s3Payload.key };
  }

  const directKeyCandidates = [
    typeof artifact.objectKey === 'string' ? artifact.objectKey.trim() : null,
    typeof (artifact as { object_key?: string }).object_key === 'string'
      ? (artifact as { object_key?: string }).object_key!.trim()
      : null,
    typeof artifact.key === 'string' ? artifact.key.trim() : null,
  ].filter((value): value is string => Boolean(value && value.length > 0));

  if (directKeyCandidates.length > 0) {
    const [firstCandidate] = directKeyCandidates;
    if (firstCandidate) {
      const key = sanitizeObjectKey(firstCandidate);
      if (key) {
        const bucket = candidateBucket ?? fallbackBucket;
        return { bucket, key };
      }
    }
  }

  const storagePathValue =
    typeof artifact.storagePath === 'string'
      ? artifact.storagePath
      : typeof (artifact as { storage_path?: string }).storage_path === 'string'
        ? (artifact as { storage_path?: string }).storage_path!
        : null;

  if (storagePathValue) {
    const parsed = parseStoragePath(storagePathValue);
    if (parsed.key) {
      const bucket = parsed.bucket ?? candidateBucket ?? fallbackBucket;
      return { bucket, key: sanitizeObjectKey(parsed.key) };
    }
  }

  return null;
};

const resolveFailureStatus = (
  payload: z.infer<typeof generatorFailureCallbackSchema>,
): GeneratorCallbackStatus | null => {
  if (payload.status) {
    if (payload.status === 'cancelled') {
      return 'cancelled';
    }

    if (payload.status === 'failed' || payload.status === 'error') {
      return 'error';
    }
  }

  if (payload.state) {
    return mapAgentStateToStatus(payload.state);
  }

  return null;
};

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
        isGpuEnabled: settings.isGpuEnabled,
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
        isGpuEnabled: parsed.data.isGpuEnabled,
      } as unknown as Prisma.GeneratorSettingsUpdateInput,
    });

    res.json({
      settings: {
        id: updated.id,
        accessMode: updated.accessMode,
        baseModels: parseGeneratorBaseModels(extractSettingsBaseModels(updated)),
        isGpuEnabled: updated.isGpuEnabled,
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
    const clearing = await prisma.generatorRequest.findMany({
      where: { status: { in: statusesToClear } },
      select: { id: true },
    });

    const result = await prisma.generatorRequest.updateMany({
      where: { status: { in: statusesToClear } },
      data: { status: 'cancelled', errorReason: 'Cleared by administrator.' },
    });

    if (clearing.length > 0) {
      await Promise.all(clearing.map((entry) => releaseActiveRequest(entry.id)));
    }

    if (result.count > 0) {
      scheduleGeneratorQueueProcessing();
    }

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
        sampler: parsed.data.sampler,
        scheduler: parsed.data.scheduler,
        width: parsed.data.width,
        height: parsed.data.height,
        loraSelections: loraDetails,
        status: 'pending',
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
        await processGeneratorQueue();
      } catch (dispatchError) {
        // eslint-disable-next-line no-console
        console.error('Failed to enqueue generator request', dispatchError);
        await prisma.generatorRequest.update({
          where: { id: created.id },
          data: {
            status: 'error',
            errorReason: dispatchError instanceof Error ? dispatchError.message : 'Queue dispatch failed.',
          },
        });
      }
    }

    const refreshed = await prisma.generatorRequest.findUnique({
      where: { id: created.id },
      include: generatorRequestInclude,
    });

    res.status(201).json({
      request: mapGeneratorRequest(refreshed as HydratedGeneratorRequest, {
        viewerRole: req.user?.role ?? null,
      }),
    });
  } catch (error) {
    next(error);
  }
});

const cancellableStatuses = ['running', 'uploading'];

generatorRouter.post('/requests/:id/actions/cancel', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const requestId = req.params.id;
    if (!requestId) {
      res.status(400).json({ message: 'Generator request ID is required to cancel a job.' });
      return;
    }

    const existing = await prisma.generatorRequest.findUnique({
      where: { id: requestId },
      include: generatorRequestInclude,
    });

    if (!existing) {
      res.status(404).json({ message: 'Generator request not found for cancellation.' });
      return;
    }

    if (!cancellableStatuses.includes(existing.status)) {
      res.status(409).json({
        message: 'Generator request is not currently running.',
        request: mapGeneratorRequest(existing as HydratedGeneratorRequest, { includeErrorDetails: true }),
      });
      return;
    }

    const updated = await prisma.$transaction(async (tx) => {
      const current = await tx.generatorRequest.findUnique({
        where: { id: requestId },
        select: { status: true },
      });

      if (!current || !cancellableStatuses.includes(current.status)) {
        return null;
      }

      return tx.generatorRequest.update({
        where: { id: requestId },
        data: { status: 'cancelled', errorReason: 'Terminated by administrator.' },
        include: generatorRequestInclude,
      });
    });

    if (!updated) {
      const refreshed = await prisma.generatorRequest.findUnique({
        where: { id: requestId },
        include: generatorRequestInclude,
      });

      res.status(409).json({
        message: 'Generator request is not currently running.',
        ...(refreshed
          ? { request: mapGeneratorRequest(refreshed as HydratedGeneratorRequest, { includeErrorDetails: true }) }
          : {}),
      });
      return;
    }

    await releaseActiveRequest(requestId);

    res.json({
      request: mapGeneratorRequest(updated as HydratedGeneratorRequest, { includeErrorDetails: true }),
    });
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
    const callbackJobId = parsed.data.jobId ?? parsed.data.job_id ?? null;
    if (!jobId || callbackJobId !== jobId) {
      res.status(400).json({ message: 'Status callback job ID mismatch.' });
      return;
    }

    const activityPayload =
      parsed.data.activity_snapshot ??
      (Object.prototype.hasOwnProperty.call(parsed.data, 'activitySnapshot')
        ? (parsed.data as Record<string, unknown>).activitySnapshot
        : undefined) ??
      parsed.data.activity ??
      parsed.data.extra?.activity;
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

    const resolvedStatus = resolveCallbackStatus(parsed.data);
    if (!resolvedStatus) {
      res.status(400).json({ message: 'Unsupported generator status received.' });
      return;
    }

    const existing = await prisma.generatorRequest.findUnique({
      where: { id: jobId },
      include: generatorRequestInclude,
    });

    if (!existing) {
      res.status(404).json({ message: 'Generator request not found for status update.' });
      return;
    }

    if (isFinalGeneratorStatus(existing.status)) {
      await releaseActiveRequest(existing.id);
      res.json({
        request: mapGeneratorRequest(existing as HydratedGeneratorRequest, { includeErrorDetails: true }),
      });
      return;
    }

    const normalizedReason = normalizeGeneratorErrorReason(
      parsed.data.reason ?? (resolvedStatus === 'error' || resolvedStatus === 'cancelled' ? parsed.data.message : undefined),
    );
    let updateData: Prisma.GeneratorRequestUpdateInput;
    if (resolvedStatus === 'error') {
      updateData = { status: 'error', errorReason: normalizedReason };
    } else if (resolvedStatus === 'cancelled') {
      updateData = {
        status: 'cancelled',
        errorReason: normalizedReason ?? 'Job cancelled by GPU worker.',
      };
    } else if (resolvedStatus === 'completed') {
      updateData = { status: 'completed', errorReason: null };
    } else {
      updateData = { status: resolvedStatus, errorReason: null };
    }

    const updated = await prisma.generatorRequest.update({
      where: { id: jobId },
      data: updateData,
      include: generatorRequestInclude,
    });

    res.json({
      request: mapGeneratorRequest(updated as HydratedGeneratorRequest, { includeErrorDetails: true }),
    });
  } catch (error) {
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
    const callbackJobId = parsed.data.jobId ?? parsed.data.job_id ?? null;
    if (!jobId || callbackJobId !== jobId) {
      res.status(400).json({ message: 'Completion callback job ID mismatch.' });
      return;
    }

    if (!parsed.data.status && !parsed.data.state) {
      res.status(400).json({ message: 'Completion callback missing status.' });
      return;
    }

    const existing = await prisma.generatorRequest.findUnique({
      where: { id: jobId },
      include: generatorRequestInclude,
    });

    if (!existing) {
      res.status(404).json({ message: 'Generator request not found for completion callback.' });
      return;
    }

    if (isFinalGeneratorStatus(existing.status)) {
      await releaseActiveRequest(existing.id);
      res.json({
        request: mapGeneratorRequest(existing as HydratedGeneratorRequest, { includeErrorDetails: true }),
      });
      return;
    }

    const bucket = existing.outputBucket ?? appConfig.generator.output.bucket;
    const normalizedArtifacts = parsed.data.artifacts
      .map((artifact) => resolveCompletionArtifact(artifact, bucket))
      .filter((entry): entry is { bucket: string; key: string } => Boolean(entry));

    const uniqueArtifacts = Array.from(
      new Map(normalizedArtifacts.map((entry) => [`${entry.bucket}/${entry.key}`, entry])).values(),
    );

    await prisma.$transaction(async (tx) => {
      const current = await tx.generatorRequest.findUnique({
        where: { id: jobId },
        select: { status: true },
      });

      if (!current || isFinalGeneratorStatus(current.status)) {
        return;
      }

      await tx.generatorArtifact.deleteMany({ where: { requestId: jobId } });

      if (uniqueArtifacts.length > 0) {
        await tx.generatorArtifact.createMany({
          data: uniqueArtifacts.map((entry) => ({
            requestId: jobId,
            bucket: entry.bucket,
            objectKey: entry.key,
            storagePath: `s3://${entry.bucket}/${entry.key.replace(/^\/+/, '')}`,
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

    await releaseActiveRequest(jobId);

    res.json({
      request: mapGeneratorRequest(updated as HydratedGeneratorRequest, { includeErrorDetails: true }),
    });
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
    const callbackJobId = parsed.data.jobId ?? parsed.data.job_id ?? null;
    if (!jobId || callbackJobId !== jobId) {
      res.status(400).json({ message: 'Failure callback job ID mismatch.' });
      return;
    }

    const activityPayload =
      parsed.data.last_activity ??
      parsed.data.activity_snapshot ??
      (Object.prototype.hasOwnProperty.call(parsed.data, 'activitySnapshot')
        ? (parsed.data as Record<string, unknown>).activitySnapshot
        : undefined) ??
      parsed.data.activity ??
      (parsed.data as { extra?: { activity?: unknown } }).extra?.activity;
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

    const resolvedStatus = resolveFailureStatus(parsed.data);
    if (!resolvedStatus) {
      res.status(400).json({ message: 'Unsupported generator failure status received.' });
      return;
    }

    const existing = await prisma.generatorRequest.findUnique({
      where: { id: jobId },
      include: generatorRequestInclude,
    });

    if (!existing) {
      res.status(404).json({ message: 'Generator request not found for failure callback.' });
      return;
    }

    if (isFinalGeneratorStatus(existing.status)) {
      res.json({
        request: mapGeneratorRequest(existing as HydratedGeneratorRequest, { includeErrorDetails: true }),
      });
      return;
    }

    const reasonWithCode = (() => {
      const reason = parsed.data.reason ?? parsed.data.message ?? null;
      if (parsed.data.reason_code) {
        if (reason) {
          return `${reason} (${parsed.data.reason_code})`;
        }
        return parsed.data.reason_code;
      }
      return reason;
    })();
    const normalizedReason = normalizeGeneratorErrorReason(reasonWithCode);
    const failureStatus = resolvedStatus === 'cancelled' ? 'cancelled' : 'error';

    const updated = await prisma.generatorRequest.update({
      where: { id: jobId },
      data: { status: failureStatus, errorReason: normalizedReason },
      include: generatorRequestInclude,
    });

    await releaseActiveRequest(jobId);

    res.json({
      request: mapGeneratorRequest(updated as HydratedGeneratorRequest, { includeErrorDetails: true }),
    });
  } catch (error) {
    next(error);
  }
});

generatorRouter.get('/errors', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const parsedLimit = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 50;

    const where: Prisma.GeneratorRequestWhereInput = { status: { in: generatorFailureStatusList } };

    const [records, total] = await Promise.all([
      prisma.generatorRequest.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        take: limit,
        include: generatorRequestInclude,
      }),
      prisma.generatorRequest.count({ where }),
    ]);

    res.json({
      errors: records.map((record) =>
        mapGeneratorRequest(record as HydratedGeneratorRequest, { includeErrorDetails: true }),
      ),
      total,
      limit,
    });
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

    const where: Prisma.GeneratorRequestWhereInput = scope === 'all' ? {} : { userId: req.user!.id };

    const rawStatusFilter = req.query.status;
    const normalizeStatuses = (input: unknown): string[] => {
      if (!input) {
        return [];
      }

      if (typeof input === 'string') {
        return input
          .split(',')
          .map((value) => value.trim())
          .filter((value): value is string => value.length > 0)
          .slice(0, 50);
      }

      if (Array.isArray(input)) {
        return input
          .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : []))
          .map((value) => value.trim())
          .filter((value): value is string => value.length > 0)
          .slice(0, 50);
      }

      return [];
    };

    const statusFilters = normalizeStatuses(rawStatusFilter);
    if (statusFilters.length > 0) {
      where.status = { in: statusFilters };
    }

    const requests = await prisma.generatorRequest.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      include: generatorRequestInclude,
    });

    res.json({
      requests: requests.map((request) =>
        mapGeneratorRequest(request as HydratedGeneratorRequest, { viewerRole: req.user?.role ?? null }),
      ),
    });
  } catch (error) {
    next(error);
  }
});

generatorRouter.post('/requests/:id/artifacts/:artifactId/import', requireAuth, async (req, res, next) => {
  try {
    const requestId = req.params.id?.trim();
    const artifactId = req.params.artifactId?.trim();

    if (!requestId || !artifactId) {
      res.status(404).json({ message: 'Generator artifact not found.' });
      return;
    }

    const parsed = generatorArtifactImportSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid import payload.', errors: parsed.error.flatten() });
      return;
    }

    const payload = parsed.data;
    const viewer = req.user;
    if (!viewer) {
      res.status(401).json({ message: 'Authentication is required to import generator artifacts.' });
      return;
    }

    const artifact = await prisma.generatorArtifact.findFirst({
      where: { id: artifactId, requestId },
      include: {
        request: {
          include: {
            user: { select: { id: true, displayName: true, role: true } },
            baseModel: { include: { tags: { include: { tag: true } } } },
          },
        },
      },
    });

    if (!artifact) {
      res.status(404).json({ message: 'Generator artifact not found.' });
      return;
    }

    const isAdmin = viewer.role === 'ADMIN';
    if (!isAdmin && artifact.request.userId !== viewer.id) {
      res.status(403).json({ message: 'You are not allowed to import this generator artifact.' });
      return;
    }

    const bucket = artifact.bucket?.trim();
    const objectKey = artifact.objectKey?.trim();
    const storagePath = artifact.storagePath?.trim();

    if (!bucket || !objectKey || !storagePath) {
      res.status(404).json({ message: 'Generator artifact storage location missing.' });
      return;
    }

    const existingImage = await prisma.imageAsset.findUnique({ where: { storagePath } });
    if (existingImage) {
      res.status(409).json({ message: 'This artifact has already been imported as an image.' });
      return;
    }

    const normalizeText = (value?: string | null) => {
      if (!value) {
        return null;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const normalizeSeed = (value?: string | null) => {
      if (value == null) {
        return null;
      }
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    };

    const normalizeDimension = (value?: number | null) =>
      typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null;

    const normalizeNumber = (value?: number | null) =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;

    const normalizeInteger = (value?: number | null) =>
      typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;

    let galleryRecord: {
      id: string;
      slug: string;
      title: string;
      description: string | null;
      isPublic: boolean;
      ownerId: string;
      coverImage: string | null;
    } | null = null;

    if (payload.mode === 'existing') {
      const existingGallery = await prisma.gallery.findUnique({
        where: { id: payload.galleryId! },
        select: {
          id: true,
          slug: true,
          title: true,
          description: true,
          isPublic: true,
          ownerId: true,
          coverImage: true,
        },
      });

      if (!existingGallery) {
        res.status(404).json({ message: 'The selected collection could not be found.' });
        return;
      }

      if (!isAdmin && existingGallery.ownerId !== viewer.id) {
        res.status(403).json({ message: 'You are not allowed to import into this collection.' });
        return;
      }

      galleryRecord = existingGallery;
    }

    let stat;
    try {
      stat = await storageClient.statObject(bucket, objectKey);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === 'NoSuchKey' || code === 'NotFound') {
        res.status(404).json({ message: 'Generator artifact was not found in storage.' });
        return;
      }
      throw error;
    }

    const reportedSize = Number(stat.size);
    const statSize = Number.isFinite(reportedSize) && reportedSize >= 0 ? reportedSize : null;
    const shouldFetchBuffer = !statSize || statSize <= MAX_GENERATOR_IMPORT_BUFFER_SIZE;

    let objectBuffer: Buffer | null = null;

    if (shouldFetchBuffer) {
      let objectStream: Readable | null = null;
      try {
        objectStream = await storageClient.getObject(bucket, objectKey);
      } catch (error) {
        const code = (error as Error & { code?: string }).code;
        if (code === 'NoSuchKey' || code === 'NotFound') {
          res.status(404).json({ message: 'Generator artifact was not found in storage.' });
          return;
        }
        throw error;
      }

      try {
        objectBuffer = await streamToBuffer(objectStream as Readable, MAX_GENERATOR_IMPORT_BUFFER_SIZE);
      } catch (error) {
        if ((error as Error).name !== STREAM_SIZE_LIMIT_ERROR) {
          throw error;
        }
        // The reported size was smaller than the limit; fall back to metadata-free import.
        objectBuffer = null;
      } finally {
        objectStream?.destroy();
      }
    }

    const contentType =
      stat.metaData?.['content-type'] ??
      stat.metaData?.['Content-Type'] ??
      stat.metaData?.['Content-type'] ??
      'image/png';

    type ImageMetadataResult = Awaited<ReturnType<typeof extractImageMetadata>>;
    let imageMetadata: ImageMetadataResult | null = null;
    let moderationSummary: ImageModerationSummary | null = null;

    if (objectBuffer) {
      try {
        imageMetadata = await extractImageMetadata({
          buffer: objectBuffer,
          mimetype: contentType,
          originalname: objectKey.split('/').pop() ?? objectKey,
        });
      } catch (error) {
        console.warn('Failed to parse generator artifact metadata.', error);
      }

      try {
        moderationSummary = await analyzeImageModeration(objectBuffer);
      } catch (error) {
        console.warn('Failed to analyze generator artifact for moderation heuristics.', error);
        moderationSummary = null;
      }
    }

    const requestRecord = artifact.request;
    const promptValue = normalizeText(requestRecord.prompt ?? imageMetadata?.prompt ?? null);
    const negativePromptValue = normalizeText(
      requestRecord.negativePrompt ?? imageMetadata?.negativePrompt ?? null,
    );
    const seedValue = normalizeSeed(imageMetadata?.seed ?? requestRecord.seed ?? null);
    const cfgScaleValue = normalizeNumber(imageMetadata?.cfgScale ?? requestRecord.guidanceScale ?? null);
    const stepsValue = normalizeInteger(imageMetadata?.steps ?? requestRecord.steps ?? null);
    const samplerValue = normalizeText(imageMetadata?.sampler ?? null);
    const modelValue = normalizeText(imageMetadata?.model ?? requestRecord.baseModel?.title ?? null);
    const widthValue = normalizeDimension(imageMetadata?.width ?? requestRecord.width ?? null);
    const heightValue = normalizeDimension(imageMetadata?.height ?? requestRecord.height ?? null);
    const fileSize = statSize ?? objectBuffer?.length ?? null;

    const fallbackLabel = objectKey.split('/').pop() ?? 'generator-artifact';
    const titleCandidate = payload.title ?? promptValue ?? fallbackLabel;
    const normalizedTitle = titleCandidate.length > 160 ? `${titleCandidate.slice(0, 159)}…` : titleCandidate;
    const finalTitle = normalizedTitle.length > 0 ? normalizedTitle : fallbackLabel;

    const adultKeywords = await getAdultKeywordLabels();
    const loraSelections = Array.isArray(requestRecord.loraSelections)
      ? (requestRecord.loraSelections as Array<{ id: string; title?: string | null }>)
      : [];
    const additionalTexts = loraSelections
      .map((entry) => normalizeText(entry.title) ?? normalizeText(entry.id) ?? null)
      .filter((entry): entry is string => Boolean(entry));
    const metadataList: Prisma.JsonValue[] = imageMetadata?.extras
      ? [(imageMetadata.extras as unknown) as Prisma.JsonValue]
      : [];

    let workflow: Awaited<ReturnType<typeof runImageModerationWorkflow>> | null = null;
    if (objectBuffer) {
      workflow = await runImageModerationWorkflow({
        buffer: objectBuffer,
        adultKeywords,
        existingSummary: moderationSummary,
        context: {
          title: finalTitle,
          description: null,
          prompt: promptValue,
          negativePrompt: negativePromptValue,
          model: modelValue,
          sampler: samplerValue,
          metadata: null,
          metadataList,
          tags: [],
          additionalTexts,
        },
      });
    }

    const moderation =
      workflow?.summary ??
      moderationSummary ??
      (imageMetadata?.extras
        ? normalizeModerationSummary((imageMetadata.extras as unknown) as Prisma.JsonValue)
        : null);
    const serializedModeration =
      workflow?.serializedSummary ?? (moderation ? serializeModerationSummary(moderation) : null);

    const decision = workflow?.decision ??
      evaluateImageModeration({
        title: finalTitle,
        description: null,
        prompt: promptValue,
        negativePrompt: negativePromptValue,
        model: modelValue,
        sampler: samplerValue,
        metadata: null,
        metadataList,
        tags: [],
        adultKeywords,
        analysis: workflow?.analysis ?? null,
        moderation,
        additionalTexts,
      });

    const isAdult = decision.isAdult;
    const requiresModeration = decision.requiresModeration;

    const galleryDescription = payload.galleryDescription ?? null;
    const galleryVisibility = payload.galleryVisibility === 'public' ? 'public' : 'private';
    const noteValue = payload.note ?? null;
    const ownerId = artifact.request.userId;

    let newGalleryPlan: {
      slug: string;
      title: string;
      description: string | null;
      isPublic: boolean;
    } | null = null;

    if (!galleryRecord && payload.mode === 'new') {
      const slug = await buildUniqueSlug(
        payload.galleryTitle!,
        (candidate) =>
          prisma.gallery.findUnique({ where: { slug: candidate } }).then((existing) => Boolean(existing)),
        'gallery',
      );

      newGalleryPlan = {
        slug,
        title: payload.galleryTitle!,
        description: galleryDescription,
        isPublic: galleryVisibility === 'public',
      };
    }

    const importResult = await prisma.$transaction(async (tx) => {
      let activeGallery = galleryRecord;
      let wasCreated = false;

      if (!activeGallery) {
        const created = await tx.gallery.create({
          data: {
            slug: newGalleryPlan!.slug,
            title: newGalleryPlan!.title,
            description: newGalleryPlan!.description,
            isPublic: newGalleryPlan!.isPublic,
            ownerId,
            coverImage: null,
          },
        });
        activeGallery = created;
        wasCreated = true;
      }

      const lastEntry = await tx.galleryEntry.findFirst({
        where: { galleryId: activeGallery.id },
        orderBy: { position: 'desc' },
      });

      const imageData: Prisma.ImageAssetCreateInput = {
        title: finalTitle,
        description: null,
        width: widthValue,
        height: heightValue,
        ...(fileSize != null ? { fileSize } : {}),
        storagePath,
        prompt: promptValue,
        negativePrompt: negativePromptValue,
        seed: seedValue,
        model: modelValue,
        sampler: samplerValue,
        cfgScale: cfgScaleValue,
        steps: stepsValue,
        isPublic: requiresModeration ? false : activeGallery.isPublic,
        isAdult,
        owner: { connect: { id: ownerId } },
      };

      if (serializedModeration !== null) {
        imageData.moderationSummary = serializedModeration;
      }

      if (requiresModeration) {
        imageData.moderationStatus = ModerationStatus.FLAGGED;
        imageData.flaggedAt = new Date();
      }

      const image = await tx.imageAsset.create({
        data: imageData,
      });

      await tx.galleryEntry.create({
        data: {
          galleryId: activeGallery.id,
          imageId: image.id,
          position: (lastEntry?.position ?? 0) + 1,
          note: noteValue ?? null,
        },
      });

      if (!activeGallery.coverImage) {
        await tx.gallery.update({
          where: { id: activeGallery.id },
          data: { coverImage: storagePath },
        });
      }

      const gallerySummary = await tx.gallery.findUnique({
        where: { id: activeGallery.id },
        select: { id: true, slug: true, title: true, isPublic: true },
      });

      if (!gallerySummary) {
        throw new Error('GalleryNotFoundAfterImport');
      }

      return { image, gallery: gallerySummary, wasCreated };
    });

    res.status(201).json({
      image: {
        id: importResult.image.id,
        title: importResult.image.title,
        storagePath: importResult.image.storagePath,
      },
      gallery: {
        id: importResult.gallery.id,
        slug: importResult.gallery.slug,
        title: importResult.gallery.title,
        isPublic: importResult.gallery.isPublic,
        wasCreated: importResult.wasCreated,
      },
    });
  } catch (error) {
    next(error);
  }
});

const encodeFilename = (value: string) => `"${value.replace(/"/g, '\"')}"`;
const encodeFilenameStar = (value: string) => `UTF-8''${encodeURIComponent(value)}`;

const streamGeneratorArtifact = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const requestId = req.params.id?.trim();
    const artifactId = req.params.artifactId?.trim();

    if (!requestId || !artifactId) {
      res.status(404).json({ message: 'Generator artifact not found.' });
      return;
    }

    const artifact = await prisma.generatorArtifact.findFirst({
      where: { id: artifactId, requestId },
      include: { request: { select: { id: true, userId: true } } },
    });

    if (!artifact || artifact.request.id !== requestId) {
      res.status(404).json({ message: 'Generator artifact not found.' });
      return;
    }

    const viewer = req.user;
    if (!viewer) {
      res.status(401).json({ message: 'Authentication is required to view generator artifacts.' });
      return;
    }

    if (viewer.role !== 'ADMIN' && viewer.id !== artifact.request.userId) {
      res.status(403).json({ message: 'You are not allowed to view this generator artifact.' });
      return;
    }

    const bucket = artifact.bucket?.trim();
    const objectKey = artifact.objectKey?.trim();

    if (!bucket || !objectKey) {
      res.status(404).json({ message: 'Generator artifact storage location missing.' });
      return;
    }

    let stat;
    try {
      stat = await storageClient.statObject(bucket, objectKey);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === 'NoSuchKey' || code === 'NotFound') {
        res.status(404).json({ message: 'Generator artifact was not found in storage.' });
        return;
      }
      throw error;
    }

    const isHeadRequest = req.method === 'HEAD';
    let objectStream = null;
    if (!isHeadRequest) {
      try {
        objectStream = await storageClient.getObject(bucket, objectKey);
      } catch (error) {
        const code = (error as Error & { code?: string }).code;
        if (code === 'NoSuchKey' || code === 'NotFound') {
          res.status(404).json({ message: 'Generator artifact was not found in storage.' });
          return;
        }
        throw error;
      }
    }

    const contentType =
      stat.metaData?.['content-type'] ??
      stat.metaData?.['Content-Type'] ??
      stat.metaData?.['Content-type'] ??
      'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size.toString());
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    if (stat.lastModified) {
      res.setHeader('Last-Modified', stat.lastModified.toUTCString());
    }

    if (stat.etag) {
      res.setHeader('ETag', stat.etag.startsWith('"') ? stat.etag : `"${stat.etag}"`);
    }

    const fileName = objectKey.split('/').pop();
    if (fileName) {
      res.setHeader(
        'Content-Disposition',
        `inline; filename=${encodeFilename(fileName)}; filename*=${encodeFilenameStar(fileName)}`,
      );
    }

    if (!objectStream) {
      res.status(200).end();
      return;
    }

    objectStream.on('error', next);

    await pipeline(objectStream, res);
  } catch (error) {
    next(error);
  }
};

generatorRouter.get('/requests/:id/artifacts/:artifactId', requireAuth, streamGeneratorArtifact);
generatorRouter.head('/requests/:id/artifacts/:artifactId', requireAuth, streamGeneratorArtifact);

export { generatorRouter };
