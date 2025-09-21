import type { Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import { resolveStorageLocation } from '../storage';

export type HydratedGalleryImage = Prisma.ImageAssetGetPayload<{
  include: {
    tags: { include: { tag: true } };
    owner: { select: { id: true; displayName: true; email: true } };
  };
}>;

type HydratedGalleryModel = Prisma.ModelAssetGetPayload<{
  include: {
    tags: { include: { tag: true } };
    owner: { select: { id: true; displayName: true } };
  };
}>;

type HydratedGalleryEntry = Prisma.GalleryEntryGetPayload<{
  include: {
    image: {
      include: {
        tags: { include: { tag: true } };
        owner: { select: { id: true; displayName: true; email: true } };
      };
    };
    asset: {
      include: {
        tags: { include: { tag: true } };
        owner: { select: { id: true; displayName: true } };
      };
    };
  };
}>;

export type HydratedGallery = Prisma.GalleryGetPayload<{
  include: {
    owner: { select: { id: true; displayName: true; email: true } };
    entries: {
      include: {
        image: {
          include: {
            tags: { include: { tag: true } };
            owner: { select: { id: true; displayName: true; email: true } };
          };
        };
        asset: {
          include: {
            tags: { include: { tag: true } };
            owner: { select: { id: true; displayName: true } };
          };
        };
      };
    };
  };
}>;

export const canViewResource = (
  viewer: AuthenticatedUser | undefined,
  ownerId: string,
  isPublic: boolean,
  options: { includePrivate?: boolean } = {},
) => {
  if (options.includePrivate) {
    return true;
  }

  if (isPublic) {
    return true;
  }

  if (!viewer) {
    return false;
  }

  return viewer.id === ownerId;
};

export const mapGalleryImageAsset = (image: HydratedGalleryImage) => {
  const storage = resolveStorageLocation(image.storagePath);

  return {
    id: image.id,
    title: image.title,
    description: image.description,
    isPublic: image.isPublic,
    dimensions: image.width && image.height ? { width: image.width, height: image.height } : undefined,
    fileSize: image.fileSize,
    storagePath: storage.url ?? image.storagePath,
    storageBucket: storage.bucket,
    storageObject: storage.objectName,
    prompt: image.prompt,
    negativePrompt: image.negativePrompt,
    metadata: {
      seed: image.seed,
      model: image.model,
      sampler: image.sampler,
      cfgScale: image.cfgScale,
      steps: image.steps,
    },
    owner: image.owner,
    tags: image.tags.map(({ tag }) => tag),
    createdAt: image.createdAt,
    updatedAt: image.updatedAt,
  };
};

export const mapGallery = (
  gallery: HydratedGallery,
  options: { viewer?: AuthenticatedUser; includePrivate?: boolean } = {},
) => {
  const cover = resolveStorageLocation(gallery.coverImage);
  const viewer = options.viewer;

  return {
    id: gallery.id,
    slug: gallery.slug,
    title: gallery.title,
    description: gallery.description,
    coverImage: cover.url ?? gallery.coverImage,
    coverImageBucket: cover.bucket,
    coverImageObject: cover.objectName,
    isPublic: gallery.isPublic,
    owner: gallery.owner,
    createdAt: gallery.createdAt,
    updatedAt: gallery.updatedAt,
    entries: gallery.entries
      .filter((entry) => {
        if (options.includePrivate) {
          return true;
        }

        const canViewAsset = entry.asset
          ? canViewResource(viewer, entry.asset.ownerId, entry.asset.isPublic, options)
          : false;
        const canViewImage = entry.image
          ? canViewResource(viewer, entry.image.ownerId, entry.image.isPublic, options)
          : false;

        return canViewAsset || canViewImage;
      })
      .map((entry) => {
        const modelStorage = entry.asset ? resolveStorageLocation(entry.asset.storagePath) : null;
        const modelPreview = entry.asset ? resolveStorageLocation(entry.asset.previewImage) : null;
        const canViewAsset = entry.asset
          ? canViewResource(viewer, entry.asset.ownerId, entry.asset.isPublic, options)
          : false;
        const canViewImage = entry.image
          ? canViewResource(viewer, entry.image.ownerId, entry.image.isPublic, options)
          : false;

        return {
          id: entry.id,
          position: entry.position,
          note: entry.note,
          modelAsset: entry.asset && (options.includePrivate || canViewAsset)
            ? {
                ...entry.asset,
                isPublic: entry.asset.isPublic,
                storagePath: modelStorage?.url ?? entry.asset.storagePath,
                storageBucket: modelStorage?.bucket ?? null,
                storageObject: modelStorage?.objectName ?? null,
                previewImage: modelPreview?.url ?? entry.asset.previewImage,
                previewImageBucket: modelPreview?.bucket ?? null,
                previewImageObject: modelPreview?.objectName ?? null,
                tags: entry.asset.tags.map(({ tag }) => tag),
              }
            : null,
          imageAsset: entry.image && (options.includePrivate || canViewImage)
            ? mapGalleryImageAsset(entry.image)
            : null,
        };
      }),
  };
};
