import { extname } from 'node:path';
import { inflateSync } from 'node:zlib';

import imageSize from 'image-size';
import { parse as parseExif } from 'exifr';

export interface ImageMetadataResult {
  width?: number;
  height?: number;
  prompt?: string | null;
  negativePrompt?: string | null;
  seed?: string | null;
  model?: string | null;
  sampler?: string | null;
  cfgScale?: number | null;
  steps?: number | null;
  extras?: Record<string, unknown>;
}

export interface SafetensorsMetadataResult {
  metadata: Record<string, unknown>;
  baseModel?: string | null;
  modelName?: string | null;
  modelAliases?: string[];
}

const STABLE_DIFFUSION_KEYS = new Set([
  'prompt',
  'negative_prompt',
  'negativeprompt',
  'seed',
  'sampler',
  'sampler_name',
  'cfg_scale',
  'cfgscale',
  'steps',
  'model',
  'model_hash',
  'model_name',
  'modelhash',
  'modelname',
]);

const toNullableString = (value: unknown): string | null => {
  if (value == null) {
    return null;
  }

  if (typeof value === 'string') {
    return value.trim().length > 0 ? value.trim() : null;
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return `${value}`;
  }

  return null;
};

const toNullableNumber = (value: unknown): number | null => {
  if (value == null) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
};

const toNullableInt = (value: unknown): number | null => {
  if (value == null) {
    return null;
  }

  const numeric = typeof value === 'string' ? Number.parseInt(value, 10) : value;

  if (typeof numeric === 'number' && Number.isFinite(numeric)) {
    return Math.trunc(numeric);
  }

  return null;
};

const parseStableDiffusionBlock = (raw: string) => {
  const result: ImageMetadataResult = { extras: {} };
  const normalized = raw.replace(/\r\n/g, '\n');
  const lowerCase = normalized.toLowerCase();
  const negativeIndex = lowerCase.indexOf('negative prompt:');

  let metaSection = '';
  let working = normalized;

  if (negativeIndex >= 0) {
    const promptSection = normalized.slice(0, negativeIndex).trim();
    if (promptSection.length > 0) {
      result.prompt = promptSection.replace(/^prompt:\s*/i, '').trim() || null;
    }

    const afterNegative = normalized.slice(negativeIndex + 'negative prompt:'.length);
    const nextLineBreak = afterNegative.indexOf('\n');
    if (nextLineBreak >= 0) {
      const negativeLine = afterNegative.slice(0, nextLineBreak).trim();
      result.negativePrompt = negativeLine.length > 0 ? negativeLine : null;
      metaSection = afterNegative.slice(nextLineBreak + 1).trim();
    } else {
      const negativeLine = afterNegative.trim();
      result.negativePrompt = negativeLine.length > 0 ? negativeLine : null;
      metaSection = '';
    }
  } else {
    working = normalized.trim();
    const lines = working.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);

    if (lines.length > 0) {
      const possibleMeta = lines.length > 0 ? lines[lines.length - 1] : undefined;
      if (possibleMeta && possibleMeta.includes(':') && possibleMeta.includes(',')) {
        metaSection = possibleMeta;
        lines.pop();
      }

      if (lines.length > 0) {
        const promptCandidate = lines.join('\n').replace(/^prompt:\s*/i, '').trim();
        result.prompt = promptCandidate.length > 0 ? promptCandidate : null;
      }
    }
  }

  if (metaSection.length === 0) {
    const tail = normalized.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    const candidate = tail.length > 0 ? tail[tail.length - 1] : undefined;
    if (candidate && candidate.includes(':') && candidate.includes(',')) {
      metaSection = candidate;
    }
  }

  if (metaSection.length === 0) {
    return result;
  }

  const pairs = metaSection
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes(':'));

  for (const pair of pairs) {
    const [rawKeyPart, ...rest] = pair.split(':');
    const rawKey = rawKeyPart?.trim();

    if (!rawKey || rawKey.length === 0) {
      continue;
    }

    const key = rawKey.toLowerCase();
    const value = rest.join(':').trim();

    if (key === 'steps') {
      const parsed = toNullableInt(value);
      if (parsed != null) {
        result.steps = parsed;
        continue;
      }
    }

    if (key === 'cfg scale') {
      const parsed = toNullableNumber(value);
      if (parsed != null) {
        result.cfgScale = parsed;
        continue;
      }
    }

    if (key === 'seed') {
      result.seed = value.length > 0 ? value : null;
      continue;
    }

    if (key === 'sampler') {
      result.sampler = value.length > 0 ? value : null;
      continue;
    }

    if (key === 'model') {
      result.model = value.length > 0 ? value : null;
      continue;
    }

    if (key === 'size') {
      const match = value.match(/(\d+)\s*[x×]\s*(\d+)/i);
      if (match && match[1] && match[2]) {
        const width = Number.parseInt(match[1], 10);
        const height = Number.parseInt(match[2], 10);
        if (Number.isFinite(width) && Number.isFinite(height)) {
          result.width = width;
          result.height = height;
        }
        continue;
      }
    }

    if (!result.extras) {
      result.extras = {};
    }
    if (!result.extras) {
      result.extras = {};
    }
    result.extras[rawKey] = value;
  }

  return result;
};

const parseJsonMetadata = (payload: unknown): Partial<ImageMetadataResult> & { extras?: Record<string, unknown> } => {
  if (!payload || typeof payload !== 'object') {
    return {};
  }

  const record = payload as Record<string, unknown>;
  const result: Partial<ImageMetadataResult> & { extras?: Record<string, unknown> } = {};

  if (typeof record.prompt === 'string') {
    result.prompt = record.prompt;
  }

  if (typeof record.negative_prompt === 'string') {
    result.negativePrompt = record.negative_prompt;
  }

  if (typeof record.negativePrompt === 'string' && !result.negativePrompt) {
    result.negativePrompt = record.negativePrompt;
  }

  if (record.seed !== undefined) {
    result.seed = toNullableString(record.seed);
  }

  if (record.sampler !== undefined) {
    result.sampler = toNullableString(record.sampler);
  }

  if (record.sampler_name !== undefined && !result.sampler) {
    result.sampler = toNullableString(record.sampler_name);
  }

  if (record.cfg_scale !== undefined) {
    result.cfgScale = toNullableNumber(record.cfg_scale);
  }

  if (record.cfgScale !== undefined && result.cfgScale == null) {
    result.cfgScale = toNullableNumber(record.cfgScale);
  }

  if (record.steps !== undefined) {
    result.steps = toNullableInt(record.steps);
  }

  if (record.model !== undefined) {
    result.model = toNullableString(record.model);
  }

  if (record.model_name !== undefined && !result.model) {
    result.model = toNullableString(record.model_name);
  }

  if (record.Width !== undefined && record.Height !== undefined) {
    const width = toNullableInt(record.Width);
    const height = toNullableInt(record.Height);
    if (width && height) {
      result.width = width;
      result.height = height;
    }
  }

  if (record.width !== undefined && record.height !== undefined) {
    const width = toNullableInt(record.width);
    const height = toNullableInt(record.height);
    if (width && height) {
      result.width = width;
      result.height = height;
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (STABLE_DIFFUSION_KEYS.has(key.toLowerCase())) {
      continue;
    }

    if (!result.extras) {
      result.extras = {};
    }
    result.extras[key] = value;
  }

  return result;
};

const mergeImageMetadata = (
  target: ImageMetadataResult,
  update: Partial<ImageMetadataResult> & { extras?: Record<string, unknown> },
) => {
  if (update.prompt && !target.prompt) {
    target.prompt = update.prompt;
  }

  if (update.negativePrompt && !target.negativePrompt) {
    target.negativePrompt = update.negativePrompt;
  }

  if (update.seed && !target.seed) {
    target.seed = update.seed;
  }

  if (update.model && !target.model) {
    target.model = update.model;
  }

  if (update.sampler && !target.sampler) {
    target.sampler = update.sampler;
  }

  if (update.cfgScale != null && target.cfgScale == null) {
    target.cfgScale = update.cfgScale;
  }

  if (update.steps != null && target.steps == null) {
    target.steps = update.steps;
  }

  if (update.width && !target.width) {
    target.width = update.width;
  }

  if (update.height && !target.height) {
    target.height = update.height;
  }

  if (update.extras) {
    if (!target.extras) {
      target.extras = {};
    }
    Object.assign(target.extras, update.extras);
  }
};

const extractPngText = (buffer: Buffer) => {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (!buffer.subarray(0, 8).equals(signature)) {
    return new Map<string, string>();
  }

  const texts = new Map<string, string>();
  let offset = 8;

  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    offset += 4;
    const type = buffer.toString('ascii', offset, offset + 4);
    offset += 4;

    if (offset + length > buffer.length) {
      break;
    }

    const data = buffer.subarray(offset, offset + length);
    offset += length + 4; // skip data + CRC

    if (type === 'tEXt') {
      const separator = data.indexOf(0);
      if (separator > 0) {
        const key = data.subarray(0, separator).toString('utf8');
        const value = data.subarray(separator + 1).toString('utf8');
        texts.set(key, value);
      }
    }

    if (type === 'zTXt') {
      const separator = data.indexOf(0);
      if (separator > 0 && separator + 2 <= data.length) {
        const compression = data[separator + 1];
        if (compression === 0) {
          try {
            const inflated = inflateSync(data.subarray(separator + 2)).toString('utf8');
            const key = data.subarray(0, separator).toString('utf8');
            texts.set(key, inflated);
          } catch {
            // ignore malformed chunk
          }
        }
      }
    }

    if (type === 'iTXt') {
      const firstNull = data.indexOf(0);
      if (firstNull > 0 && firstNull + 5 < data.length) {
        const key = data.subarray(0, firstNull).toString('utf8');
        const compressedFlag = data[firstNull + 1];
        const compressionMethod = data[firstNull + 2];
        let cursor = firstNull + 3;

        const languageEnd = data.indexOf(0, cursor);
        if (languageEnd < 0) {
          continue;
        }
        cursor = languageEnd + 1;

        const translatedEnd = data.indexOf(0, cursor);
        if (translatedEnd < 0) {
          continue;
        }
        cursor = translatedEnd + 1;

        let text = '';
        if (compressedFlag === 1 && compressionMethod === 0) {
          try {
            text = inflateSync(data.subarray(cursor)).toString('utf8');
          } catch {
            continue;
          }
        } else {
          text = data.subarray(cursor).toString('utf8');
        }
        texts.set(key, text);
      }
    }

    if (type === 'IEND') {
      break;
    }
  }

  return texts;
};

const isLikelySafetensors = (fileName?: string | null) =>
  typeof fileName === 'string' && fileName.trim().toLowerCase().endsWith('.safetensors');

export const extractImageMetadata = async (
  file: Pick<Express.Multer.File, 'buffer' | 'mimetype' | 'originalname'>,
): Promise<ImageMetadataResult> => {
  const result: ImageMetadataResult = { extras: {} };
  const { buffer } = file;

  try {
    const size = imageSize(buffer);
    if (typeof size.width === 'number' && !Number.isNaN(size.width) && size.width > 0) {
      result.width = size.width;
    }
    if (typeof size.height === 'number' && !Number.isNaN(size.height) && size.height > 0) {
      result.height = size.height;
    }
  } catch {
    // ignore invalid dimensions
  }

  if (file.mimetype === 'image/png' || extname(file.originalname ?? '').toLowerCase() === '.png') {
    const texts = extractPngText(buffer);
    for (const [key, value] of texts.entries()) {
      if (key.toLowerCase() === 'parameters') {
        mergeImageMetadata(result, parseStableDiffusionBlock(value));
        continue;
      }

      if (key.toLowerCase() === 'prompt' && !result.prompt) {
        result.prompt = value.trim() || null;
        continue;
      }

      if (key.toLowerCase() === 'negative prompt' && !result.negativePrompt) {
        result.negativePrompt = value.trim() || null;
        continue;
      }

      if (value.trim().startsWith('{') && value.trim().endsWith('}')) {
        try {
          const parsed = JSON.parse(value);
          mergeImageMetadata(result, parseJsonMetadata(parsed));
        } catch {
          // ignore malformed JSON
        }
        continue;
      }

      if (!result.extras) {
        result.extras = {};
      }
      result.extras[key] = value;
    }
  }

  try {
    const exif = await parseExif(buffer, {
      reviveValues: true,
      userComment: true,
      xmp: true,
      iptc: true,
    });

    if (exif && typeof exif === 'object') {
      const widthCandidate = (exif as { ImageWidth?: number }).ImageWidth;
      if (typeof widthCandidate === 'number' && !Number.isNaN(widthCandidate) && !result.width) {
        result.width = widthCandidate;
      }
      const heightCandidate = (exif as { ImageHeight?: number }).ImageHeight;
      if (typeof heightCandidate === 'number' && !Number.isNaN(heightCandidate) && !result.height) {
        result.height = heightCandidate;
      }

      const parameters =
        (exif as Record<string, unknown>).Parameters ??
        (exif as Record<string, unknown>).parameters ??
        (exif as Record<string, unknown>).UserComment ??
        (exif as Record<string, unknown>).Comment;

      if (typeof parameters === 'string') {
        mergeImageMetadata(result, parseStableDiffusionBlock(parameters));
      }

      if (typeof parameters === 'object' && parameters) {
        mergeImageMetadata(result, parseJsonMetadata(parameters));
      }

      if ((exif as Record<string, unknown>).prompt) {
        mergeImageMetadata(result, parseJsonMetadata(exif));
      }
    }
  } catch {
    // ignore parsing errors
  }

  if (!result.extras || Object.keys(result.extras).length === 0) {
    delete result.extras;
  }

  return result;
};

export const extractSafetensorsMetadata = (buffer: Buffer): SafetensorsMetadataResult => {
  if (buffer.length < 8) {
    return { metadata: {} };
  }

  const headerSize = Number(buffer.readBigUInt64LE(0));
  if (!Number.isSafeInteger(headerSize) || headerSize <= 0 || headerSize > buffer.length - 8) {
    return { metadata: {} };
  }

  const headerBuffer = buffer.subarray(8, 8 + headerSize);

  let parsed: unknown;
  try {
    parsed = JSON.parse(headerBuffer.toString('utf8')) as Record<string, unknown>;
  } catch {
    return { metadata: {} };
  }

  if (!parsed || typeof parsed !== 'object') {
    return { metadata: {} };
  }

  const record = parsed as Record<string, unknown>;
  const metadata: Record<string, unknown> = {};

  if (record.__metadata__ && typeof record.__metadata__ === 'object') {
    Object.assign(metadata, record.__metadata__ as Record<string, unknown>);
  }

  const nestedKeys = ['ss_metadata', 'metadata'];
  for (const key of nestedKeys) {
    const value = metadata[key];
    if (typeof value === 'string') {
      try {
        const parsedNested = JSON.parse(value);
        metadata[key] = parsedNested;
      } catch {
        // ignore invalid nested JSON
      }
    }
  }

  const aliases = new Set<string>();
  const candidateKeys = [
    'ss_base_model',
    'sshs_model_name',
    'base_model',
    'model',
    'model_name',
    'ss_training_model',
  ];

  for (const key of candidateKeys) {
    const value = metadata[key];
    const normalized = toNullableString(value);
    if (normalized) {
      aliases.add(normalized);
    }
  }

  const metadataModelAliases = metadata.model_names;
  if (Array.isArray(metadataModelAliases)) {
    for (const entry of metadataModelAliases) {
      const normalized = toNullableString(entry);
      if (normalized) {
        aliases.add(normalized);
      }
    }
  }

  if (metadata.ss_metadata && typeof metadata.ss_metadata === 'object') {
    const nested = metadata.ss_metadata as Record<string, unknown>;
    const nestedModel = toNullableString(nested.ssid_model_name ?? nested.model);
    if (nestedModel) {
      aliases.add(nestedModel);
    }
  }

  const aliasList = Array.from(aliases);
  const primary = aliasList[0] ?? null;

  const payload: SafetensorsMetadataResult = { metadata };

  if (primary) {
    payload.baseModel = primary;
    payload.modelName = primary;
  } else {
    payload.baseModel = null;
    payload.modelName = null;
  }

  if (aliasList.length > 0) {
    payload.modelAliases = aliasList;
  }

  return payload;
};

export const extractModelMetadataFromFile = (
  file: Pick<Express.Multer.File, 'buffer' | 'originalname'>,
): SafetensorsMetadataResult | null => {
  if (!isLikelySafetensors(file.originalname)) {
    return null;
  }

  return extractSafetensorsMetadata(file.buffer);
};
