import { PrismaClient } from '@prisma/client';

import '../src/config';

import { appConfig } from '../src/config';
import {
  listGeneratorBaseModelObjects,
  syncGeneratorBaseModels,
} from '../src/lib/generator/baseModelSync';

const prisma = new PrismaClient();

const main = async () => {
  const bucket = appConfig.generator.baseModelBucket.trim();
  if (!bucket) {
    throw new Error('GENERATOR_BASE_MODEL_BUCKET is not configured.');
  }

  const objects = await listGeneratorBaseModelObjects(bucket);
  if (objects.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[sync-generator-base-models] No checkpoints found in bucket "${bucket}".`);
    return;
  }

  const result = await syncGeneratorBaseModels({ prisma, bucket, objects });

  // eslint-disable-next-line no-console
  console.log(
    `[sync-generator-base-models] Created ${result.created} checkpoint(s), updated ${result.updated}, unchanged ${result.unchanged}.`,
  );
};

main()
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error('[sync-generator-base-models] Failed to synchronize base models:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
