import type { Prisma } from '@prisma/client';

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

  return adultFromTexts || adultFromTags;
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

  return adultFromTexts || adultFromTags;
};
