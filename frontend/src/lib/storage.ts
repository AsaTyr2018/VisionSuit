import { buildApiUrl } from '../config';

const AUTH_STORAGE_KEY = 'visionsuit.auth.token';

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

export const buildStorageProxyUrl = (bucket?: string | null, objectName?: string | null) => {
  if (!bucket || !objectName) {
    return null;
  }

  const encodedBucket = encodeURIComponent(bucket);
  const encodedObject = objectName
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

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
