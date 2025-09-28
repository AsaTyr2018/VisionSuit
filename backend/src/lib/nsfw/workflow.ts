import type { Prisma } from '@prisma/client';

import { analyzeImageModeration, serializeModerationSummary, type ImageModerationSummary } from '../nsfw-open-cv';
import { appConfig } from '../../config';

import type { ImageModerationDecision } from './moderation';
import { evaluateImageModeration } from './moderation';
import type { AnalyzerTaskOptions } from './runtime';
import type { ImageAnalysisResult } from './imageAnalysis';
import { runNsfwImageAnalysis } from './service';

export interface ImageModerationWorkflowContext {
  title?: string | null;
  description?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  model?: string | null;
  sampler?: string | null;
  metadata?: Prisma.JsonValue | null;
  metadataList?: Prisma.JsonValue[];
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
  additionalTexts?: string[];
}

export interface ImageModerationWorkflowInput {
  buffer: Buffer;
  adultKeywords: string[];
  illegalKeywords: string[];
  context: ImageModerationWorkflowContext;
  analysisOptions?: AnalyzerTaskOptions;
  existingSummary?: ImageModerationSummary | null;
}

export interface ImageModerationWorkflowResult {
  analysis: ImageAnalysisResult | null;
  summary: ImageModerationSummary | null;
  serializedSummary: Prisma.JsonValue | null;
  decision: ImageModerationDecision;
}

export const runImageModerationWorkflow = async (
  input: ImageModerationWorkflowInput,
): Promise<ImageModerationWorkflowResult> => {
  const { buffer, adultKeywords, illegalKeywords, context, analysisOptions, existingSummary } = input;

  if (appConfig.nsfw.bypassFilter) {
    const metadataList = context.metadataList ?? [];
    const decision = evaluateImageModeration({
      title: context.title,
      description: context.description,
      prompt: context.prompt,
      negativePrompt: context.negativePrompt,
      model: context.model,
      sampler: context.sampler,
      metadata: context.metadata ?? null,
      metadataList,
      tags: context.tags,
      adultKeywords,
      illegalKeywords,
      analysis: null,
      additionalTexts: context.additionalTexts,
      moderation: null,
    });

    return {
      analysis: null,
      summary: null,
      serializedSummary: null,
      decision,
    };
  }

  const [analysis, summary] = await Promise.all([
    runNsfwImageAnalysis(buffer, analysisOptions),
    existingSummary
      ? Promise.resolve(existingSummary)
      : analyzeImageModeration(buffer).catch((error) => {
          console.warn('Failed to analyze image for OpenCV moderation summary.', error);
          return null;
        }),
  ]);

  const metadataList = context.metadataList ?? [];
  const decision = evaluateImageModeration({
    title: context.title,
    description: context.description,
    prompt: context.prompt,
    negativePrompt: context.negativePrompt,
    model: context.model,
    sampler: context.sampler,
    metadata: context.metadata ?? null,
    metadataList,
    tags: context.tags,
    adultKeywords,
    illegalKeywords,
    analysis,
    additionalTexts: context.additionalTexts,
    moderation: summary,
  });

  const serializedSummary = summary ? serializeModerationSummary(summary) : null;

  return {
    analysis,
    summary,
    serializedSummary,
    decision,
  };
};
