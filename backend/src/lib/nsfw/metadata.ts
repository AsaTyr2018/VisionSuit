import { appConfig } from '../../config';

export interface NormalizedTagCount {
  tag: string;
  count: number;
}

export interface MetadataScoreMatches {
  adult: NormalizedTagCount[];
  minor: NormalizedTagCount[];
  beast: NormalizedTagCount[];
}

export interface MetadataScoreResult {
  adultScore: number;
  minorScore: number;
  beastScore: number;
  matches: MetadataScoreMatches;
}

const toNumericCount = (value: unknown): number | null => {
  if (typeof value === 'number') {
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      return null;
    }
    return value;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
      return null;
    }
    return parsed;
  }

  return null;
};

const aggregateTagCounts = (accumulator: Map<string, number>, tag: string, count: number) => {
  const current = accumulator.get(tag) ?? 0;
  accumulator.set(tag, current + count);
};

const normalizeEntriesFromArray = (value: unknown[]): Map<string, number> => {
  const entries = new Map<string, number>();

  for (const item of value) {
    if (!item) {
      continue;
    }

    if (Array.isArray(item) && item.length >= 2) {
      const [rawTag, rawCount] = item;
      if (typeof rawTag !== 'string') {
        continue;
      }

      const tag = rawTag.trim().toLowerCase();
      if (!tag) {
        continue;
      }

      const numeric = toNumericCount(rawCount);
      if (numeric === null) {
        continue;
      }

      const sanitized = Math.round(Math.max(0, numeric));
      if (sanitized <= 0) {
        continue;
      }

      aggregateTagCounts(entries, tag, sanitized);
      continue;
    }

    if (typeof item === 'object') {
      const record = item as Record<string, unknown>;
      const tagValue = record.tag ?? record.Tag ?? record.name;
      if (typeof tagValue !== 'string') {
        continue;
      }

      const tag = tagValue.trim().toLowerCase();
      if (!tag) {
        continue;
      }

      const numeric = toNumericCount(record.count ?? record.value ?? record.frequency);
      if (numeric === null) {
        continue;
      }

      const sanitized = Math.round(Math.max(0, numeric));
      if (sanitized <= 0) {
        continue;
      }

      aggregateTagCounts(entries, tag, sanitized);
    }
  }

  return entries;
};

const normalizeEntriesFromObject = (value: Record<string, unknown>): Map<string, number> => {
  const entries = new Map<string, number>();

  for (const [rawTag, rawCount] of Object.entries(value)) {
    if (typeof rawTag !== 'string') {
      continue;
    }

    const tag = rawTag.trim().toLowerCase();
    if (!tag) {
      continue;
    }

    const numeric = toNumericCount(rawCount);
    if (numeric === null) {
      continue;
    }

    const sanitized = Math.round(Math.max(0, numeric));
    if (sanitized <= 0) {
      continue;
    }

    aggregateTagCounts(entries, tag, sanitized);
  }

  return entries;
};

export const normalizeFrequencyTable = (value: unknown): NormalizedTagCount[] => {
  if (value === null || value === undefined) {
    return [];
  }

  let normalized: Map<string, number> | null = null;

  if (Array.isArray(value)) {
    normalized = normalizeEntriesFromArray(value);
  } else if (typeof value === 'object') {
    normalized = normalizeEntriesFromObject(value as Record<string, unknown>);
  }

  if (!normalized) {
    return [];
  }

  return Array.from(normalized.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

export const mergeFrequencyTables = (...tables: NormalizedTagCount[][]): NormalizedTagCount[] => {
  const accumulator = new Map<string, number>();

  for (const table of tables) {
    if (!Array.isArray(table)) {
      continue;
    }

    for (const entry of table) {
      if (!entry || typeof entry.tag !== 'string') {
        continue;
      }

      const tag = entry.tag.trim().toLowerCase();
      if (!tag) {
        continue;
      }

      const numeric = toNumericCount(entry.count);
      if (numeric === null) {
        continue;
      }

      const sanitized = Math.round(Math.max(0, numeric));
      if (sanitized <= 0) {
        continue;
      }

      aggregateTagCounts(accumulator, tag, sanitized);
    }
  }

  return Array.from(accumulator.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
};

const toTermSet = (terms: string[]): Set<string> => new Set(terms.map((term) => term.trim().toLowerCase()).filter(Boolean));

export const scoreFrequencyTable = (table: NormalizedTagCount[]): MetadataScoreResult => {
  const filters = appConfig.nsfw.metadataFilters;
  const adultTerms = toTermSet(filters.adultTerms);
  const minorTerms = toTermSet(filters.minorTerms);
  const beastTerms = toTermSet(filters.bestialityTerms);

  let adultScore = 0;
  let minorScore = 0;
  let beastScore = 0;

  const matches: MetadataScoreMatches = {
    adult: [],
    minor: [],
    beast: [],
  };

  for (const entry of table) {
    const tag = entry.tag;
    const count = Math.round(Math.max(0, entry.count));
    if (count <= 0) {
      continue;
    }

    if (adultTerms.has(tag)) {
      adultScore += count;
      matches.adult.push({ tag, count });
    }

    if (minorTerms.has(tag)) {
      minorScore += count;
      matches.minor.push({ tag, count });
    }

    if (beastTerms.has(tag)) {
      beastScore += count;
      matches.beast.push({ tag, count });
    }
  }

  return {
    adultScore,
    minorScore,
    beastScore,
    matches,
  };
};

export interface MetadataEvaluationResult extends MetadataScoreResult {
  normalized: NormalizedTagCount[];
}

export const evaluateLoRaMetadata = (metadata: {
  ss_tag_frequency?: unknown;
  tag_frequency?: unknown;
}): MetadataEvaluationResult => {
  const normalized = mergeFrequencyTables(
    normalizeFrequencyTable(metadata?.ss_tag_frequency),
    normalizeFrequencyTable(metadata?.tag_frequency),
  );

  return {
    normalized,
    ...scoreFrequencyTable(normalized),
  };
};
