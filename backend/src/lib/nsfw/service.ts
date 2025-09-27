import type { Prisma } from '@prisma/client';

import type { AnalyzerTaskOptions } from './runtime';
import { nsfwAnalysisScheduler } from './runtime';
import type { ImageAnalysisResult } from './imageAnalysis';

const toNumber = (value: number) => (Number.isFinite(value) ? value : 0);

const round = (value: number) => Math.round(value * 10000) / 10000;

const cloneDecisions = (analysis: ImageAnalysisResult['decisions']): Prisma.JsonObject => ({
  isAdult: Boolean(analysis.isAdult),
  isSuggestive: Boolean(analysis.isSuggestive),
  needsReview: Boolean(analysis.needsReview),
});

const cloneScores = (analysis: ImageAnalysisResult['scores']): Prisma.JsonObject => ({
  adult: round(toNumber(analysis.adult)),
  suggestive: round(toNumber(analysis.suggestive)),
});

export const runNsfwImageAnalysis = async (
  payload: Buffer,
  options: AnalyzerTaskOptions = {},
): Promise<ImageAnalysisResult | null> => {
  try {
    return await nsfwAnalysisScheduler.enqueue(payload, options);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn(`NSFW image analysis failed: ${(error as Error).message}`);
    return null;
  }
};

export const toJsonImageAnalysis = (analysis: ImageAnalysisResult): Prisma.JsonObject => {
  const payload: Prisma.JsonObject = {
    width: toNumber(analysis.width),
    height: toNumber(analysis.height),
    skinPixels: toNumber(analysis.skinPixels),
    totalPixels: toNumber(analysis.totalPixels),
    skinRatio: round(toNumber(analysis.skinRatio)),
    dominantSkinRatio: round(toNumber(analysis.dominantSkinRatio)),
    coverageScore: round(toNumber(analysis.coverageScore)),
    edgeDensity: round(toNumber(analysis.edgeDensity)),
    colorStdDev: round(toNumber(analysis.colorStdDev)),
    decisions: cloneDecisions(analysis.decisions),
    scores: cloneScores(analysis.scores),
    flags: analysis.flags,
  };

  if (analysis.region) {
    payload.region = {
      x: toNumber(analysis.region.x),
      y: toNumber(analysis.region.y),
      width: toNumber(analysis.region.width),
      height: toNumber(analysis.region.height),
      centroidX: round(toNumber(analysis.region.centroidX)),
      centroidY: round(toNumber(analysis.region.centroidY)),
    } as Prisma.JsonObject;
  }

  if (analysis.pose) {
    payload.pose = {
      torsoCoverage: round(toNumber(analysis.pose.torsoCoverage)),
      hipCoverage: round(toNumber(analysis.pose.hipCoverage)),
      shoulderCoverage: round(toNumber(analysis.pose.shoulderCoverage)),
      torsoPresenceConfidence: round(toNumber(analysis.pose.torsoPresenceConfidence)),
      hipPresenceConfidence: round(toNumber(analysis.pose.hipPresenceConfidence)),
      limbDominanceConfidence: round(toNumber(analysis.pose.limbDominanceConfidence)),
      offCenterDistance: round(toNumber(analysis.pose.offCenterDistance)),
      torsoContinuity: round(toNumber(analysis.pose.torsoContinuity)),
      overallCentralCoverage: round(toNumber(analysis.pose.overallCentralCoverage)),
    } as Prisma.JsonObject;
  }

  if (analysis.cnn) {
    payload.cnn = {
      nude: round(toNumber(analysis.cnn.nude)),
      swimwear: round(toNumber(analysis.cnn.swimwear)),
      ambiguous: round(toNumber(analysis.cnn.ambiguous)),
      delta: round(toNumber(analysis.cnn.delta)),
      provider: analysis.cnn.provider,
      inferenceMs: toNumber(analysis.cnn.inferenceMs),
    } as Prisma.JsonObject;
  }

  return payload;
};
