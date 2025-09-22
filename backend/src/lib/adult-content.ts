import type { Prisma } from '@prisma/client';

const ADULT_PATTERNS: RegExp[] = [
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

const matchesAdultPattern = (value: string) => {
  if (!value) {
    return false;
  }

  const normalized = normalizeString(value);
  if (normalized.length === 0) {
    return false;
  }

  return ADULT_PATTERNS.some((pattern) => pattern.test(normalized));
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

const hasAdultSignalFromTexts = (texts: Array<string | null | undefined>) =>
  texts.some((text) => (text ? matchesAdultPattern(text) : false));

const hasAdultSignalFromTags = (tags: Array<{ tag: { label: string; isAdult: boolean } }>) => {
  if (tags.some((entry) => entry.tag.isAdult)) {
    return true;
  }

  return tags.some((entry) => matchesAdultPattern(entry.tag.label));
};

export const determineAdultForImage = (input: {
  title?: string | null;
  description?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  model?: string | null;
  sampler?: string | null;
  metadata?: Prisma.JsonValue | null;
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
}) => {
  const metadataStrings = collectStringsFromJson(input.metadata);
  const adultFromTexts = hasAdultSignalFromTexts([
    input.title,
    input.description,
    input.prompt,
    input.negativePrompt,
    input.model,
    input.sampler,
    ...metadataStrings,
  ]);

  const adultFromTags = hasAdultSignalFromTags(input.tags);

  return adultFromTexts || adultFromTags;
};

export const determineAdultForModel = (input: {
  title?: string | null;
  description?: string | null;
  trigger?: string | null;
  metadata?: Prisma.JsonValue | null;
  tags: Array<{ tag: { label: string; isAdult: boolean } }>;
}) => {
  const metadataStrings = collectStringsFromJson(input.metadata);
  const adultFromTexts = hasAdultSignalFromTexts([
    input.title,
    input.description,
    input.trigger,
    ...metadataStrings,
  ]);

  const adultFromTags = hasAdultSignalFromTags(input.tags);

  return adultFromTexts || adultFromTags;
};
