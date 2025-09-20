import type { RankTier, RankingSettings, UserRankingState } from '@prisma/client';

import { prisma } from './prisma';

export interface ContributionCounts {
  models: number;
  galleries: number;
  images: number;
}

export interface ResolvedRank {
  label: string;
  description: string;
  minimumScore: number;
  nextLabel: string | null;
  nextScore: number | null;
  score: number;
  isBlocked: boolean;
}

const FALLBACK_SETTINGS: Pick<RankingSettings, 'modelWeight' | 'galleryWeight' | 'imageWeight'> = {
  modelWeight: 3,
  galleryWeight: 2,
  imageWeight: 1,
};

interface TierLike {
  label: string;
  description: string;
  minimumScore: number;
  position?: number;
}

const FALLBACK_TIERS: TierLike[] = [
  {
    label: 'Newcomer',
    description: 'Getting started with first uploads and curated collections.',
    minimumScore: 0,
    position: 0,
  },
  {
    label: 'Curator',
    description: 'Actively maintains a growing catalog of models and showcases.',
    minimumScore: 6,
    position: 1,
  },
  {
    label: 'Senior Curator',
    description: 'Regularly delivers polished LoRAs and collections for the community.',
    minimumScore: 18,
    position: 2,
  },
  {
    label: 'Master Curator',
    description: 'Leads large-scale curation programs with sustained contributions.',
    minimumScore: 40,
    position: 3,
  },
];

const sortTiers = <T extends TierLike>(tiers: T[]): T[] =>
  [...tiers].sort((a, b) => {
    if (a.minimumScore === b.minimumScore) {
      const aPosition = a.position ?? 0;
      const bPosition = b.position ?? 0;
      return aPosition - bPosition;
    }

    return a.minimumScore - b.minimumScore;
  });

export const getRankingSettings = async () => {
  const settings = await prisma.rankingSettings.findFirst({ orderBy: { id: 'asc' } });

  if (!settings) {
    return FALLBACK_SETTINGS;
  }

  return {
    modelWeight: settings.modelWeight,
    galleryWeight: settings.galleryWeight,
    imageWeight: settings.imageWeight,
  };
};

export const getActiveRankTiers = async (): Promise<TierLike[]> => {
  const tiers = await prisma.rankTier.findMany({
    where: { isActive: true },
    orderBy: [
      { minimumScore: 'asc' },
      { position: 'asc' },
    ],
  });

  if (!tiers.length) {
    return sortTiers(FALLBACK_TIERS);
  }

  return tiers;
};

export const computeBaseContributionScore = (
  counts: ContributionCounts,
  settings: Pick<RankingSettings, 'modelWeight' | 'galleryWeight' | 'imageWeight'>,
) =>
  counts.models * settings.modelWeight +
  counts.galleries * settings.galleryWeight +
  counts.images * settings.imageWeight;

const resolveTierForScore = (score: number, tiers: TierLike[]) => {
  const sorted = sortTiers(tiers);
  const ranked = sorted.length > 0 ? sorted : sortTiers(FALLBACK_TIERS);

  const firstTier = ranked[0];

  if (!firstTier) {
    throw new Error('No rank tiers configured.');
  }

  let current = firstTier;

  for (const tier of ranked) {
    if (score >= tier.minimumScore) {
      current = tier;
    }
  }

  const next = ranked.find((tier) => tier.minimumScore > score) ?? null;

  return { current, next };
};

export const resolveRankForScore = async (score: number) => {
  const tiers = await getActiveRankTiers();
  return resolveRankForScoreWith(tiers, score, null);
};

const resolveRankForScoreWith = (
  tiers: TierLike[],
  score: number,
  state: Pick<UserRankingState, 'isExcluded'> | null,
): ResolvedRank => {
  const sortedTiers = sortTiers(tiers);
  const { current, next } = resolveTierForScore(score, sortedTiers);

  if (state?.isExcluded) {
    return {
      label: 'Ranking Blocked',
      description: 'This curator has been excluded from the public ranking ladder by an administrator.',
      minimumScore: current?.minimumScore ?? 0,
      nextLabel: null,
      nextScore: null,
      score,
      isBlocked: true,
    };
  }

  return {
    label: current.label,
    description: current.description,
    minimumScore: current.minimumScore,
    nextLabel: next?.label ?? null,
    nextScore: next?.minimumScore ?? null,
    score,
    isBlocked: false,
  };
};

export const resolveUserRank = async (userId: string, counts: ContributionCounts): Promise<ResolvedRank> => {
  const [settings, tiers, state] = await Promise.all([
    getRankingSettings(),
    getActiveRankTiers(),
    prisma.userRankingState.findUnique({ where: { userId } }),
  ]);

  const baseScore = computeBaseContributionScore(counts, settings);
  const offset = state?.scoreOffset ?? 0;
  const totalScore = Math.max(0, baseScore + offset);

  return resolveRankForScoreWith(tiers, totalScore, state ? { isExcluded: state.isExcluded } : null);
};

export const resetUserRanking = async (userId: string, counts: ContributionCounts) => {
  const settings = await getRankingSettings();
  const baseScore = computeBaseContributionScore(counts, settings);
  const offset = -baseScore;

  await prisma.userRankingState.upsert({
    where: { userId },
    update: {
      scoreOffset: offset,
      lastResetAt: new Date(),
    },
    create: {
      userId,
      scoreOffset: offset,
      lastResetAt: new Date(),
    },
  });
};

export const setUserRankingBlock = async (userId: string, isBlocked: boolean) => {
  await prisma.userRankingState.upsert({
    where: { userId },
    update: { isExcluded: isBlocked },
    create: { userId, isExcluded: isBlocked },
  });
};

export const clearUserRankingOffset = async (userId: string) => {
  await prisma.userRankingState.upsert({
    where: { userId },
    update: { scoreOffset: 0 },
    create: { userId, scoreOffset: 0 },
  });
};
