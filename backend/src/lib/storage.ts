import { Client } from 'minio';
import type { ClientOptions } from 'minio';

import { appConfig } from '../config';

export const storageBuckets = {
  models: appConfig.storage.bucketModels,
  images: appConfig.storage.bucketImages,
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

const ensureBucket = async (bucket: string) => {
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
      await ensureBucket(bucket);
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
