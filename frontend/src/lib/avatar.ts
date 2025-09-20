import { buildApiUrl } from '../config';

const hasScheme = (value: string) => /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value);

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
    return trimmed;
  }

  const normalized = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  return buildApiUrl(normalized);
};
