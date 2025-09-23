import { Client } from 'minio';
import type { ClientOptions } from 'minio';

import { appConfig } from '../config';

export const storageBuckets = {
  models: appConfig.storage.bucketModels,
  images: appConfig.storage.bucketImages,
  generatorWorkflows: appConfig.generator.workflow.bucket,
};

const clientOptions: ClientOptions = {
  endPoint: appConfig.storage.endpoint,
  port: appConfig.storage.port,
  useSSL: appConfig.storage.useSSL,
  accessKey: appConfig.storage.accessKey,
  secretKey: appConfig.storage.secretKey,
};

if (appConfig.storage.region) {
  clientOptions.region = appConfig.storage.region;
}

export const storageClient = new Client(clientOptions);

export const ensureBucketExists = async (bucket: string) => {
  const exists = await storageClient.bucketExists(bucket);
  if (exists) {
    return;
  }

  await storageClient.makeBucket(bucket, appConfig.storage.region);
};

export const initializeStorage = async () => {
  if (!appConfig.storage.autoCreateBuckets) {
    return;
  }

  const buckets = new Set(Object.values(storageBuckets));

  for (const bucket of buckets) {
    try {
      await ensureBucketExists(bucket);
    } catch (error) {
      throw new Error(`Failed to ensure MinIO bucket "${bucket}": ${(error as Error).message}`);
    }
  }
};

const encodeObjectName = (objectName: string) =>
  objectName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

export const getObjectUrl = (bucket: string, objectName: string) => {
  const baseUrl = appConfig.storage.publicUrl.replace(/\/$/, '');
  return `${baseUrl}/${bucket}/${encodeObjectName(objectName)}`;
};

export interface StorageLocation {
  bucket: string | null;
  objectName: string | null;
  url: string | null;
}

const normalizedPublicUrl = appConfig.storage.publicUrl.replace(/\/+$/, '');

const publicUrlComponents = (() => {
  try {
    const parsed = new URL(normalizedPublicUrl);
    return {
      origin: parsed.origin,
      pathname: parsed.pathname.replace(/\/$/, ''),
    };
  } catch (error) {
    console.warn('Failed to parse storage public URL for resolution logic', error);
    return null;
  }
})();

const tryResolveFromPublicHttpUrl = (value: string): StorageLocation | null => {
  if (!publicUrlComponents) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    return null;
  }

  if (parsed.origin !== publicUrlComponents.origin) {
    return null;
  }

  const basePath = publicUrlComponents.pathname;
  let objectPath = parsed.pathname;

  if (basePath && basePath.length > 0) {
    if (!objectPath.startsWith(basePath)) {
      return null;
    }

    objectPath = objectPath.slice(basePath.length);
  }

  objectPath = objectPath.replace(/^\/+/, '');

  if (objectPath.length === 0) {
    return null;
  }

  const [bucket, ...rest] = objectPath.split('/');

  if (!bucket || rest.length === 0) {
    return null;
  }

  const decodedSegments: string[] = [];
  for (const segment of rest) {
    try {
      decodedSegments.push(decodeURIComponent(segment));
    } catch (error) {
      return null;
    }
  }

  const objectName = decodedSegments.join('/');
  return { bucket, objectName, url: value };
};

export const resolveStorageLocation = (value?: string | null): StorageLocation => {
  if (!value) {
    return { bucket: null, objectName: null, url: null };
  }

  if (value.startsWith('s3://')) {
    const withoutScheme = value.slice('s3://'.length);
    const [bucket, ...rest] = withoutScheme.split('/');
    const objectName = rest.join('/');

    if (!bucket || !objectName) {
      return { bucket: null, objectName: null, url: value };
    }

    return { bucket, objectName, url: getObjectUrl(bucket, objectName) };
  }

  if (value.startsWith('http://') || value.startsWith('https://')) {
    const resolved = tryResolveFromPublicHttpUrl(value);
    if (resolved) {
      return resolved;
    }

    return { bucket: null, objectName: null, url: value };
  }

  return { bucket: null, objectName: value, url: `${appConfig.storage.publicUrl.replace(/\/$/, '')}/${value.replace(/^\//, '')}` };
};
