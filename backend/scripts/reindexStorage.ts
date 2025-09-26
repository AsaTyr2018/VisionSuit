import { prisma } from '../src/lib/prisma';
import { resolveStorageLocation, storageClient } from '../src/lib/storage';

const extractMetaValue = (meta: Record<string, string> | undefined, keys: string[]) => {
  if (!meta) {
    return null;
  }

  for (const key of keys) {
    const value = meta[key];
    if (value && value.length > 0) {
      return value;
    }

    const lowerKey = key.toLowerCase();
    const normalized = Object.keys(meta).find((entry) => entry.toLowerCase() === lowerKey);
    if (normalized) {
      const resolved = meta[normalized];
      if (resolved && resolved.length > 0) {
        return resolved;
      }
    }
  }

  return null;
};

type ReferenceDetail = {
  sourceType: string;
  sourceId: string;
  field: string;
  rawValue: string;
};

type StorageReference = {
  bucket: string;
  objectName: string;
  details: ReferenceDetail[];
};

const references = new Map<string, StorageReference>();

const registerReference = (detail: ReferenceDetail) => {
  const resolved = resolveStorageLocation(detail.rawValue);
  if (!resolved.bucket || !resolved.objectName) {
    return;
  }

  const key = `${resolved.bucket}/${resolved.objectName}`;
  const existing = references.get(key);

  if (existing) {
    existing.details.push(detail);
    return;
  }

  references.set(key, {
    bucket: resolved.bucket,
    objectName: resolved.objectName,
    details: [detail],
  });
};

const collectReferences = async () => {
  const [models, images, galleries, users] = await Promise.all([
    prisma.modelAsset.findMany({
      select: {
        id: true,
        storagePath: true,
        previewImage: true,
        versions: {
          select: {
            id: true,
            storagePath: true,
            previewImage: true,
          },
        },
      },
    }),
    prisma.imageAsset.findMany({
      select: {
        id: true,
        storagePath: true,
      },
    }),
    prisma.gallery.findMany({
      select: {
        id: true,
        coverImage: true,
      },
    }),
    prisma.user.findMany({
      select: {
        id: true,
        avatarUrl: true,
      },
    }),
  ]);

  for (const model of models) {
    if (model.storagePath) {
      registerReference({
        sourceType: 'model',
        sourceId: model.id,
        field: 'storagePath',
        rawValue: model.storagePath,
      });
    }
    if (model.previewImage) {
      registerReference({
        sourceType: 'model',
        sourceId: model.id,
        field: 'previewImage',
        rawValue: model.previewImage,
      });
    }

    for (const version of model.versions) {
      if (version.storagePath) {
        registerReference({
          sourceType: 'modelVersion',
          sourceId: version.id,
          field: 'storagePath',
          rawValue: version.storagePath,
        });
      }
      if (version.previewImage) {
        registerReference({
          sourceType: 'modelVersion',
          sourceId: version.id,
          field: 'previewImage',
          rawValue: version.previewImage,
        });
      }
    }
  }

  for (const image of images) {
    if (image.storagePath) {
      registerReference({
        sourceType: 'image',
        sourceId: image.id,
        field: 'storagePath',
        rawValue: image.storagePath,
      });
    }
  }

  for (const gallery of galleries) {
    if (gallery.coverImage) {
      registerReference({
        sourceType: 'gallery',
        sourceId: gallery.id,
        field: 'coverImage',
        rawValue: gallery.coverImage,
      });
    }
  }

  for (const user of users) {
    if (user.avatarUrl) {
      registerReference({
        sourceType: 'user',
        sourceId: user.id,
        field: 'avatarUrl',
        rawValue: user.avatarUrl,
      });
    }
  }
};

const syncStorageObject = async (reference: StorageReference) => {
  const detail = reference.details[0];
  try {
    const stat = await storageClient.statObject(reference.bucket, reference.objectName);
    const size = BigInt(stat.size);
    const contentType = extractMetaValue(stat.metaData, ['content-type', 'Content-Type']);
    const originalName =
      extractMetaValue(stat.metaData, ['original-name', 'x-amz-meta-original-name', 'filename']) ?? null;

    const existing = await prisma.storageObject.findUnique({ where: { id: reference.objectName } });

    if (!existing) {
      await prisma.storageObject.create({
        data: {
          id: reference.objectName,
          bucket: reference.bucket,
          objectName: reference.objectName,
          size,
          contentType: contentType ?? null,
          originalName,
        },
      });
      return 'created' as const;
    }

    const normalizedOriginalName = originalName ?? existing.originalName ?? null;
    const normalizedContentType = contentType ?? existing.contentType ?? null;
    const needsUpdate =
      existing.bucket !== reference.bucket ||
      existing.objectName !== reference.objectName ||
      (existing.size ? existing.size.toString() : null) !== size.toString() ||
      existing.contentType !== normalizedContentType ||
      existing.originalName !== normalizedOriginalName;

    if (!needsUpdate) {
      return 'skipped' as const;
    }

    await prisma.storageObject.update({
      where: { id: existing.id },
      data: {
        bucket: reference.bucket,
        objectName: reference.objectName,
        size,
        contentType: normalizedContentType,
        originalName: normalizedOriginalName,
      },
    });
    return 'updated' as const;
  } catch (error) {
    console.error(
      `Missing object ${reference.bucket}/${reference.objectName} (referenced by ${detail.sourceType} ${detail.sourceId} ${detail.field}): ${(error as Error).message}`,
    );
    return 'missing' as const;
  }
};

const main = async () => {
  await collectReferences();

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let missing = 0;

  for (const reference of references.values()) {
    const result = await syncStorageObject(reference);
    if (result === 'created') {
      created += 1;
    } else if (result === 'updated') {
      updated += 1;
    } else if (result === 'skipped') {
      skipped += 1;
    } else {
      missing += 1;
    }
  }

  console.log(
    `Reindex complete. Processed ${references.size} storage references (created: ${created}, updated: ${updated}, unchanged: ${skipped}, missing: ${missing}).`,
  );
};

main()
  .catch((error) => {
    console.error('Reindex failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
