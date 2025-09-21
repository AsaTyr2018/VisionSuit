const resolveApiBase = () => {
  const rawValue = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
  const trimmed = rawValue.trim();

  const sameOriginTokens = new Set(['', '/', '@origin', 'origin', 'same-origin', 'relative']);
  if (sameOriginTokens.has(trimmed.toLowerCase())) {
    return '';
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/$/, '');
  }

  if (trimmed.startsWith('/')) {
    return trimmed.replace(/\/$/, '');
  }

  return trimmed.replace(/\/$/, '');
};

const resolveGeneratorBaseModelBucket = () => {
  const rawValue = import.meta.env.VITE_GENERATOR_BASE_MODEL_BUCKET;
  if (!rawValue) {
    return 'comfyui-models';
  }

  const trimmed = rawValue.trim();
  return trimmed.length > 0 ? trimmed : 'comfyui-models';
};

export const apiBaseUrl = resolveApiBase();
export const generatorBaseModelBucket = resolveGeneratorBaseModelBucket();

export const buildApiUrl = (path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (!apiBaseUrl) {
    return normalizedPath;
  }

  return `${apiBaseUrl}${normalizedPath}`;
};
