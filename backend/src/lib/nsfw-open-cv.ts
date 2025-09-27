import sharp from 'sharp';
import type { Prisma } from '@prisma/client';

export type ModerationClassification = 'CLOTHED' | 'SWIMWEAR' | 'NUDE' | 'BORDERLINE';

export interface ImageModerationSummary {
  engine: 'opencv-heuristic-v1';
  version: number;
  analyzedAt: string;
  sampleWidth: number;
  sampleHeight: number;
  skinRatio: number;
  torsoSkinRatio: number;
  torsoNonSkinRatio: number;
  garmentScore: number;
  adultScore: number;
  suggestiveScore: number;
  classification: ModerationClassification;
  reasons: string[];
}

type NumericLike = number | null | undefined;

const clamp = (value: number, min = 0, max = 1) => {
  if (Number.isNaN(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
};

const toNumber = (value: unknown, fallback = 0) => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
};

const isClassification = (value: unknown): value is ModerationClassification =>
  value === 'CLOTHED' || value === 'SWIMWEAR' || value === 'NUDE' || value === 'BORDERLINE';

const rgbToYCrCb = (r: number, g: number, b: number) => {
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 + (-0.168736 * r - 0.331264 * g + 0.5 * b);
  const cr = 128 + (0.5 * r - 0.418688 * g - 0.081312 * b);
  return { y, cb, cr };
};

const rgbToHsv = (r: number, g: number, b: number) => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;

  let h = 0;
  if (delta !== 0) {
    if (max === rn) {
      h = ((gn - bn) / delta) % 6;
    } else if (max === gn) {
      h = (bn - rn) / delta + 2;
    } else {
      h = (rn - gn) / delta + 4;
    }
    h *= 60;
    if (h < 0) {
      h += 360;
    }
  }

  const s = max === 0 ? 0 : delta / max;
  const v = max;

  return { h: h / 360, s, v };
};

const isSkinPixel = (y: number, cr: number, cb: number, h: number, s: number, v: number) => {
  const yValid = y > 40 && y < 240;
  const crValid = cr > 135 && cr < 180;
  const cbValid = cb > 85 && cb < 135;
  const hsvHueValid = h >= 0 && h <= 0.17;
  const hsvSatValid = s >= 0.23 && s <= 0.68;
  const hsvValValid = v >= 0.35;
  return yValid && crValid && cbValid && hsvHueValid && hsvSatValid && hsvValValid;
};

const SKIN_SAMPLE_WIDTH = 360;

export const analyzeImageModeration = async (buffer: Buffer): Promise<ImageModerationSummary> => {
  const { data, info } = await sharp(buffer)
    .rotate()
    .resize({ width: SKIN_SAMPLE_WIDTH, height: SKIN_SAMPLE_WIDTH, fit: 'inside', withoutEnlargement: true })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const width = info.width;
  const height = info.height;
  const channels = info.channels;
  const totalPixels = width * height;

  let skinCount = 0;
  let torsoSkinCount = 0;
  let torsoNonSkinCount = 0;
  let vividNonSkinCount = 0;
  let satSum = 0;
  let valueSum = 0;
  let hueVectorX = 0;
  let hueVectorY = 0;

  const torsoLeft = Math.floor(width * 0.22);
  const torsoRight = Math.ceil(width * 0.78);
  const torsoTop = Math.floor(height * 0.28);
  const torsoBottom = Math.ceil(height * 0.9);
  const torsoPixels = Math.max(1, (torsoRight - torsoLeft) * (torsoBottom - torsoTop));

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * channels;
      const r = data[offset] ?? 0;
      const g = data[offset + 1] ?? 0;
      const b = data[offset + 2] ?? 0;

      const { y: yChannel, cr, cb } = rgbToYCrCb(r, g, b);
      const { h, s, v } = rgbToHsv(r, g, b);
      const skin = isSkinPixel(yChannel, cr, cb, h, s, v);

      if (skin) {
        skinCount += 1;
      }

      const inTorso = x >= torsoLeft && x < torsoRight && y >= torsoTop && y < torsoBottom;
      if (!inTorso) {
        continue;
      }

      if (skin) {
        torsoSkinCount += 1;
        continue;
      }

      torsoNonSkinCount += 1;
      if (s > 0.2 && v > 0.25) {
        vividNonSkinCount += 1;
        satSum += s;
        valueSum += v;
        const angle = h * Math.PI * 2;
        hueVectorX += Math.cos(angle);
        hueVectorY += Math.sin(angle);
      }
    }
  }

  const skinRatio = clamp(skinCount / totalPixels);
  const torsoSkinRatio = clamp(torsoSkinCount / torsoPixels);
  const torsoNonSkinRatio = clamp(torsoNonSkinCount / torsoPixels);
  const vividRatio = vividNonSkinCount > 0 ? vividNonSkinCount / torsoPixels : 0;
  const saturationMean = vividNonSkinCount > 0 ? satSum / vividNonSkinCount : 0;
  const valueMean = vividNonSkinCount > 0 ? valueSum / vividNonSkinCount : 0;
  const hueMagnitude = vividNonSkinCount > 0 ? Math.sqrt(hueVectorX ** 2 + hueVectorY ** 2) / vividNonSkinCount : 0;
  const hueDispersion = clamp(1 - hueMagnitude, 0, 1);

  const garmentScore = clamp(
    (torsoNonSkinRatio - 0.18) * 1.9 + saturationMean * 0.8 + valueMean * 0.4 + hueDispersion * 0.6,
  );

  let adultScore = clamp(torsoSkinRatio * 0.9 + skinRatio * 0.45 - garmentScore * 0.7);
  if (torsoSkinRatio > 0.72 && torsoNonSkinRatio < 0.22) {
    adultScore = Math.max(adultScore, 0.88);
  }
  if (skinRatio > 0.5 && torsoSkinRatio > 0.6 && garmentScore < 0.3) {
    adultScore = Math.max(adultScore, 0.82);
  }

  let classification: ModerationClassification;
  if (skinRatio < 0.12 || torsoSkinRatio < 0.28) {
    classification = 'CLOTHED';
  } else if (adultScore >= 0.78 && torsoNonSkinRatio < 0.24) {
    classification = 'NUDE';
  } else if (garmentScore >= 0.45 && torsoNonSkinRatio >= 0.2) {
    classification = 'SWIMWEAR';
    adultScore = Math.min(adultScore, 0.45);
  } else {
    classification = 'BORDERLINE';
  }

  let suggestiveScore = clamp(skinRatio * 1.1 + torsoSkinRatio * 0.4 + garmentScore * 0.25);
  if (classification === 'NUDE') {
    suggestiveScore = Math.max(suggestiveScore, 0.9);
  } else if (classification === 'SWIMWEAR') {
    suggestiveScore = Math.max(suggestiveScore, 0.7);
  }

  const reasons: string[] = [];
  if (classification === 'NUDE') {
    reasons.push('Torso skin coverage exceeded 60% with minimal garment signals.');
  } else if (classification === 'SWIMWEAR') {
    reasons.push('Detected saturated non-skin clusters across the torso indicative of swimwear.');
  } else if (classification === 'CLOTHED') {
    reasons.push('Skin coverage remained below 20% of sampled pixels.');
  } else {
    reasons.push('Skin coverage was high but garment indicators were inconclusive.');
  }

  return {
    engine: 'opencv-heuristic-v1',
    version: 1,
    analyzedAt: new Date().toISOString(),
    sampleWidth: width,
    sampleHeight: height,
    skinRatio,
    torsoSkinRatio,
    torsoNonSkinRatio,
    garmentScore,
    adultScore,
    suggestiveScore,
    classification,
    reasons,
  };
};

export const normalizeModerationSummary = (
  value: Prisma.JsonValue | null | undefined,
): ImageModerationSummary | null => {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const record = value as Record<string, unknown>;
  const classificationRaw = record.classification;
  const classification = isClassification(classificationRaw) ? classificationRaw : 'BORDERLINE';
  const reasonsSource = Array.isArray(record.reasons) ? record.reasons : [];
  const reasons = reasonsSource.filter((entry): entry is string => typeof entry === 'string');

  return {
    engine: typeof record.engine === 'string' ? (record.engine as 'opencv-heuristic-v1') : 'opencv-heuristic-v1',
    version: toNumber(record.version, 1),
    analyzedAt: typeof record.analyzedAt === 'string' ? record.analyzedAt : new Date(0).toISOString(),
    sampleWidth: toNumber(record.sampleWidth, 0),
    sampleHeight: toNumber(record.sampleHeight, 0),
    skinRatio: clamp(toNumber(record.skinRatio, 0)),
    torsoSkinRatio: clamp(toNumber(record.torsoSkinRatio, 0)),
    torsoNonSkinRatio: clamp(toNumber(record.torsoNonSkinRatio, 0)),
    garmentScore: clamp(toNumber(record.garmentScore, 0)),
    adultScore: clamp(toNumber(record.adultScore, 0)),
    suggestiveScore: clamp(toNumber(record.suggestiveScore, 0)),
    classification,
    reasons,
  };
};

export const serializeModerationSummary = (
  summary: ImageModerationSummary | null | undefined,
): Prisma.JsonValue | null => {
  if (!summary) {
    return null;
  }

  return {
    engine: summary.engine,
    version: summary.version,
    analyzedAt: summary.analyzedAt,
    sampleWidth: summary.sampleWidth,
    sampleHeight: summary.sampleHeight,
    skinRatio: summary.skinRatio,
    torsoSkinRatio: summary.torsoSkinRatio,
    torsoNonSkinRatio: summary.torsoNonSkinRatio,
    garmentScore: summary.garmentScore,
    adultScore: summary.adultScore,
    suggestiveScore: summary.suggestiveScore,
    classification: summary.classification,
    reasons: [...summary.reasons],
  } as Prisma.JsonObject;
};

export const collectModerationSummaries = (
  sources: Array<Prisma.JsonValue | null | undefined>,
): ImageModerationSummary[] => {
  const candidates: Array<Prisma.JsonValue | null | undefined> = [];

  for (const entry of sources) {
    candidates.push(entry);
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Record<string, Prisma.JsonValue>;
      if (record.moderation !== undefined) {
        candidates.push(record.moderation);
      }
    }
  }

  return candidates
    .map((candidate) => normalizeModerationSummary(candidate))
    .filter((summary): summary is ImageModerationSummary => Boolean(summary));
};
