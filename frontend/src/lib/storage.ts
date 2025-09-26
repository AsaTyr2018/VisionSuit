import { buildApiUrl } from '../config';

const AUTH_STORAGE_KEY = 'visionsuit.auth.token';
const DEFAULT_CACHE_WINDOW_MS = 2 * 60 * 1000;

const readStoredToken = () => {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const value = window.localStorage.getItem(AUTH_STORAGE_KEY);
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
};

const appendQueryParam = (url: string, key: string, value: string) => {
  if (!value) {
    return url;
  }

  const [withoutHash, hashFragment] = url.split('#');
  const [path, search = ''] = withoutHash.split('?');
  const params = new URLSearchParams(search);
  params.set(key, value);
  const queryString = params.toString();
  const rebuilt = queryString.length > 0 ? `${path}?${queryString}` : path;

  return hashFragment ? `${rebuilt}#${hashFragment}` : rebuilt;
};

const normalizeTimestampToken = (value?: string | null) => {
  if (!value) {
    return null;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }

  return Math.floor(parsed / 1000).toString(36);
};

const computeCacheWindowToken = (cacheWindowMs: number) => {
  if (!Number.isFinite(cacheWindowMs) || cacheWindowMs <= 0) {
    return null;
  }

  return Math.floor(Date.now() / cacheWindowMs).toString(36);
};

export const appendAccessToken = (url?: string | null) => {
  if (!url) {
    return null;
  }

  const token = readStoredToken();
  if (!token) {
    return url;
  }

  const [withoutHash, hashFragment] = url.split('#');
  const separator = withoutHash.includes('?') ? '&' : '?';
  const nextUrl = `${withoutHash}${separator}accessToken=${encodeURIComponent(token)}`;
  return hashFragment ? `${nextUrl}#${hashFragment}` : nextUrl;
};

export interface ResolveCachedStorageOptions {
  updatedAt?: string | null;
  cacheWindowMs?: number;
  cacheKey?: string | null;
}

export const buildStorageProxyUrl = (bucket?: string | null, objectName?: string | null) => {
  if (!bucket || !objectName) {
    return null;
  }

  const encodedBucket = encodeURIComponent(bucket);
  const trimmedObjectName = objectName.trim();
  if (trimmedObjectName.length === 0) {
    return null;
  }

  const encodedObject = encodeURIComponent(trimmedObjectName);

  if (!encodedObject) {
    return null;
  }

  const baseUrl = buildApiUrl(`/api/storage/${encodedBucket}/${encodedObject}`);
  const token = readStoredToken();

  if (!token) {
    return baseUrl;
  }

  const separator = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${separator}accessToken=${encodeURIComponent(token)}`;
};

export const resolveStorageUrl = (fallback?: string | null, bucket?: string | null, objectName?: string | null) => {
  const proxied = buildStorageProxyUrl(bucket, objectName);
  if (proxied) {
    return proxied;
  }

  if (!fallback) {
    return undefined;
  }

  if (fallback.startsWith('http://') || fallback.startsWith('https://')) {
    return fallback;
  }

  if (fallback.startsWith('/')) {
    return buildApiUrl(fallback);
  }

  return fallback;
};

export const resolveCachedStorageUrl = (
  fallback?: string | null,
  bucket?: string | null,
  objectName?: string | null,
  { updatedAt, cacheWindowMs = DEFAULT_CACHE_WINDOW_MS, cacheKey }: ResolveCachedStorageOptions = {},
) => {
  const baseUrl = resolveStorageUrl(fallback, bucket, objectName);
  if (!baseUrl) {
    return undefined;
  }

  let nextUrl = baseUrl;

  const versionToken = cacheKey ?? normalizeTimestampToken(updatedAt);
  if (versionToken) {
    nextUrl = appendQueryParam(nextUrl, 'iv', versionToken);
  }

  const windowToken = computeCacheWindowToken(cacheWindowMs);
  if (windowToken) {
    nextUrl = appendQueryParam(nextUrl, 'ic', windowToken);
  }

  return nextUrl;
};

export const imageCacheWindowMs = DEFAULT_CACHE_WINDOW_MS;
