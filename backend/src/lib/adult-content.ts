import type { Prisma } from '@prisma/client';

import type { ImageModerationSummary } from './nsfw-open-cv';

const BASE_ADULT_PATTERNS: RegExp[] = [
  /\bnsfw\b/i,
  /\bnude(s)?\b/i,
  /\bnudity\b/i,
  /\bsex(ual|y)?\b/i,
  /\berotic\b/i,
  /\bporn(o|ographic)?\b/i,
  /\bexplicit\b/i,
  /\bintimate\b/i,
  /\bnipple(s)?\b/i,
  /\bbreast(s)?\b/i,
  /\btopless\b/i,
  /\bundress(ed)?\b/i,
  /\blindgerie\b/i,
  /\bunderwear\b/i,
  /\bthong\b/i,
  /\bbikini\b/i,
  /\bfetish\b/i,
  /\borgasm\b/i,
  /\bcum(shot)?\b/i,
  /\bstrip(ping)?\b/i,
  /\bdominatrix\b/i,
  /\br18\b/i,
  /(^|\W)18\+(?=\W|$)/i,
  /\bxxx\b/i,
];

const normalizeString = (value: string) => value.trim();

const normalizeKeywords = (keywords: string[]) =>
  Array.from(
    new Set(
      keywords
        .map((keyword) => keyword.trim().toLowerCase())
        .filter((keyword) => keyword.length > 0),
    ),
  ).slice(0, 100);

const matchesAdultSignals = (value: string, keywords: string[]) => {
  if (!value) {
    return false;
  }

  const normalized = normalizeString(value);
  if (normalized.length === 0) {
    return false;
  }

  const lowered = normalized.toLowerCase();

  if (keywords.some((keyword) => lowered.includes(keyword))) {
    return true;
  }

  return BASE_ADULT_PATTERNS.some((pattern) => pattern.test(normalized));
};

const collectStringsFromJson = (value: Prisma.JsonValue | null | undefined, limit = 50) => {
  if (value == null) {
    return [] as string[];
  }

  const queue: { entry: Prisma.JsonValue; depth: number }[] = [{ entry: value, depth: 0 }];
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

const hasAdultSignalFromTexts = (texts: Array<string | null | undefined>, keywords: string[]) =>
  texts.some((text) => (text ? matchesAdultSignals(text, keywords) : false));

const hasAdultSignalFromTags = (
  tags: Array<{ tag: { label: string; isAdult: boolean } }>,
  keywords: string[],
) => {
  if (tags.some((entry) => entry.tag.isAdult)) {
    return true;
  }

  return tags.some((entry) => matchesAdultSignals(entry.tag.label, keywords));
};

interface ImageAnalysisSummary {
  isAdult: boolean | null;
  isSuggestive: boolean | null;
  needsReview: boolean | null;
  adultScore: number | null;
  suggestiveScore: number | null;
}

const ANALYSIS_ADULT_SCORE_THRESHOLD = 0.75;

const toBooleanOrNull = (value: unknown): boolean | null => {
  if (typeof value === 'boolean') {
    return value;
  }
  return null;
};

const toScoreOrNull = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  return null;
};

const toAnalysisSummary = (
  analysis?: {
    decisions?: { isAdult?: boolean; isSuggestive?: boolean; needsReview?: boolean };
    scores?: { adult?: number; suggestive?: number };
  } | null,
): ImageAnalysisSummary | null => {
  if (!analysis) {
    return null;
  }

  const decisions = analysis.decisions ?? {};
  const scores = analysis.scores ?? {};

  const summary: ImageAnalysisSummary = {
    isAdult: toBooleanOrNull(decisions.isAdult),
    isSuggestive: toBooleanOrNull(decisions.isSuggestive),
    needsReview: toBooleanOrNull(decisions.needsReview),
    adultScore: toScoreOrNull(scores.adult),
    suggestiveScore: toScoreOrNull(scores.suggestive),
  };

  return summary.isAdult != null || summary.isSuggestive != null || summary.needsReview != null || summary.adultScore != null
    ? summary
    : null;
};

const parseAnalysisSummaryFromJson = (value: Prisma.JsonValue | null | undefined): ImageAnalysisSummary | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const extractFromObject = (target: Record<string, Prisma.JsonValue>): ImageAnalysisSummary | null => {
    const decisionsRaw = target.decisions;
    const scoresRaw = target.scores;

    const normalizedDecisions: {
      isAdult?: boolean;
      isSuggestive?: boolean;
      needsReview?: boolean;
    } = {};

    if (decisionsRaw && typeof decisionsRaw === 'object' && !Array.isArray(decisionsRaw)) {
      const decisions = decisionsRaw as Record<string, Prisma.JsonValue>;
      const isAdult = toBooleanOrNull(decisions.isAdult);
      if (isAdult != null) {
        normalizedDecisions.isAdult = isAdult;
      }
      const isSuggestive = toBooleanOrNull(decisions.isSuggestive);
      if (isSuggestive != null) {
        normalizedDecisions.isSuggestive = isSuggestive;
      }
      const needsReview = toBooleanOrNull(decisions.needsReview);
      if (needsReview != null) {
        normalizedDecisions.needsReview = needsReview;
      }
    }

    const normalizedScores: { adult?: number; suggestive?: number } = {};
    if (scoresRaw && typeof scoresRaw === 'object' && !Array.isArray(scoresRaw)) {
      const scores = scoresRaw as Record<string, Prisma.JsonValue>;
      const adultScore = toScoreOrNull(scores.adult);
      if (adultScore != null) {
        normalizedScores.adult = adultScore;
      }
      const suggestiveScore = toScoreOrNull(scores.suggestive);
      if (suggestiveScore != null) {
        normalizedScores.suggestive = suggestiveScore;
      }
    }

    const summaryInput: {
      decisions?: { isAdult?: boolean; isSuggestive?: boolean; needsReview?: boolean };
      scores?: { adult?: number; suggestive?: number };
    } = {};

    if (Object.keys(normalizedDecisions).length > 0) {
      summaryInput.decisions = normalizedDecisions;
    }
    if (Object.keys(normalizedScores).length > 0) {
      summaryInput.scores = normalizedScores;
    }

    if (summaryInput.decisions || summaryInput.scores) {
      return toAnalysisSummary(summaryInput);
    }

    return null;
  };

  const source = value as Record<string, Prisma.JsonValue>;
  const candidate = extractFromObject(source);
  if (candidate) {
    return candidate;
  }

  if (source.imageAnalysis) {
    const nested = parseAnalysisSummaryFromJson(source.imageAnalysis);
    if (nested) {
      return nested;
    }
  }

  if (source.nsfwImageAnalysis) {
    const nested = parseAnalysisSummaryFromJson(source.nsfwImageAnalysis);
    if (nested) {
      return nested;
    }
  }

  if (source.nsfw && typeof source.nsfw === 'object' && !Array.isArray(source.nsfw)) {
    const nsfw = source.nsfw as Record<string, Prisma.JsonValue>;
    const nested = extractFromObject(nsfw) ?? parseAnalysisSummaryFromJson(nsfw.imageAnalysis ?? nsfw.nsfwImageAnalysis);
    if (nested) {
      return nested;
    }
  }

  if (source.preview && typeof source.preview === 'object' && !Array.isArray(source.preview)) {
    const preview = source.preview as Record<string, Prisma.JsonValue>;
    const nested =
      extractFromObject(preview) ??
      parseAnalysisSummaryFromJson(preview.nsfwImageAnalysis ?? preview.nsfw);
    if (nested) {
      return nested;
    }
  }

  return null;
};

const resolveImageAnalysisSummary = (
  analysis:
    | {
        decisions?: { isAdult?: boolean; isSuggestive?: boolean; needsReview?: boolean };
        scores?: { adult?: number; suggestive?: number };
      }
    | undefined,
  metadataSources: Array<Prisma.JsonValue | null | undefined>,
): ImageAnalysisSummary | null => {
  const direct = toAnalysisSummary(analysis ?? null);
  if (direct) {
    return direct;
  }

  for (const source of metadataSources) {
    const candidate = parseAnalysisSummaryFromJson(source);
    if (candidate) {
      return candidate;
    }
  }

  return null;
};

export const determineAdultForImage = (input: {
  title?: string | null;
  description?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  model?: string | null;
  sampler?: string | null;
  metadata?: Prisma.JsonValue | null;
  metadataList?: Prisma.JsonValue[];
  additionalTexts?: string[];
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
  adultKeywords?: string[];
  imageAnalysis?: {
    decisions?: { isAdult?: boolean; isSuggestive?: boolean; needsReview?: boolean };
    scores?: { adult?: number; suggestive?: number };
  };
}) => {
  const adultKeywords = normalizeKeywords(input.adultKeywords ?? []);
  const metadataSources = [input.metadata, ...(input.metadataList ?? [])];
  const metadataStrings = metadataSources.flatMap((entry) => collectStringsFromJson(entry));
  const freeformTexts = input.additionalTexts?.map((entry) => entry ?? '').filter((entry) => entry.length > 0) ?? [];
  const adultFromTexts = hasAdultSignalFromTexts([
    input.title,
    input.description,
    input.prompt,
    input.negativePrompt,
    input.model,
    input.sampler,
    ...metadataStrings,
    ...freeformTexts,
  ], adultKeywords);

  const adultFromTags = hasAdultSignalFromTags(input.tags, adultKeywords);
  const analysisSummary = resolveImageAnalysisSummary(input.imageAnalysis, metadataSources);
  const adultFromAnalysis = Boolean(analysisSummary?.isAdult) ||
    (analysisSummary?.adultScore != null && analysisSummary.adultScore >= ANALYSIS_ADULT_SCORE_THRESHOLD);

  return adultFromTexts || adultFromTags || adultFromAnalysis;
};

export const determineAdultForModel = (input: {
  title?: string | null;
  description?: string | null;
  trigger?: string | null;
  metadata?: Prisma.JsonValue | null;
  metadataList?: Prisma.JsonValue[];
  additionalTexts?: string[];
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
  adultKeywords?: string[];
  moderationSummaries?: ImageModerationSummary[];
}) => {
  const adultKeywords = normalizeKeywords(input.adultKeywords ?? []);
  const metadataSources = [input.metadata, ...(input.metadataList ?? [])];
  const metadataStrings = metadataSources.flatMap((entry) => collectStringsFromJson(entry));
  const freeformTexts = input.additionalTexts?.map((entry) => entry ?? '').filter((entry) => entry.length > 0) ?? [];
  const adultFromTexts = hasAdultSignalFromTexts([
    input.title,
    input.description,
    input.trigger,
    ...metadataStrings,
    ...freeformTexts,
  ], adultKeywords);

  const adultFromTags = hasAdultSignalFromTags(input.tags, adultKeywords);
  const adultFromModeration = (input.moderationSummaries ?? []).some((summary) =>
    hasAdultSignalFromModeration(summary),
  );

  return adultFromTexts || adultFromTags || adultFromModeration;
};
