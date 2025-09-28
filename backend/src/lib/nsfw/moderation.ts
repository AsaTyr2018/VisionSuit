import type { Prisma } from '@prisma/client';

import { appConfig } from '../../config';
import { determineAdultForImage, determineAdultForModel } from '../adult-content';
import type { ImageModerationSummary } from '../nsfw-open-cv';
import { buildKeywordDetector, collectStringsFromJson, detectKeywordMatch } from './keywordMatcher';
import type { MetadataEvaluationResult } from './metadata';
import { evaluateLoRaMetadata } from './metadata';
import type { ImageAnalysisResult } from './imageAnalysis';

type TagReference = Array<{ tag: { label: string; isAdult: boolean } }>;

const isBypassEnabled = () => appConfig.nsfw.bypassFilter;

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
  illegalKeywords: string[];
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
  keywordAdult: boolean;
  keywordIllegal: boolean;
}

export const evaluateModelModeration = (
  context: ModelModerationContext,
): ModelModerationDecision => {
  const bypass = isBypassEnabled();

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

  const metadataList = context.metadataList ?? [];
  const additionalTexts = context.additionalTexts ?? [];
  const metadataStrings = [
    ...collectStringsFromJson(context.metadata ?? null),
    ...metadataList.flatMap((entry) => collectStringsFromJson(entry)),
  ];

  const keywordIllegal = detectKeywordMatch(
    context.illegalKeywords,
    [
      context.title ?? '',
      context.description ?? '',
      context.trigger ?? '',
      ...metadataStrings,
      ...additionalTexts,
    ],
    context.tags,
  );

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

  const analysis = bypass ? null : context.analysis;
  const analysisAdult = Boolean(analysis?.decisions?.isAdult);

  const requiresModeration = metadataMinor || metadataBeast || keywordIllegal;
  const isAdult = adultFromSignals || analysisAdult || metadataAdult || requiresModeration;

  return {
    isAdult,
    requiresModeration,
    metadataScreening: screening,
    metadataAdult,
    metadataMinor,
    metadataBeast,
    keywordAdult: adultFromSignals,
    keywordIllegal,
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
  illegalKeywords: string[];
  analysis?: ImageAnalysisResult | null;
  additionalTexts?: string[];
  moderation?: ImageModerationSummary | null;
}

export interface ImageModerationDecision {
  isAdult: boolean;
  requiresModeration: boolean;
  illegalMinor: boolean;
  illegalBeast: boolean;
  keywordAdult: boolean;
  keywordIllegal: boolean;
}

export const evaluateImageModeration = (
  context: ImageModerationContext,
): ImageModerationDecision => {
  const bypass = isBypassEnabled();

  const metadataList = context.metadataList ?? [];
  const analysis = bypass ? null : context.analysis;
  const moderation = bypass ? null : (context.moderation ?? null);
  const analysisInput = analysis
    ? { imageAnalysis: { decisions: analysis.decisions, scores: analysis.scores } }
    : {};

  const metadataStrings = [
    ...collectStringsFromJson(context.metadata),
    ...metadataList.flatMap((entry) => collectStringsFromJson(entry)),
  ];

  const additionalTexts = context.additionalTexts ?? [];

  const keywordAdult = determineAdultForImage({
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
    moderation,
  });

  const analysisAdult = Boolean(analysis?.decisions?.isAdult);

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
  const keywordIllegal = detectKeywordMatch(context.illegalKeywords, textPool, context.tags);
  const requiresModeration = illegalMinor || illegalBeast || keywordIllegal;

  const isAdult = keywordAdult || analysisAdult || requiresModeration;

  return {
    isAdult,
    requiresModeration,
    illegalMinor,
    illegalBeast,
    keywordAdult,
    keywordIllegal,
  };
};

