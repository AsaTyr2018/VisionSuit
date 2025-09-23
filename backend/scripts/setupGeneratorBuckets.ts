import { Client } from 'minio';

import { appConfig } from '../src/config';

const normalizeBucketName = (candidate?: string | null): string | null => {
  if (!candidate) {
    return null;
  }

  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }

  return trimmed.replace(/^s3:\/\//i, '').replace(/\/+$/, '');
};

const bucketEntries = [
  { name: appConfig.storage.bucketModels, description: 'Model catalog assets' },
  { name: appConfig.storage.bucketImages, description: 'User-uploaded imagery' },
  { name: appConfig.generator.output.bucket, description: 'Generator output artifacts' },
  { name: appConfig.generator.workflow.bucket, description: 'Generator workflow templates' },
];

const normalizedBaseModelBucket = normalizeBucketName(appConfig.generator.baseModelBucket);
if (normalizedBaseModelBucket) {
  bucketEntries.push({ name: normalizedBaseModelBucket, description: 'GPU base model repository' });
}

const uniqueBuckets = bucketEntries.reduce<Array<{ name: string; description: string }>>((accumulator, entry) => {
  const normalized = normalizeBucketName(entry.name);
  if (!normalized) {
    return accumulator;
  }

  if (accumulator.some((existing) => existing.name === normalized)) {
    return accumulator;
  }

  accumulator.push({ name: normalized, description: entry.description });
  return accumulator;
}, []);

if (uniqueBuckets.length === 0) {
  // eslint-disable-next-line no-console
  console.log('No buckets configured – exiting.');
  process.exit(0);
}

const client = new Client({
  endPoint: appConfig.storage.endpoint,
  port: appConfig.storage.port,
  useSSL: appConfig.storage.useSSL,
  accessKey: appConfig.storage.accessKey,
  secretKey: appConfig.storage.secretKey,
  region: appConfig.storage.region ?? undefined,
});

const ensureBucket = async (bucket: { name: string; description: string }) => {
  const exists = await client.bucketExists(bucket.name);
  if (exists) {
    // eslint-disable-next-line no-console
    console.log(`✔ Bucket "${bucket.name}" already exists (${bucket.description}).`);
    return;
  }

  if (appConfig.storage.region) {
    await client.makeBucket(bucket.name, appConfig.storage.region);
  } else {
    await client.makeBucket(bucket.name);
  }

  // eslint-disable-next-line no-console
  console.log(`➕ Created bucket "${bucket.name}" (${bucket.description}).`);
};

const run = async () => {
  for (const bucket of uniqueBuckets) {
    try {
      await ensureBucket(bucket);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error(`Failed to ensure bucket "${bucket.name}":`, error);
      process.exitCode = 1;
      return;
    }
  }
};

void run();
