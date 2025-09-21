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

export const apiBaseUrl = resolveApiBase();

export const buildApiUrl = (path: string) => {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  if (!apiBaseUrl) {
    return normalizedPath;
  }

  return `${apiBaseUrl}${normalizedPath}`;
};
