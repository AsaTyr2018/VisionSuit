import { buildApiUrl } from '../config';

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

  return buildApiUrl(`/api/storage/${encodedBucket}/${encodedObject}`);
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
