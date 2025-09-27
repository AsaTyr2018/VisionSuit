import { Prisma, ModerationStatus } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { determineAdultForImage, determineAdultForModel } from '../lib/adult-content';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { prisma } from '../lib/prisma';
import { getAdultKeywordLabels, listAdultSafetyKeywords } from '../lib/adult-keywords';
import { appConfig } from '../config';
import { evaluateImageModeration, evaluateModelModeration } from '../lib/nsfw/moderation';
import { runNsfwImageAnalysis } from '../lib/nsfw/service';
import { resolveStorageLocation, storageClient } from '../lib/storage';
import type { MetadataEvaluationResult } from '../lib/nsfw/metadata';
export const safetyRouter = Router();

safetyRouter.use(requireAuth, requireAdmin);

const createKeywordSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'Keyword label cannot be empty.')
    .max(120, 'Keyword label must be 120 characters or fewer.'),
});

const ADULT_RECALC_BATCH_SIZE = 100;

type MetadataScoreSummary = {
  adult: number;
  minor: number;
  beast: number;
};

type MetadataPreviewMatch = {
  id: string;
  title: string;
  score: number;
};

type NsfwRescanStats = {
  scanned: number;
  adultMarked: number;
  adultCleared: number;
  flagged: number;
  unflagged: number;
  errors: number;
};

type ImageRescanStats = NsfwRescanStats & {
  analysisFailed: number;
};

const createRescanStats = (): NsfwRescanStats => ({
  scanned: 0,
  adultMarked: 0,
  adultCleared: 0,
  flagged: 0,
  unflagged: 0,
  errors: 0,
});

const createImageRescanStats = (): ImageRescanStats => ({
  ...createRescanStats(),
  analysisFailed: 0,
});

const mergeMetadataWithScreening = (
  metadata: Prisma.JsonValue | null,
  screening: MetadataEvaluationResult | null,
): Prisma.JsonValue | null => {
  if (!screening) {
    return metadata;
  }

  const serializedScreening = JSON.parse(JSON.stringify(screening)) as Prisma.JsonValue;

  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    const payload: Prisma.JsonObject = { nsfwMetadata: serializedScreening };
    return payload;
  }

  const payload: Prisma.JsonObject = { ...(metadata as Prisma.JsonObject) };
  payload.nsfwMetadata = serializedScreening;
  return payload;
};

const readObjectToBuffer = async (bucket: string, objectName: string) => {
  const stream = await storageClient.getObject(bucket, objectName);

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    stream.on('error', (error) => {
      reject(error);
    });
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
};

const toNonNegativeInteger = (value: unknown): number => {
  const numeric =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(value)
        : Number.NaN;

  if (!Number.isFinite(numeric)) {
    return 0;
  }

  return Math.max(0, Math.round(numeric));
};

const extractMetadataScores = (metadata: Prisma.JsonValue | null): MetadataScoreSummary | null => {
  if (!metadata || typeof metadata !== 'object') {
    return null;
  }

  const payload = metadata as Record<string, unknown>;
  const nsfw = payload.nsfw;
  if (!nsfw || typeof nsfw !== 'object') {
    return null;
  }

  const scores = (nsfw as Record<string, unknown>).scores;
  if (!scores || typeof scores !== 'object') {
    return null;
  }

  const scoreRecord = scores as Record<string, unknown>;

  const adult = toNonNegativeInteger(scoreRecord.adult);
  const minor = toNonNegativeInteger(scoreRecord.minor);
  const beast = toNonNegativeInteger(scoreRecord.beast);

  return { adult, minor, beast };
};

safetyRouter.get('/metadata/preview', async (_req, res, next) => {
  try {
    const thresholds = appConfig.nsfw.metadataFilters.thresholds;

    const models = await prisma.modelAsset.findMany({
      orderBy: { title: 'asc' },
      select: {
        id: true,
        title: true,
        versions: {
          select: {
            metadata: true,
          },
        },
      },
    });

    let evaluatedModelCount = 0;

    const adultMatches: MetadataPreviewMatch[] = [];
    const minorMatches: MetadataPreviewMatch[] = [];
    const beastMatches: MetadataPreviewMatch[] = [];

    for (const model of models) {
      let hasScoredMetadata = false;
      let maxAdultScore = 0;
      let maxMinorScore = 0;
      let maxBeastScore = 0;

      for (const version of model.versions) {
        const scores = extractMetadataScores(version.metadata ?? null);
        if (!scores) {
          continue;
        }

        hasScoredMetadata = true;
        maxAdultScore = Math.max(maxAdultScore, scores.adult);
        maxMinorScore = Math.max(maxMinorScore, scores.minor);
        maxBeastScore = Math.max(maxBeastScore, scores.beast);
      }

      if (!hasScoredMetadata) {
        continue;
      }

      evaluatedModelCount += 1;

      if (thresholds.adult > 0 && maxAdultScore >= thresholds.adult) {
        adultMatches.push({ id: model.id, title: model.title, score: maxAdultScore });
      }

      if (thresholds.minor > 0 && maxMinorScore >= thresholds.minor) {
        minorMatches.push({ id: model.id, title: model.title, score: maxMinorScore });
      }

      if (thresholds.beast > 0 && maxBeastScore >= thresholds.beast) {
        beastMatches.push({ id: model.id, title: model.title, score: maxBeastScore });
      }
    }

    const sortMatches = (entries: MetadataPreviewMatch[]) =>
      [...entries].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

    const buildCategory = (config: {
      threshold: number;
      matches: MetadataPreviewMatch[];
    }) => ({
      threshold: config.threshold,
      isEnabled: config.threshold > 0,
      matchingModelCount: config.threshold > 0 ? config.matches.length : 0,
      sample: config.threshold > 0 ? sortMatches(config.matches).slice(0, 5) : [],
    });

    res.json({
      preview: {
        generatedAt: new Date().toISOString(),
        totalModelCount: models.length,
        evaluatedModelCount,
        categories: {
          adult: buildCategory({ threshold: thresholds.adult, matches: adultMatches }),
          minor: buildCategory({ threshold: thresholds.minor, matches: minorMatches }),
          beast: buildCategory({ threshold: thresholds.beast, matches: beastMatches }),
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

type ModelAdultEvaluationTarget = {
  id: string;
  title: string;
  description: string | null;
  trigger: string | null;
  metadata: Prisma.JsonValue | null;
  moderationSummary: Prisma.JsonValue | null;
  isAdult: boolean;
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
  versions: Array<{ metadata: Prisma.JsonValue | null }>;
};

type ImageAdultEvaluationTarget = {
  id: string;
  title: string;
  description: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  model: string | null;
  sampler: string | null;
  seed: string | null;
  cfgScale: number | null;
  steps: number | null;
  isAdult: boolean;
  moderationSummary: Prisma.JsonValue | null;
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
};

type ModelRescanRecord = {
  id: string;
  title: string;
  description: string | null;
  trigger: string | null;
  metadata: Prisma.JsonValue | null;
  isAdult: boolean;
  isPublic: boolean;
  moderationStatus: ModerationStatus;
  flaggedById: string | null;
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
  versions: Array<{ metadata: Prisma.JsonValue | null }>;
};

type ImageRescanRecord = {
  id: string;
  title: string;
  description: string | null;
  prompt: string | null;
  negativePrompt: string | null;
  model: string | null;
  sampler: string | null;
  seed: string | null;
  cfgScale: number | null;
  steps: number | null;
  storagePath: string;
  isAdult: boolean;
  isPublic: boolean;
  moderationStatus: ModerationStatus;
  flaggedById: string | null;
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
};

const recalculateAdultFlagsForModels = async (adultKeywords: string[]) => {
  let cursorId: string | null = null;

  while (true) {
    const modelRecords = await prisma.modelAsset.findMany({
      orderBy: { id: 'asc' },
      take: ADULT_RECALC_BATCH_SIZE,
      ...(cursorId
        ? {
            cursor: { id: cursorId },
            skip: 1,
          }
        : {}),
      include: {
        tags: { include: { tag: true } },
        versions: { select: { metadata: true } },
      },
    });

    const models = modelRecords as unknown as ModelAdultEvaluationTarget[];

    if (models.length === 0) {
      break;
    }

    const updates = models
      .map((model) => {
        const versionMetadataList = model.versions
          .map((entry) => entry.metadata ?? null)
          .filter((entry): entry is Prisma.JsonValue => entry != null);
        const moderationSummaries = collectModerationSummaries([
          model.moderationSummary ?? null,
          model.metadata ?? null,
          ...versionMetadataList,
        ]);

        const nextIsAdult = determineAdultForModel({
          title: model.title,
          description: model.description,
          trigger: model.trigger,
          metadata: model.metadata ?? null,
          metadataList: versionMetadataList,
          tags: model.tags,
          adultKeywords,
          moderationSummaries,
        });

        if (model.isAdult === nextIsAdult) {
          return null;
        }

        return { id: model.id, isAdult: nextIsAdult };
      })
      .filter((entry): entry is { id: string; isAdult: boolean } => entry !== null);

    if (updates.length > 0) {
      await prisma.$transaction(
        updates.map((update) =>
          prisma.modelAsset.update({
            where: { id: update.id },
            data: { isAdult: update.isAdult },
          }),
        ),
      );
    }

    const nextCursor = models[models.length - 1]?.id ?? null;
    if (!nextCursor) {
      break;
    }

    cursorId = nextCursor;
  }
};

const recalculateAdultFlagsForImages = async (adultKeywords: string[]) => {
  let cursorId: string | null = null;

  while (true) {
    const imageRecords = await prisma.imageAsset.findMany({
      orderBy: { id: 'asc' },
      take: ADULT_RECALC_BATCH_SIZE,
      ...(cursorId
        ? {
            cursor: { id: cursorId },
            skip: 1,
          }
        : {}),
      include: {
        tags: { include: { tag: true } },
      },
    });

    const images = imageRecords as unknown as ImageAdultEvaluationTarget[];

    if (images.length === 0) {
      break;
    }

    const updates = images
      .map((image) => {
        const metadataPayload: Prisma.JsonObject = {};
        if (image.seed) {
          metadataPayload.seed = image.seed;
        }
        if (image.cfgScale != null) {
          metadataPayload.cfgScale = image.cfgScale;
        }
        if (image.steps != null) {
          metadataPayload.steps = image.steps;
        }

        const metadata = Object.keys(metadataPayload).length > 0 ? metadataPayload : null;

        const moderationSummary = normalizeModerationSummary(image.moderationSummary);

        const nextIsAdult = determineAdultForImage({
          title: image.title,
          description: image.description,
          prompt: image.prompt,
          negativePrompt: image.negativePrompt,
          model: image.model,
          sampler: image.sampler,
          metadata,
          tags: image.tags,
          adultKeywords,
          moderation: moderationSummary,
        });

        if (image.isAdult === nextIsAdult) {
          return null;
        }

        return { id: image.id, isAdult: nextIsAdult };
      })
      .filter((entry): entry is { id: string; isAdult: boolean } => entry !== null);

    if (updates.length > 0) {
      await prisma.$transaction(
        updates.map((update) =>
          prisma.imageAsset.update({
            where: { id: update.id },
            data: { isAdult: update.isAdult },
          }),
        ),
      );
    }

    const nextCursor = images[images.length - 1]?.id ?? null;
    if (!nextCursor) {
      break;
    }

    cursorId = nextCursor;
  }
};

const recalculateAdultFlagsForAllAssets = async () => {
  const adultKeywords = await getAdultKeywordLabels();

  await recalculateAdultFlagsForModels(adultKeywords);
  await recalculateAdultFlagsForImages(adultKeywords);
};

const rescanModelsForNsfw = async (adultKeywords: string[], limit?: number) => {
  const stats = createRescanStats();
  let cursorId: string | null = null;

  while (true) {
    if (limit && stats.scanned >= limit) {
      break;
    }

    const remaining = limit ? Math.max(0, limit - stats.scanned) : ADULT_RECALC_BATCH_SIZE;
    const take = limit ? Math.min(ADULT_RECALC_BATCH_SIZE, remaining) : ADULT_RECALC_BATCH_SIZE;

    if (take <= 0) {
      break;
    }

    const models: ModelRescanRecord[] = await prisma.modelAsset.findMany({
      orderBy: { id: 'asc' },
      take,
      ...(cursorId
        ? {
            cursor: { id: cursorId },
            skip: 1,
          }
        : {}),
      select: {
        id: true,
        title: true,
        description: true,
        trigger: true,
        metadata: true,
        isAdult: true,
        isPublic: true,
        moderationStatus: true,
        flaggedById: true,
        tags: { include: { tag: true } },
        versions: { select: { metadata: true } },
      },
    });

    if (models.length === 0) {
      break;
    }

    for (const model of models) {
      if (limit && stats.scanned >= limit) {
        break;
      }

      stats.scanned += 1;

      try {
        const metadata = model.metadata ?? null;
        const metadataList = model.versions
          .map((entry) => entry.metadata ?? null)
          .filter((entry): entry is Prisma.JsonValue => entry != null);

        const decision = evaluateModelModeration({
          title: model.title,
          description: model.description,
          trigger: model.trigger,
          metadata,
          metadataList,
          tags: model.tags,
          adultKeywords,
        });

        const updatePayload: Prisma.ModelAssetUpdateInput = {};
        const mergedMetadata = mergeMetadataWithScreening(metadata, decision.metadataScreening);
        if (mergedMetadata !== metadata) {
          updatePayload.metadata =
            mergedMetadata === null
              ? Prisma.JsonNull
              : (mergedMetadata as Prisma.InputJsonValue);
        }

        if (model.isAdult !== decision.isAdult) {
          updatePayload.isAdult = decision.isAdult;
          if (decision.isAdult) {
            stats.adultMarked += 1;
          } else {
            stats.adultCleared += 1;
          }
        }

        if (decision.requiresModeration) {
          if (model.moderationStatus !== ModerationStatus.FLAGGED) {
            updatePayload.moderationStatus = ModerationStatus.FLAGGED;
            updatePayload.flaggedAt = new Date();
            updatePayload.flaggedBy = { disconnect: true };
            stats.flagged += 1;
          }
          if (model.isPublic) {
            updatePayload.isPublic = false;
          }
        } else if (
          model.moderationStatus === ModerationStatus.FLAGGED &&
          model.flaggedById == null
        ) {
          updatePayload.moderationStatus = ModerationStatus.ACTIVE;
          updatePayload.flaggedAt = null;
          updatePayload.flaggedBy = { disconnect: true };
          stats.unflagged += 1;
        }

        if (Object.keys(updatePayload).length > 0) {
          await prisma.modelAsset.update({
            where: { id: model.id },
            data: updatePayload,
          });
        }
      } catch (error) {
        console.error('Failed to rescan model for NSFW signals', error);
        stats.errors += 1;
      }
    }

    const nextCursor: string | null = models[models.length - 1]?.id ?? null;
    if (!nextCursor) {
      break;
    }

    cursorId = nextCursor;
  }

  return stats;
};

const rescanImagesForNsfw = async (adultKeywords: string[], limit?: number) => {
  const stats = createImageRescanStats();
  let cursorId: string | null = null;

  while (true) {
    if (limit && stats.scanned >= limit) {
      break;
    }

    const remaining = limit ? Math.max(0, limit - stats.scanned) : ADULT_RECALC_BATCH_SIZE;
    const take = limit ? Math.min(ADULT_RECALC_BATCH_SIZE, remaining) : ADULT_RECALC_BATCH_SIZE;

    if (take <= 0) {
      break;
    }

    const images: ImageRescanRecord[] = await prisma.imageAsset.findMany({
      orderBy: { id: 'asc' },
      take,
      ...(cursorId
        ? {
            cursor: { id: cursorId },
            skip: 1,
          }
        : {}),
      select: {
        id: true,
        title: true,
        description: true,
        prompt: true,
        negativePrompt: true,
        model: true,
        sampler: true,
        seed: true,
        cfgScale: true,
        steps: true,
        storagePath: true,
        isAdult: true,
        isPublic: true,
        moderationStatus: true,
        flaggedById: true,
        tags: { include: { tag: true } },
      },
    });

    if (images.length === 0) {
      break;
    }

    for (const image of images) {
      if (limit && stats.scanned >= limit) {
        break;
      }

      stats.scanned += 1;

      try {
        const location = resolveStorageLocation(image.storagePath);
        if (!location.bucket || !location.objectName) {
          stats.analysisFailed += 1;
          continue;
        }

        const analysis = await runNsfwImageAnalysis(
          await readObjectToBuffer(location.bucket, location.objectName),
          { mode: 'fast' },
        );

        if (!analysis) {
          stats.analysisFailed += 1;
        }

        const metadataPayload: Prisma.JsonObject = {};
        if (image.seed) {
          metadataPayload.seed = image.seed;
        }
        if (image.cfgScale != null) {
          metadataPayload.cfgScale = image.cfgScale;
        }
        if (image.steps != null) {
          metadataPayload.steps = image.steps;
        }

        const resolvedMetadata = Object.keys(metadataPayload).length > 0 ? metadataPayload : null;

        const decision = evaluateImageModeration({
          title: image.title,
          description: image.description,
          prompt: image.prompt,
          negativePrompt: image.negativePrompt,
          model: image.model,
          sampler: image.sampler,
          metadata: resolvedMetadata,
          tags: image.tags,
          adultKeywords,
          analysis: analysis,
        });

        const updatePayload: Prisma.ImageAssetUpdateInput = {};

        if (image.isAdult !== decision.isAdult) {
          updatePayload.isAdult = decision.isAdult;
          if (decision.isAdult) {
            stats.adultMarked += 1;
          } else {
            stats.adultCleared += 1;
          }
        }

        if (decision.requiresModeration) {
          if (image.moderationStatus !== ModerationStatus.FLAGGED) {
            updatePayload.moderationStatus = ModerationStatus.FLAGGED;
            updatePayload.flaggedAt = new Date();
            updatePayload.flaggedBy = { disconnect: true };
            stats.flagged += 1;
          }
          if (image.isPublic) {
            updatePayload.isPublic = false;
          }
        } else if (
          image.moderationStatus === ModerationStatus.FLAGGED &&
          image.flaggedById == null
        ) {
          updatePayload.moderationStatus = ModerationStatus.ACTIVE;
          updatePayload.flaggedAt = null;
          updatePayload.flaggedBy = { disconnect: true };
          stats.unflagged += 1;
        }

        if (Object.keys(updatePayload).length > 0) {
          await prisma.imageAsset.update({
            where: { id: image.id },
            data: updatePayload,
          });
        }
      } catch (error) {
        console.error('Failed to rescan image for NSFW signals', error);
        stats.errors += 1;
      }
    }

    const nextCursor: string | null = images[images.length - 1]?.id ?? null;
    if (!nextCursor) {
      break;
    }

    cursorId = nextCursor;
  }

  return stats;
};

let adultKeywordRecalculation: Promise<void> | null = null;
let adultKeywordRecalculationQueued = false;

export const scheduleAdultKeywordRecalculation = () => {
  if (adultKeywordRecalculation) {
    adultKeywordRecalculationQueued = true;
    return adultKeywordRecalculation;
  }

  adultKeywordRecalculation = recalculateAdultFlagsForAllAssets()
    .catch((error) => {
      console.error('Failed to recalculate adult flags after keyword change.', error);
    })
    .finally(() => {
      adultKeywordRecalculation = null;
      if (adultKeywordRecalculationQueued) {
        adultKeywordRecalculationQueued = false;
        scheduleAdultKeywordRecalculation();
      }
    });

  return adultKeywordRecalculation;
};

const nsfwRescanSchema = z
  .object({
    target: z.enum(['all', 'models', 'images']).default('all'),
    limit: z
      .number()
      .int()
      .positive()
      .max(1000)
      .optional(),
  })
  .default({ target: 'all' });

safetyRouter.post('/nsfw/rescan', async (req, res, next) => {
  try {
    const parsed = nsfwRescanSchema.parse((req.body ?? {}) as Record<string, unknown>);
    const adultKeywords = await getAdultKeywordLabels();

    const summary: {
      target: 'all' | 'models' | 'images';
      models?: NsfwRescanStats;
      images?: ImageRescanStats;
    } = {
      target: parsed.target,
    };

    if (parsed.target === 'all' || parsed.target === 'models') {
      summary.models = await rescanModelsForNsfw(adultKeywords, parsed.limit);
    }

    if (parsed.target === 'all' || parsed.target === 'images') {
      summary.images = await rescanImagesForNsfw(adultKeywords, parsed.limit);
    }

    res.json({ rescan: summary });
  } catch (error) {
    next(error);
  }
});

safetyRouter.get('/keywords', async (_req, res, next) => {
  try {
    const keywords = await listAdultSafetyKeywords();
    res.json({ keywords });
  } catch (error) {
    next(error);
  }
});

safetyRouter.post('/keywords', async (req, res, next) => {
  try {
    const parsed = createKeywordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid payload.', errors: parsed.error.flatten() });
      return;
    }

    const keyword = await prisma.adultSafetyKeyword.create({
      data: { label: parsed.data.label },
    });

    void scheduleAdultKeywordRecalculation();

    res.status(201).json({ keyword });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      res.status(409).json({ message: 'A keyword with this label already exists.' });
      return;
    }

    next(error);
  }
});

safetyRouter.delete('/keywords/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'Keyword ID is required.' });
      return;
    }

    await prisma.adultSafetyKeyword.delete({ where: { id } });

    void scheduleAdultKeywordRecalculation();

    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ message: 'Keyword not found.' });
      return;
    }

    next(error);
  }
});
