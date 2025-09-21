import { buildApiUrl } from '../config';

const hasScheme = (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);

const isLoopbackHostname = (hostname: string) => {
  const normalized = hostname.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized === 'localhost' || normalized === '::1' || normalized === '0.0.0.0') {
    return true;
  }

  if (normalized.startsWith('127.')) {
    return true;
  }

  return false;
};

export const resolveAvatarUrl = (value: string | null | undefined, userId?: string | null) => {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith('s3://')) {
    if (!userId) {
      return null;
    }

    return buildApiUrl(`/api/users/${encodeURIComponent(userId)}/avatar`);
  }

  if (hasScheme(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      if (isLoopbackHostname(parsed.hostname)) {
        const route = `${parsed.pathname}${parsed.search}`;
        const normalizedRoute = route.startsWith('/') ? route : `/${route}`;
        return buildApiUrl(normalizedRoute);
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.warn('Failed to parse avatar URL', error);
      }
      return trimmed;
    }

    return trimmed;
  }

  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return buildApiUrl(normalized);
};
