import type { Prisma } from '@prisma/client';

import { appConfig } from '../../config';
import { determineAdultForImage, determineAdultForModel } from '../adult-content';
import type { ImageModerationSummary } from '../nsfw-open-cv';
import type { MetadataEvaluationResult } from './metadata';
import { evaluateLoRaMetadata } from './metadata';
import type { ImageAnalysisResult } from './imageAnalysis';

type TagReference = Array<{ tag: { label: string; isAdult: boolean } }>;

const normalizeString = (value: string | null | undefined) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const normalizeForMatch = (value: string | null | undefined) =>
  normalizeString(value)
    .replace(/[\s_-]+/g, ' ')
    .replace(/\s+/g, ' ');

const collectStringsFromJson = (value: Prisma.JsonValue | null | undefined, limit = 50): string[] => {
  if (value == null) {
    return [];
  }

  const queue: Array<{ entry: Prisma.JsonValue; depth: number }> = [{ entry: value, depth: 0 }];
  const results: string[] = [];

  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift();
    if (!current) {
      break;
    }

    const { entry, depth } = current;

    if (typeof entry === 'string') {
      results.push(entry);
      continue;
    }

    if (Array.isArray(entry) && depth < 4) {
      for (const child of entry) {
        queue.push({ entry: child as Prisma.JsonValue, depth: depth + 1 });
      }
      continue;
    }

    if (entry && typeof entry === 'object' && depth < 4) {
      for (const child of Object.values(entry as Record<string, Prisma.JsonValue>)) {
        queue.push({ entry: child, depth: depth + 1 });
      }
    }
  }

  return results;
};

const hasKeywordMatch = (source: string, keyword: string) => {
  const normalizedSource = normalizeForMatch(source);
  if (!normalizedSource) {
    return false;
  }

  const normalizedKeyword = normalizeForMatch(keyword);
  if (!normalizedKeyword) {
    return false;
  }

  const paddedSource = ` ${normalizedSource} `;
  const paddedKeyword = ` ${normalizedKeyword} `;

  return paddedSource.includes(paddedKeyword) || normalizedSource.includes(normalizedKeyword);
};

const buildKeywordDetector = (keywords: string[]) => {
  const normalizedKeywords = keywords
    .map((keyword) => normalizeString(keyword))
    .filter((keyword) => keyword.length > 0);

  return (texts: string[], tags: TagReference) => {
    if (normalizedKeywords.length === 0) {
      return false;
    }

    for (const text of texts) {
      for (const keyword of normalizedKeywords) {
        if (hasKeywordMatch(text, keyword)) {
          return true;
        }
      }
    }

    for (const entry of tags) {
      const label = entry.tag.label;
      for (const keyword of normalizedKeywords) {
        if (hasKeywordMatch(label, keyword)) {
          return true;
        }
      }
    }

    return false;
  };
};

export const resolveMetadataScreening = (
  metadata: Prisma.JsonValue | null | undefined,
): MetadataEvaluationResult | null => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }

  const payload = metadata as Record<string, unknown>;
  const direct = payload.nsfwMetadata;

  if (direct && typeof direct === 'object') {
    return direct as MetadataEvaluationResult;
  }

  const extracted = payload.extracted;
  if (extracted && typeof extracted === 'object') {
    try {
      return evaluateLoRaMetadata(
        extracted as { ss_tag_frequency?: unknown; tag_frequency?: unknown },
      );
    } catch {
      return null;
    }
  }

  return null;
};

const metadataThresholds = () => appConfig.nsfw.metadataFilters.thresholds;

export interface ModelModerationContext {
  title?: string | null;
  description?: string | null;
  trigger?: string | null;
  metadata?: Prisma.JsonValue | null;
  metadataList?: Prisma.JsonValue[];
  tags: TagReference;
  adultKeywords: string[];
  analysis?: Pick<ImageAnalysisResult, 'decisions' | 'scores'> | null;
  additionalTexts?: string[];
}

export interface ModelModerationDecision {
  isAdult: boolean;
  requiresModeration: boolean;
  metadataScreening: MetadataEvaluationResult | null;
  metadataAdult: boolean;
  metadataMinor: boolean;
  metadataBeast: boolean;
}

export const evaluateModelModeration = (
  context: ModelModerationContext,
): ModelModerationDecision => {
  const screening = resolveMetadataScreening(context.metadata ?? null);
  const thresholds = metadataThresholds();

  const metadataAdult = Boolean(
    screening && thresholds.adult > 0 && screening.adultScore >= thresholds.adult,
  );
  const metadataMinor = Boolean(
    screening && thresholds.minor > 0 && screening.minorScore >= thresholds.minor,
  );
  const metadataBeast = Boolean(
    screening && thresholds.beast > 0 && screening.beastScore >= thresholds.beast,
  );

  const requiresModeration = metadataMinor || metadataBeast;

  const metadataList = context.metadataList ?? [];
  const additionalTexts = context.additionalTexts ?? [];

  const adultFromSignals = determineAdultForModel({
    title: context.title ?? null,
    description: context.description ?? null,
    trigger: context.trigger ?? null,
    metadata: context.metadata ?? null,
    metadataList,
    tags: context.tags,
    adultKeywords: context.adultKeywords,
    additionalTexts,
  });

  const analysisAdult = Boolean(context.analysis?.decisions?.isAdult);

  const isAdult = adultFromSignals || analysisAdult || metadataAdult || requiresModeration;

  return {
    isAdult,
    requiresModeration,
    metadataScreening: screening,
    metadataAdult,
    metadataMinor,
    metadataBeast,
  };
};

export interface ImageModerationContext {
  title?: string | null;
  description?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  model?: string | null;
  sampler?: string | null;
  metadata?: Prisma.JsonValue | null;
  metadataList?: Prisma.JsonValue[];
  tags: TagReference;
  adultKeywords: string[];
  analysis?: ImageAnalysisResult | null;
  additionalTexts?: string[];
  moderation?: ImageModerationSummary | null;
}

export interface ImageModerationDecision {
  isAdult: boolean;
  requiresModeration: boolean;
  illegalMinor: boolean;
  illegalBeast: boolean;
}

export const evaluateImageModeration = (
  context: ImageModerationContext,
): ImageModerationDecision => {
  const metadataList = context.metadataList ?? [];
  const analysisInput = context.analysis
    ? { imageAnalysis: { decisions: context.analysis.decisions, scores: context.analysis.scores } }
    : {};

  const metadataStrings = [
    ...collectStringsFromJson(context.metadata),
    ...metadataList.flatMap((entry) => collectStringsFromJson(entry)),
  ];

  const additionalTexts = context.additionalTexts ?? [];

  const imageAdult = determineAdultForImage({
    title: context.title ?? null,
    description: context.description ?? null,
    prompt: context.prompt ?? null,
    negativePrompt: context.negativePrompt ?? null,
    model: context.model ?? null,
    sampler: context.sampler ?? null,
    metadata: context.metadata ?? null,
    metadataList,
    tags: context.tags,
    adultKeywords: context.adultKeywords,
    additionalTexts,
    ...analysisInput,
    moderation: context.moderation ?? null,
  });

  const analysisAdult = Boolean(context.analysis?.decisions?.isAdult);

  const thresholds = appConfig.nsfw.metadataFilters;
  const minorDetector = buildKeywordDetector(thresholds.minorTerms);
  const beastDetector = buildKeywordDetector(thresholds.bestialityTerms);

  const textPool = [
    context.title ?? '',
    context.description ?? '',
    context.prompt ?? '',
    context.negativePrompt ?? '',
    context.model ?? '',
    context.sampler ?? '',
    ...metadataStrings,
    ...additionalTexts,
  ];

  const illegalMinor = minorDetector(textPool, context.tags);
  const illegalBeast = beastDetector(textPool, context.tags);
  const requiresModeration = illegalMinor || illegalBeast;

  const isAdult = imageAdult || analysisAdult || requiresModeration;

  return {
    isAdult,
    requiresModeration,
    illegalMinor,
    illegalBeast,
  };
};

