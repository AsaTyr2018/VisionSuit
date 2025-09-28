import type { Prisma } from '@prisma/client';

type TagReference = Array<{ tag: { label: string; isAdult: boolean } }>;

const normalizeString = (value: string | null | undefined) =>
  typeof value === 'string' ? value.trim().toLowerCase() : '';

const normalizeForMatch = (value: string | null | undefined) =>
  normalizeString(value)
    .replace(/[\s_-]+/g, ' ')
    .replace(/\s+/g, ' ');

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

export const buildKeywordDetector = (keywords: string[]) => {
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

export const detectKeywordMatch = (keywords: string[], texts: string[], tags: TagReference) =>
  buildKeywordDetector(keywords)(texts, tags);

export const collectStringsFromJson = (
  value: Prisma.JsonValue | null | undefined,
  limit = 50,
): string[] => {
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
