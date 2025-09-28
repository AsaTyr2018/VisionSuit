import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { determineAdultForImage, determineAdultForModel } from '../lib/adult-content';
import { getAdultKeywordLabels, getIllegalKeywordLabels } from '../lib/safety-keywords';
import { collectModerationSummaries, normalizeModerationSummary } from '../lib/nsfw-open-cv';
import { collectStringsFromJson, detectKeywordMatch } from '../lib/nsfw/keywordMatcher';
import type { Prisma } from '@prisma/client';

export const tagsRouter = Router();

tagsRouter.use(requireAuth, requireAdmin);

const toggleAdultSchema = z.object({
  isAdult: z.boolean(),
});

type TaggedModelRecord = {
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

type TaggedImageRecord = {
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

const recalculateAdultForTag = async (tagId: string) => {
  const [rawModels, rawImages] = await Promise.all([
    prisma.modelAsset.findMany({
      where: { tags: { some: { tagId } } },
      include: {
        tags: { include: { tag: true } },
        versions: { select: { metadata: true } },
      },
    }),
    prisma.imageAsset.findMany({
      where: { tags: { some: { tagId } } },
      include: {
        tags: { include: { tag: true } },
      },
    }),
  ]);

  const models = rawModels as unknown as TaggedModelRecord[];
  const images = rawImages as unknown as TaggedImageRecord[];

  const [adultKeywords, illegalKeywords] = await Promise.all([
    getAdultKeywordLabels(),
    getIllegalKeywordLabels(),
  ]);

  await Promise.all(
    models.map(async (model) => {
      const versionMetadataList = model.versions
        .map((entry) => entry.metadata ?? null)
        .filter((entry): entry is Prisma.JsonValue => entry != null);
      const moderationSummaries = collectModerationSummaries([
        model.moderationSummary ?? null,
        model.metadata ?? null,
        ...versionMetadataList,
      ]);
      const metadataStrings = [
        ...collectStringsFromJson(model.metadata ?? null),
        ...versionMetadataList.flatMap((entry) => collectStringsFromJson(entry)),
      ];

      const keywordAdult = determineAdultForModel({
        title: model.title,
        description: model.description,
        trigger: model.trigger,
        metadata: model.metadata ?? null,
        metadataList: versionMetadataList,
        tags: model.tags,
        adultKeywords,
        moderationSummaries,
      });

      const keywordIllegal = detectKeywordMatch(
        illegalKeywords,
        [
          model.title ?? '',
          model.description ?? '',
          model.trigger ?? '',
          ...metadataStrings,
        ],
        model.tags,
      );

      const nextIsAdult = keywordAdult || keywordIllegal;

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

      const moderationSummary = normalizeModerationSummary(image.moderationSummary);

      const metadata = Object.keys(metadataPayload).length > 0 ? metadataPayload : null;
      const metadataList = metadata ? [metadata] : [];

      const keywordAdult = determineAdultForImage({
        title: image.title,
        description: image.description,
        prompt: image.prompt,
        negativePrompt: image.negativePrompt,
        model: image.model,
        sampler: image.sampler,
        metadata,
        metadataList,
        tags: image.tags,
        adultKeywords,
        moderation: moderationSummary,
      });

      const metadataStrings = metadataList.flatMap((entry) => collectStringsFromJson(entry));

      const keywordIllegal = detectKeywordMatch(
        illegalKeywords,
        [
          image.title ?? '',
          image.description ?? '',
          image.prompt ?? '',
          image.negativePrompt ?? '',
          image.model ?? '',
          image.sampler ?? '',
          ...metadataStrings,
        ],
        image.tags,
      );

      const nextIsAdult = keywordAdult || keywordIllegal;

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
