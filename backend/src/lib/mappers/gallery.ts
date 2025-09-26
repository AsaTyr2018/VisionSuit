import { ModerationStatus, Prisma } from '@prisma/client';

import type { AuthenticatedUser } from '../auth';
import { resolveStorageLocation } from '../storage';

const baseGalleryImageInclude = Prisma.validator<Prisma.ImageAssetInclude>()({
  tags: { include: { tag: true } },
  owner: { select: { id: true, displayName: true, email: true } },
  _count: { select: { likes: true } },
});

const baseGalleryAssetInclude = Prisma.validator<Prisma.ModelAssetInclude>()({
  tags: { include: { tag: true } },
  owner: { select: { id: true, displayName: true } },
});

const buildViewerGalleryImageInclude = (viewerId: string) =>
  Prisma.validator<Prisma.ImageAssetInclude>()({
    ...baseGalleryImageInclude,
    likes: {
      where: { userId: viewerId },
      select: { userId: true },
    },
  });

export const buildGalleryInclude = (viewerId?: string | null) =>
  Prisma.validator<Prisma.GalleryInclude>()({
    owner: { select: { id: true, displayName: true, email: true } },
    entries: {
      include: {
        image: {
          include: viewerId ? buildViewerGalleryImageInclude(viewerId) : baseGalleryImageInclude,
        },
        asset: { include: baseGalleryAssetInclude },
      },
      orderBy: { position: 'asc' },
    },
  });

export type HydratedGalleryImage = Prisma.ImageAssetGetPayload<{
  include: {
    tags: { include: { tag: true } };
    owner: { select: { id: true; displayName: true; email: true } };
    _count: { select: { likes: true } };
  };
}> & { likes?: { userId: string }[] };

type HydratedGalleryModel = Prisma.ModelAssetGetPayload<{
  include: {
    tags: { include: { tag: true } };
    owner: { select: { id: true; displayName: true } };
  };
}>;

type HydratedGalleryEntry =
  Prisma.GalleryEntryGetPayload<{
    include: {
      image: {
        include: {
          tags: { include: { tag: true } };
          owner: { select: { id: true; displayName: true; email: true } };
          _count: { select: { likes: true } };
        };
      };
      asset: {
        include: {
          tags: { include: { tag: true } };
          owner: { select: { id: true; displayName: true } };
        };
      };
    };
  }> & {
    image: HydratedGalleryImage | null;
    asset: HydratedGalleryModel | null;
  };

export type HydratedGallery =
  Prisma.GalleryGetPayload<{
    include: {
      owner: { select: { id: true; displayName: true; email: true } };
      entries: {
        include: {
          image: {
            include: {
              tags: { include: { tag: true } };
              owner: { select: { id: true; displayName: true; email: true } };
              _count: { select: { likes: true } };
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
  }> & { entries: HydratedGalleryEntry[] };

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

export const mapGalleryImageAsset = (
  image: HydratedGalleryImage,
  options: { viewerId?: string | null } = {},
) => {
  const storage = resolveStorageLocation(image.storagePath);
  const viewerId = options.viewerId;
  const likeCount = image._count?.likes ?? 0;
  const viewerHasLiked = viewerId ? (image.likes ?? []).some((entry) => entry.userId === viewerId) : false;

  return {
    id: image.id,
    title: image.title,
    description: image.description,
    isPublic: image.isPublic,
    isAdult: image.isAdult,
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
    likeCount,
    viewerHasLiked,
  };
};

export const mapGallery = (
  gallery: HydratedGallery,
  options: { viewer?: AuthenticatedUser; includePrivate?: boolean } = {},
) => {
  const cover = resolveStorageLocation(gallery.coverImage);
  const viewer = options.viewer;
  const viewerId = viewer?.id ?? null;
  const isAdmin = viewer?.role === 'ADMIN';
  const allowAdultContent = viewer?.showAdultContent ?? false;
  const hasFlaggedEntry = gallery.entries.some(
    (entry) =>
      (entry.asset && entry.asset.moderationStatus === ModerationStatus.FLAGGED) ||
      (entry.image && entry.image.moderationStatus === ModerationStatus.FLAGGED),
  );

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
    isUnderModeration: hasFlaggedEntry,
    entries: gallery.entries
      .filter((entry) => {
        const ownsAsset = entry.asset ? entry.asset.ownerId === viewerId : false;
        const ownsImage = entry.image ? entry.image.ownerId === viewerId : false;
        const viewerOwnsEntry = ownsAsset || ownsImage;

        const adultAllowed =
          viewerOwnsEntry ||
          allowAdultContent ||
          ((entry.asset ? !entry.asset.isAdult : true) && (entry.image ? !entry.image.isAdult : true));

        if (!adultAllowed) {
          return false;
        }

        if (options.includePrivate) {
          return true;
        }

        const assetVisible = entry.asset
          ? (ownsAsset || entry.asset.moderationStatus !== ModerationStatus.REMOVED) &&
            (!entry.asset.isAdult || allowAdultContent || ownsAsset) &&
            (entry.asset.moderationStatus !== ModerationStatus.FLAGGED || isAdmin || ownsAsset)
          : false;
        const imageVisible = entry.image
          ? (ownsImage || entry.image.moderationStatus !== ModerationStatus.REMOVED) &&
            (!entry.image.isAdult || allowAdultContent || ownsImage) &&
            (entry.image.moderationStatus !== ModerationStatus.FLAGGED || isAdmin || ownsImage)
          : false;

        const canViewAsset = assetVisible
          ? canViewResource(viewer, entry.asset!.ownerId, entry.asset!.isPublic, options)
          : false;
        const canViewImage = imageVisible
          ? canViewResource(viewer, entry.image!.ownerId, entry.image!.isPublic, options)
          : false;

        return canViewAsset || canViewImage || viewerOwnsEntry;
      })
      .map((entry) => {
        const modelStorage = entry.asset ? resolveStorageLocation(entry.asset.storagePath) : null;
        const modelPreview = entry.asset ? resolveStorageLocation(entry.asset.previewImage) : null;
        const ownsAsset = entry.asset ? entry.asset.ownerId === viewerId : false;
        const ownsImage = entry.image ? entry.image.ownerId === viewerId : false;
        const assetVisible = entry.asset
          ? (ownsAsset || entry.asset.moderationStatus !== ModerationStatus.REMOVED) &&
            (!entry.asset.isAdult || allowAdultContent || ownsAsset) &&
            (entry.asset.moderationStatus !== ModerationStatus.FLAGGED || isAdmin || ownsAsset)
          : false;
        const imageVisible = entry.image
          ? (ownsImage || entry.image.moderationStatus !== ModerationStatus.REMOVED) &&
            (!entry.image.isAdult || allowAdultContent || ownsImage) &&
            (entry.image.moderationStatus !== ModerationStatus.FLAGGED || isAdmin || ownsImage)
          : false;
        const canViewAsset = assetVisible
          ? canViewResource(viewer, entry.asset!.ownerId, entry.asset!.isPublic, options)
          : false;
        const canViewImage = imageVisible
          ? canViewResource(viewer, entry.image!.ownerId, entry.image!.isPublic, options)
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
            ? mapGalleryImageAsset(entry.image, { viewerId })
            : null,
        };
      }),
  };
};
