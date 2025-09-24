import path from 'node:path';

export type LoraSelectionForContext = { strength: number | null | undefined };
export type LoraExtraForContext = Record<string, unknown>;

const normalizeStrength = (value: number | null | undefined): number => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return 1;
  }

  if (!Number.isFinite(value)) {
    return 1;
  }

  const clamped = Math.max(-2, Math.min(2, value));
  return Number.parseFloat(clamped.toFixed(2));
};

const extractFilename = (payload: LoraExtraForContext): string | null => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const filenameRaw = payload.filename;
  if (typeof filenameRaw === 'string' && filenameRaw.trim().length > 0) {
    const normalized = path.basename(filenameRaw.trim());
    if (normalized.length > 0) {
      return normalized;
    }
  }

  const keyRaw = payload.key;
  if (typeof keyRaw === 'string' && keyRaw.trim().length > 0) {
    const normalized = path.basename(keyRaw.trim());
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return null;
};

export const derivePrimaryLoraContext = (
  selections: LoraSelectionForContext[],
  payloads: LoraExtraForContext[],
): Record<string, unknown> => {
  if (!Array.isArray(payloads) || payloads.length === 0) {
    return {};
  }

  const firstPayload = payloads[0];
  if (!firstPayload) {
    return {};
  }

  const filename = extractFilename(firstPayload);
  if (!filename) {
    return {};
  }

  const firstSelection = selections[0];
  const strength = normalizeStrength(firstSelection?.strength ?? null);

  return {
    primary_lora_name: filename,
    primary_lora_strength_model: strength,
    primary_lora_strength_clip: strength,
  };
};

export const mergeLoraExtras = (
  selections: LoraSelectionForContext[],
  payloads: LoraExtraForContext[],
): Record<string, unknown> => ({
  ...(payloads.length > 0 ? { loras: payloads } : {}),
  ...derivePrimaryLoraContext(selections, payloads),
});
