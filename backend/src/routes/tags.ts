import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { determineAdultForImage, determineAdultForModel } from '../lib/adult-content';
import { getAdultKeywordLabels } from '../lib/adult-keywords';
import type { Prisma } from '@prisma/client';

export const tagsRouter = Router();

tagsRouter.use(requireAuth, requireAdmin);

const toggleAdultSchema = z.object({
  isAdult: z.boolean(),
});

const recalculateAdultForTag = async (tagId: string) => {
  const [models, images] = await Promise.all([
    prisma.modelAsset.findMany({
      where: { tags: { some: { tagId } } },
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
    }),
    prisma.imageAsset.findMany({
      where: { tags: { some: { tagId } } },
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
    }),
  ]);

  const adultKeywords = await getAdultKeywordLabels();

  await Promise.all(
    models.map(async (model) => {
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

      if (model.isAdult !== nextIsAdult) {
        await prisma.modelAsset.update({ where: { id: model.id }, data: { isAdult: nextIsAdult } });
      }
    }),
  );

  await Promise.all(
    images.map(async (image) => {
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

      const nextIsAdult = determineAdultForImage({
        title: image.title,
        description: image.description,
        prompt: image.prompt,
        negativePrompt: image.negativePrompt,
        model: image.model,
        sampler: image.sampler,
        metadata: Object.keys(metadataPayload).length > 0 ? metadataPayload : null,
        tags: image.tags,
        adultKeywords,
      });

      if (image.isAdult !== nextIsAdult) {
        await prisma.imageAsset.update({ where: { id: image.id }, data: { isAdult: nextIsAdult } });
      }
    }),
  );
};

const buildTagSummary = (tag: {
  id: string;
  label: string;
  category: string | null;
  isAdult: boolean;
  _count: { imageTags: number; assetTags: number };
}) => ({
  id: tag.id,
  label: tag.label,
  category: tag.category,
  isAdult: tag.isAdult,
  imageCount: tag._count.imageTags,
  modelCount: tag._count.assetTags,
});

tagsRouter.get('/safety', async (_req, res, next) => {
  try {
    const tags = await prisma.tag.findMany({
      orderBy: { label: 'asc' },
      select: {
        id: true,
        label: true,
        category: true,
        isAdult: true,
        _count: { select: { imageTags: true, assetTags: true } },
      },
    });

    res.json({ tags: tags.map(buildTagSummary) });
  } catch (error) {
    next(error);
  }
});

tagsRouter.put('/:id/adult', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'Tag ID missing.' });
      return;
    }

    const parsed = toggleAdultSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid payload.', errors: parsed.error.flatten() });
      return;
    }

    const updatedTag = await prisma.tag.update({
      where: { id },
      data: { isAdult: parsed.data.isAdult },
      select: {
        id: true,
        label: true,
        category: true,
        isAdult: true,
        _count: { select: { imageTags: true, assetTags: true } },
      },
    });

    await recalculateAdultForTag(updatedTag.id);

    const refreshed = await prisma.tag.findUnique({
      where: { id: updatedTag.id },
      select: {
        id: true,
        label: true,
        category: true,
        isAdult: true,
        _count: { select: { imageTags: true, assetTags: true } },
      },
    });

    if (!refreshed) {
      res.status(500).json({ message: 'Failed to refresh tag summary.' });
      return;
    }

    res.json({ tag: buildTagSummary(refreshed) });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'P2025') {
      res.status(404).json({ message: 'Tag not found.' });
      return;
    }

    next(error);
  }
});
