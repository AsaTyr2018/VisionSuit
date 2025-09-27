import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { determineAdultForImage, determineAdultForModel } from '../lib/adult-content';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { prisma } from '../lib/prisma';
import { getAdultKeywordLabels, listAdultSafetyKeywords } from '../lib/adult-keywords';

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

type ModelAdultEvaluationTarget = {
  id: string;
  title: string;
  description: string | null;
  trigger: string | null;
  metadata: Prisma.JsonValue | null;
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
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
};

const recalculateAdultFlagsForModels = async (adultKeywords: string[]) => {
  let cursorId: string | null = null;

  while (true) {
    const models: ModelAdultEvaluationTarget[] = await prisma.modelAsset.findMany({
      orderBy: { id: 'asc' },
      take: ADULT_RECALC_BATCH_SIZE,
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
        tags: { include: { tag: true } },
        versions: { select: { metadata: true } },
      },
    });

    if (models.length === 0) {
      break;
    }

    const updates = models
      .map((model) => {
        const versionMetadataList = model.versions
          .map((entry) => entry.metadata ?? null)
          .filter((entry): entry is Prisma.JsonValue => entry != null);
        const nextIsAdult = determineAdultForModel({
          title: model.title,
          description: model.description,
          trigger: model.trigger,
          metadata: model.metadata ?? null,
          metadataList: versionMetadataList,
          tags: model.tags,
          adultKeywords,
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
    const images: ImageAdultEvaluationTarget[] = await prisma.imageAsset.findMany({
      orderBy: { id: 'asc' },
      take: ADULT_RECALC_BATCH_SIZE,
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
        isAdult: true,
        tags: { include: { tag: true } },
      },
    });

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
