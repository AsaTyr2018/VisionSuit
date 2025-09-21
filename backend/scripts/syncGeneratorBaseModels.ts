import { Prisma, PrismaClient, UserRole } from '@prisma/client';

import '../src/config';

import { appConfig } from '../src/config';
import { storageClient } from '../src/lib/storage';
import { buildUniqueSlug } from '../src/lib/slug';

const prisma = new PrismaClient();

const deriveTitle = (objectName: string) => {
  const fileName = objectName.split('/').pop() ?? objectName;
  const withoutExtension = fileName.replace(/\.[^.]+$/, '');
  const spaced = withoutExtension.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();

  if (spaced.length === 0) {
    return fileName;
  }

  return spaced
    .split(' ')
    .filter((segment) => segment.length > 0)
    .map((segment) => segment[0]?.toUpperCase() + segment.slice(1))
    .join(' ');
};

const ensureOwner = async () => {
  const admin = await prisma.user.findFirst({
    where: { role: UserRole.ADMIN },
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, displayName: true },
  });

  if (!admin) {
    throw new Error('No admin user found. Create an admin account before syncing base models.');
  }

  return admin;
};

const normalizeMetadata = (
  current: Prisma.JsonValue | null | undefined,
  bucket: string,
  objectName: string,
): { payload: Prisma.JsonObject; changed: boolean } => {
  const base: Prisma.JsonObject =
    current && typeof current === 'object' && !Array.isArray(current) ? { ...(current as Prisma.JsonObject) } : {};

  let changed = false;

  if (base.generatorBaseModel !== true) {
    base.generatorBaseModel = true;
    changed = true;
  }

  if (base.sourceBucket !== bucket) {
    base.sourceBucket = bucket;
    changed = true;
  }

  if (base.sourceObject !== objectName) {
    base.sourceObject = objectName;
    changed = true;
  }

  return { payload: base, changed };
};

const main = async () => {
  const bucket = appConfig.generator.baseModelBucket.trim();
  if (!bucket) {
    throw new Error('GENERATOR_BASE_MODEL_BUCKET is not configured.');
  }

  const objects: Array<{ name: string; size: number }> = [];

  try {
    const stream = storageClient.listObjects(bucket, '', true);
    // eslint-disable-next-line no-restricted-syntax
    for await (const item of stream) {
      if (!item.name || item.name.endsWith('/')) {
        continue;
      }

      const size = typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0;
      objects.push({ name: item.name, size });
    }
  } catch (error) {
    throw new Error(
      `Failed to list objects from bucket "${bucket}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (objects.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`[sync-generator-base-models] No checkpoints found in bucket "${bucket}".`);
    return;
  }

  const storagePaths = objects.map((entry) => `s3://${bucket}/${entry.name}`);
  const existingAssets = await prisma.modelAsset.findMany({
    where: { storagePath: { in: storagePaths } },
    select: { id: true, storagePath: true, isPublic: true, ownerId: true, metadata: true },
  });
  const assetsByPath = new Map(existingAssets.map((asset) => [asset.storagePath, asset]));

  const owner = await ensureOwner();
  const checkpointTag = await prisma.tag.upsert({
    where: { label: 'checkpoint' },
    update: { category: 'model-type' },
    create: { label: 'checkpoint', category: 'model-type' },
    select: { id: true },
  });

  let createdCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;

  for (const entry of objects) {
    const storagePath = `s3://${bucket}/${entry.name}`;
    const existing = assetsByPath.get(storagePath);

    if (existing) {
      const updatePayload: Prisma.ModelAssetUpdateInput = {};
      if (!existing.isPublic) {
        updatePayload.isPublic = true;
      }
      if (existing.ownerId !== owner.id) {
        updatePayload.owner = { connect: { id: owner.id } };
      }

      const metadataResult = normalizeMetadata(existing.metadata, bucket, entry.name);
      if (metadataResult.changed) {
        updatePayload.metadata = metadataResult.payload;
      }

      if (Object.keys(updatePayload).length > 0) {
        await prisma.modelAsset.update({ where: { id: existing.id }, data: updatePayload });
        updatedCount += 1;
      } else {
        unchangedCount += 1;
      }
      continue;
    }

    const title = deriveTitle(entry.name);
    const slug = await buildUniqueSlug(
      title,
      async (candidate) => {
        const found = await prisma.modelAsset.findUnique({ where: { slug: candidate } });
        return Boolean(found);
      },
      'base-model',
    );

    await prisma.modelAsset.create({
      data: {
        slug,
        title,
        description: `Base checkpoint imported from ${bucket}/${entry.name}.`,
        version: '1.0.0',
        fileSize: entry.size > 0 ? entry.size : null,
        checksum: null,
        storagePath,
        previewImage: null,
        metadata: normalizeMetadata(null, bucket, entry.name).payload,
        isPublic: true,
        owner: { connect: { id: owner.id } },
        tags: { create: [{ tagId: checkpointTag.id }] },
      },
    });

    createdCount += 1;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[sync-generator-base-models] Created ${createdCount} checkpoint(s), updated ${updatedCount}, unchanged ${unchangedCount}.`,
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
