import { Router } from 'express';

import { prisma } from '../lib/prisma';
import { resolveStorageLocation } from '../lib/storage';

export const galleriesRouter = Router();

galleriesRouter.get('/', async (_req, res, next) => {
  try {
    const galleries = await prisma.gallery.findMany({
      include: {
        owner: { select: { id: true, displayName: true, email: true } },
        entries: {
          include: {
            image: {
              include: {
                tags: { include: { tag: true } },
              },
            },
            asset: {
              include: {
                tags: { include: { tag: true } },
                owner: { select: { id: true, displayName: true } },
              },
            },
          },
          orderBy: { position: 'asc' },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    const response = galleries.map((gallery) => {
      const cover = resolveStorageLocation(gallery.coverImage);

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
        entries: gallery.entries.map((entry) => {
          const modelStorage = entry.asset ? resolveStorageLocation(entry.asset.storagePath) : null;
          const modelPreview = entry.asset ? resolveStorageLocation(entry.asset.previewImage) : null;
          const imageStorage = entry.image ? resolveStorageLocation(entry.image.storagePath) : null;

          return {
            id: entry.id,
            position: entry.position,
            note: entry.note,
            modelAsset: entry.asset
              ? {
                  ...entry.asset,
                  storagePath: modelStorage?.url ?? entry.asset.storagePath,
                  storageBucket: modelStorage?.bucket ?? null,
                  storageObject: modelStorage?.objectName ?? null,
                  previewImage: modelPreview?.url ?? entry.asset.previewImage,
                  previewImageBucket: modelPreview?.bucket ?? null,
                  previewImageObject: modelPreview?.objectName ?? null,
                  tags: entry.asset.tags.map(({ tag }) => tag),
                }
              : null,
            imageAsset: entry.image
              ? {
                  ...entry.image,
                  storagePath: imageStorage?.url ?? entry.image.storagePath,
                  storageBucket: imageStorage?.bucket ?? null,
                  storageObject: imageStorage?.objectName ?? null,
                  tags: entry.image.tags.map(({ tag }) => tag),
                }
              : null,
          };
        }),
      };
    });

    res.json(response);
  } catch (error) {
    next(error);
  }
});
