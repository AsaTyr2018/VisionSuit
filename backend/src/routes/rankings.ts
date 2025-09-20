import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import {
  getRankingSettings,
  getActiveRankTiers,
  resetUserRanking,
  setUserRankingBlock,
  resolveUserRank,
  type ContributionCounts,
} from '../lib/ranking';

export const rankingsRouter = Router();

const settingsSchema = z.object({
  modelWeight: z.number().int().min(0).max(1000),
  galleryWeight: z.number().int().min(0).max(1000),
  imageWeight: z.number().int().min(0).max(1000),
});

const baseTierSchema = z.object({
  label: z.string().min(2).max(120),
  description: z.string().min(2).max(600),
  minimumScore: z.number().int().min(0),
  position: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

const tierCreateSchema = baseTierSchema;
const tierUpdateSchema = baseTierSchema.partial().refine((value) => Object.keys(value).length > 0, {
  message: 'No tier changes provided.',
});

type TierCreatePayload = z.infer<typeof tierCreateSchema>;
type TierUpdatePayload = z.infer<typeof tierUpdateSchema>;

const buildTierCreateInput = (payload: TierCreatePayload): Prisma.RankTierCreateInput => {
  const { label, description, minimumScore, position, isActive } = payload;
  const data: Prisma.RankTierCreateInput = {
    label,
    description,
    minimumScore,
  };

  if (position !== undefined) {
    data.position = position;
  }

  if (isActive !== undefined) {
    data.isActive = isActive;
  }

  return data;
};

const buildTierUpdateInput = (payload: TierUpdatePayload): Prisma.RankTierUpdateInput => {
  const data: Prisma.RankTierUpdateInput = {};

  if (payload.label !== undefined) {
    data.label = payload.label;
  }

  if (payload.description !== undefined) {
    data.description = payload.description;
  }

  if (payload.minimumScore !== undefined) {
    data.minimumScore = payload.minimumScore;
  }

  if (payload.position !== undefined) {
    data.position = payload.position;
  }

  if (payload.isActive !== undefined) {
    data.isActive = payload.isActive;
  }

  return data;
};

const computeContributionCounts = async (userId: string): Promise<ContributionCounts> => {
  const [models, galleries, images] = await Promise.all([
    prisma.modelAsset.count({ where: { ownerId: userId } }),
    prisma.gallery.count({ where: { ownerId: userId } }),
    prisma.imageAsset.count({ where: { ownerId: userId } }),
  ]);

  return {
    models,
    galleries,
    images,
  };
};

rankingsRouter.use(requireAuth, requireAdmin);

rankingsRouter.get('/settings', async (_req, res, next) => {
  try {
    const settings = await prisma.rankingSettings.findFirst({ orderBy: { id: 'asc' } });
    if (!settings) {
      const fallback = await getRankingSettings();
      res.json({
        settings: {
          modelWeight: fallback.modelWeight,
          galleryWeight: fallback.galleryWeight,
          imageWeight: fallback.imageWeight,
          isFallback: true,
        },
      });
      return;
    }

    res.json({
      settings: {
        id: settings.id,
        modelWeight: settings.modelWeight,
        galleryWeight: settings.galleryWeight,
        imageWeight: settings.imageWeight,
        isFallback: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

rankingsRouter.put('/settings', async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid ranking settings payload.', errors: parsed.error.flatten() });
      return;
    }

    const existing = await prisma.rankingSettings.findFirst({ orderBy: { id: 'asc' } });
    const record = existing
      ? await prisma.rankingSettings.update({ where: { id: existing.id }, data: parsed.data })
      : await prisma.rankingSettings.create({ data: parsed.data });

    res.json({
      settings: {
        id: record.id,
        modelWeight: record.modelWeight,
        galleryWeight: record.galleryWeight,
        imageWeight: record.imageWeight,
        isFallback: false,
      },
    });
  } catch (error) {
    next(error);
  }
});

rankingsRouter.get('/tiers', async (_req, res, next) => {
  try {
    const tiers = await prisma.rankTier.findMany({
      orderBy: [
        { minimumScore: 'asc' },
        { position: 'asc' },
      ],
    });

    if (!tiers.length) {
      const fallback = await getActiveRankTiers();
      res.json({ tiers: fallback, isFallback: true });
      return;
    }

    res.json({ tiers, isFallback: false });
  } catch (error) {
    next(error);
  }
});

rankingsRouter.post('/tiers', async (req, res, next) => {
  try {
    const parsed = tierCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid rank tier payload.', errors: parsed.error.flatten() });
      return;
    }

    const tier = await prisma.rankTier.create({ data: buildTierCreateInput(parsed.data) });
    res.status(201).json({ tier });
  } catch (error) {
    next(error);
  }
});

rankingsRouter.put('/tiers/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'Tier ID missing.' });
      return;
    }

    const parsed = tierUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid tier update payload.', errors: parsed.error.flatten() });
      return;
    }

    const existing = await prisma.rankTier.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ message: 'Rank tier not found.' });
      return;
    }

    const tier = await prisma.rankTier.update({ where: { id }, data: buildTierUpdateInput(parsed.data) });
    res.json({ tier });
  } catch (error) {
    next(error);
  }
});

rankingsRouter.delete('/tiers/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'Tier ID missing.' });
      return;
    }

    const existing = await prisma.rankTier.findUnique({ where: { id } });
    if (!existing) {
      res.status(404).json({ message: 'Rank tier not found.' });
      return;
    }

    await prisma.rankTier.delete({ where: { id } });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

rankingsRouter.post('/users/:id/reset', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'User ID missing.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });

    if (!user || !user.isActive) {
      res.status(404).json({ message: 'User not found or inactive.' });
      return;
    }

    const counts = await computeContributionCounts(id);
    await resetUserRanking(id, counts);
    const rank = await resolveUserRank(id, counts);

    res.json({
      userId: id,
      rank,
    });
  } catch (error) {
    next(error);
  }
});

rankingsRouter.post('/users/:id/block', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'User ID missing.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });

    if (!user || !user.isActive) {
      res.status(404).json({ message: 'User not found or inactive.' });
      return;
    }

    await setUserRankingBlock(id, true);
    const counts = await computeContributionCounts(id);
    const rank = await resolveUserRank(id, counts);

    res.json({
      userId: id,
      rank,
    });
  } catch (error) {
    next(error);
  }
});

rankingsRouter.post('/users/:id/unblock', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'User ID missing.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });

    if (!user || !user.isActive) {
      res.status(404).json({ message: 'User not found or inactive.' });
      return;
    }

    await setUserRankingBlock(id, false);
    const counts = await computeContributionCounts(id);
    const rank = await resolveUserRank(id, counts);

    res.json({
      userId: id,
      rank,
    });
  } catch (error) {
    next(error);
  }
});
