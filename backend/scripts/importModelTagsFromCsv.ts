import fs from 'fs/promises';
import path from 'path';

import { PrismaClient } from '@prisma/client';

import '../src/config';

type CliOptions = {
  file: string;
  dryRun: boolean;
  tagCategory?: string;
};

type CsvRow = {
  lora: string;
  loraName: string;
  category: string;
  line: number;
};

type ModelRecord = {
  id: string;
  slug: string;
  title: string;
};

type ModelIndex = {
  models: Map<string, ModelRecord>;
  bySlug: Map<string, Set<string>>;
  bySlugCollapsed: Map<string, Set<string>>;
  byTitle: Map<string, Set<string>>;
  byTitleCollapsed: Map<string, Set<string>>;
  byFileName: Map<string, Set<string>>;
  byFileStem: Map<string, Set<string>>;
};

type ModelMatch =
  | { status: 'found'; model: ModelRecord; reason: string }
  | { status: 'conflict'; reason: string; candidates: ModelRecord[] }
  | { status: 'missing'; reason: string };

const prisma = new PrismaClient();

const printUsage = () => {
  // eslint-disable-next-line no-console
  console.log(`\nImport model tags from a CSV file.\n\n` +
    `Usage: npm --prefix backend run tags:import -- --file <path> [--dry-run] [--tag-category <group>]\n` +
    `   or: ts-node --transpile-only scripts/importModelTagsFromCsv.ts <path> [--dry-run] [--tag-category <group>]\n\n` +
    `Columns: lora,lora_name,category\n` +
    `The script matches models by slug, title, or storage filename and attaches tags named after the CSV category column.`);
};

const parseArgs = (): CliOptions => {
  const args = process.argv.slice(2);
  let file: string | undefined;
  let dryRun = false;
  let tagCategory: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    }

    if (arg === '--file' && index + 1 < args.length) {
      file = args[index + 1];
      index += 1;
      continue;
    }

    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--tag-category' && index + 1 < args.length) {
      tagCategory = args[index + 1];
      index += 1;
      continue;
    }

    if (!arg.startsWith('-') && !file) {
      file = arg;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!file) {
    throw new Error('Missing CSV file path. Pass --file <path> or provide it as the first positional argument.');
  }

  return { file, dryRun, tagCategory };
};

const normalizeKey = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
};

const collapseKey = (value: string | null | undefined): string | null => {
  const normalized = normalizeKey(value);
  if (!normalized) {
    return null;
  }
  const collapsed = normalized.replace(/[^a-z0-9]+/g, '');
  return collapsed.length > 0 ? collapsed : null;
};

const addIndexEntry = (target: Map<string, Set<string>>, key: string | null, modelId: string) => {
  if (!key) {
    return;
  }
  const existing = target.get(key);
  if (existing) {
    existing.add(modelId);
    return;
  }
  target.set(key, new Set([modelId]));
};

const basename = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  return path.basename(value);
};

const removeExtension = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }
  const lastDot = value.lastIndexOf('.');
  if (lastDot === -1) {
    return value;
  }
  return value.slice(0, lastDot);
};

const buildModelIndex = async (): Promise<ModelIndex> => {
  const models = await prisma.modelAsset.findMany({
    select: {
      id: true,
      slug: true,
      title: true,
      storagePath: true,
      versions: {
        select: {
          storagePath: true,
        },
      },
    },
  });

  const index: ModelIndex = {
    models: new Map(),
    bySlug: new Map(),
    bySlugCollapsed: new Map(),
    byTitle: new Map(),
    byTitleCollapsed: new Map(),
    byFileName: new Map(),
    byFileStem: new Map(),
  };

  for (const model of models) {
    const record: ModelRecord = {
      id: model.id,
      slug: model.slug,
      title: model.title,
    };
    index.models.set(model.id, record);

    addIndexEntry(index.bySlug, normalizeKey(model.slug), model.id);
    addIndexEntry(index.bySlugCollapsed, collapseKey(model.slug), model.id);
    addIndexEntry(index.byTitle, normalizeKey(model.title), model.id);
    addIndexEntry(index.byTitleCollapsed, collapseKey(model.title), model.id);

    const storageTargets = [model.storagePath, ...model.versions.map((entry) => entry.storagePath)];
    for (const target of storageTargets) {
      const fileName = basename(target);
      addIndexEntry(index.byFileName, normalizeKey(fileName), model.id);
      addIndexEntry(index.byFileStem, collapseKey(removeExtension(fileName)), model.id);
    }
  }

  return index;
};

const getCandidates = (map: Map<string, Set<string>>, key: string | null): string[] => {
  if (!key) {
    return [];
  }
  const entries = map.get(key);
  if (!entries) {
    return [];
  }
  return Array.from(entries);
};

const resolveCandidates = (ids: string[], index: ModelIndex): ModelRecord[] => {
  return ids
    .map((id) => index.models.get(id))
    .filter((entry): entry is ModelRecord => Boolean(entry));
};

const findModelForRow = (row: CsvRow, index: ModelIndex): ModelMatch => {
  const slugKey = normalizeKey(row.loraName);
  const slugCollapsedKey = collapseKey(row.loraName);
  const fileName = basename(row.lora);
  const fileKey = normalizeKey(fileName);
  const fileStemKey = collapseKey(removeExtension(fileName));
  const titleKey = normalizeKey(row.loraName);
  const titleCollapsedKey = collapseKey(row.loraName);

  const attempts: Array<{ ids: string[]; reason: string }> = [
    { ids: getCandidates(index.bySlug, slugKey), reason: `slug "${row.loraName}"` },
    { ids: getCandidates(index.bySlugCollapsed, slugCollapsedKey), reason: `collapsed slug "${row.loraName}"` },
    { ids: getCandidates(index.byFileName, fileKey), reason: `LoRA filename "${row.lora}"` },
    { ids: getCandidates(index.byFileStem, fileStemKey), reason: `LoRA filename stem "${fileStemKey ?? ''}"` },
    { ids: getCandidates(index.byTitle, titleKey), reason: `title "${row.loraName}"` },
    { ids: getCandidates(index.byTitleCollapsed, titleCollapsedKey), reason: `collapsed title "${row.loraName}"` },
  ];

  let conflict: { reason: string; ids: string[] } | null = null;

  for (const attempt of attempts) {
    if (attempt.ids.length === 1) {
      const [id] = attempt.ids;
      const model = index.models.get(id);
      if (model) {
        return { status: 'found', model, reason: attempt.reason };
      }
    }

    if (attempt.ids.length > 1 && !conflict) {
      conflict = { reason: attempt.reason, ids: attempt.ids };
    }
  }

  if (conflict) {
    return {
      status: 'conflict',
      reason: conflict.reason,
      candidates: resolveCandidates(conflict.ids, index),
    };
  }

  return {
    status: 'missing',
    reason: 'No matching slug, title, or storage filename was found.',
  };
};

const parseCsvLine = (line: string): string[] => {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
      continue;
    }

    current += char;
  }

  values.push(current.trim());
  return values;
};

const readCsv = async (filePath: string): Promise<CsvRow[]> => {
  const raw = await fs.readFile(filePath, 'utf8');
  const lines = raw.split(/\r?\n/);
  const rows: CsvRow[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    const values = parseCsvLine(lines[i]);
    if (values.length < 3) {
      throw new Error(`Invalid CSV format on line ${i + 1}: expected at least 3 columns.`);
    }

    if (i === 0) {
      const header = values.map((entry) => entry.toLowerCase());
      if (header[0] === 'lora' && header[1] === 'lora_name' && header[2] === 'category') {
        continue;
      }
    }

    const [lora, loraName, category] = values;
    rows.push({
      lora: lora.trim(),
      loraName: loraName.trim(),
      category: category.trim(),
      line: i + 1,
    });
  }

  return rows;
};

const run = async () => {
  const options = parseArgs();
  const rows = await readCsv(options.file);
  if (rows.length === 0) {
    // eslint-disable-next-line no-console
    console.log('[tags] No rows found in the CSV file. Nothing to do.');
    return;
  }

  const index = await buildModelIndex();

  const assignments = new Map<string, { record: ModelRecord; labels: Set<string> }>();
  const unmatched: Array<{ row: CsvRow; reason: string }> = [];
  const conflicts: Array<{ row: CsvRow; reason: string; candidates: ModelRecord[] }> = [];
  const skippedCategories: Array<{ row: CsvRow; reason: string }> = [];

  for (const row of rows) {
    if (!row.category) {
      skippedCategories.push({ row, reason: 'Category column was empty.' });
      continue;
    }

    const match = findModelForRow(row, index);
    if (match.status === 'missing') {
      unmatched.push({ row, reason: match.reason });
      continue;
    }

    if (match.status === 'conflict') {
      conflicts.push({ row, reason: match.reason, candidates: match.candidates });
      continue;
    }

    const normalizedLabel = row.category.trim();
    if (!normalizedLabel) {
      skippedCategories.push({ row, reason: 'Category resolved to an empty label after trimming.' });
      continue;
    }

    const existing = assignments.get(match.model.id);
    if (existing) {
      existing.labels.add(normalizedLabel);
    } else {
      assignments.set(match.model.id, {
        record: match.model,
        labels: new Set([normalizedLabel]),
      });
    }
  }

  const matchedRows = rows.length - unmatched.length - conflicts.length - skippedCategories.length;

  // eslint-disable-next-line no-console
  console.log('[tags] Parsed CSV rows:', {
    totalRows: rows.length,
    matchedRows,
    uniqueModels: assignments.size,
    unmatchedRows: unmatched.length,
    conflictingRows: conflicts.length,
    skippedCategories: skippedCategories.length,
  });

  if (unmatched.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[tags] Unmatched entries:');
    for (const entry of unmatched.slice(0, 10)) {
      // eslint-disable-next-line no-console
      console.warn(`  Line ${entry.row.line}: ${entry.row.lora} (${entry.row.loraName}) → ${entry.reason}`);
    }
    if (unmatched.length > 10) {
      // eslint-disable-next-line no-console
      console.warn(`  … ${unmatched.length - 10} additional unmatched rows omitted.`);
    }
  }

  if (conflicts.length > 0) {
    // eslint-disable-next-line no-console
    console.warn('[tags] Ambiguous entries (multiple models matched):');
    for (const entry of conflicts.slice(0, 10)) {
      const candidateList = entry.candidates.map((candidate) => `${candidate.title} [${candidate.slug}]`).join('; ');
      // eslint-disable-next-line no-console
      console.warn(`  Line ${entry.row.line}: ${entry.row.lora} (${entry.row.loraName}) → ${entry.reason}: ${candidateList}`);
    }
    if (conflicts.length > 10) {
      // eslint-disable-next-line no-console
      console.warn(`  … ${conflicts.length - 10} additional conflicting rows omitted.`);
    }
  }

  if (assignments.size === 0) {
    // eslint-disable-next-line no-console
    console.log('[tags] No tag assignments to process.');
    return;
  }

  const uniqueLabels = new Set<string>();
  for (const assignment of assignments.values()) {
    for (const label of assignment.labels) {
      uniqueLabels.add(label);
    }
  }

  if (options.dryRun) {
    // eslint-disable-next-line no-console
    console.log('[tags] Dry run enabled. Planned assignments:');
    for (const assignment of assignments.values()) {
      const labels = Array.from(assignment.labels).join(', ');
      // eslint-disable-next-line no-console
      console.log(`  ${assignment.record.title} [${assignment.record.slug}] ← ${labels}`);
    }
    // eslint-disable-next-line no-console
    console.log(`[tags] Would ensure ${uniqueLabels.size} tag(s) and link them to ${assignments.size} model(s).`);
    return;
  }

  const labelList = Array.from(uniqueLabels);
  const existingTags = labelList.length > 0
    ? await prisma.tag.findMany({ where: { label: { in: labelList } } })
    : [];

  const tagCache = new Map<string, string>();
  for (const tag of existingTags) {
    tagCache.set(tag.label, tag.id);
  }

  let createdTags = 0;
  for (const label of labelList) {
    if (tagCache.has(label)) {
      continue;
    }

    const tag = await prisma.tag.create({
      data: {
        label,
        category: options.tagCategory ?? null,
      },
    });
    tagCache.set(label, tag.id);
    createdTags += 1;
  }

  let createdLinks = 0;
  let existingLinks = 0;
  const touchedModels = new Set<string>();

  for (const assignment of assignments.values()) {
    for (const label of assignment.labels) {
      const tagId = tagCache.get(label);
      if (!tagId) {
        // eslint-disable-next-line no-console
        console.warn(`[tags] Missing tag cache entry for label "${label}"; skipping.`);
        continue;
      }

      const current = await prisma.assetTag.findUnique({
        where: {
          assetId_tagId: {
            assetId: assignment.record.id,
            tagId,
          },
        },
      });

      if (current) {
        existingLinks += 1;
        continue;
      }

      await prisma.assetTag.create({
        data: {
          assetId: assignment.record.id,
          tagId,
        },
      });
      createdLinks += 1;
      touchedModels.add(assignment.record.id);
    }
  }

  // eslint-disable-next-line no-console
  console.log('[tags] Tag import complete:', {
    createdTags,
    existingTags: existingTags.length,
    createdLinks,
    existingLinks,
    modelsUpdated: touchedModels.size,
  });
};

run()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[tags] Tag import failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
