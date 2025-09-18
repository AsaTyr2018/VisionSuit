import { Router } from 'express';

import { prisma } from '../lib/prisma';

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

    const response = galleries.map((gallery) => ({
      id: gallery.id,
      slug: gallery.slug,
      title: gallery.title,
      description: gallery.description,
      coverImage: gallery.coverImage,
      isPublic: gallery.isPublic,
      owner: gallery.owner,
      createdAt: gallery.createdAt,
      updatedAt: gallery.updatedAt,
      entries: gallery.entries.map((entry) => ({
        id: entry.id,
        position: entry.position,
        note: entry.note,
        modelAsset: entry.asset
          ? {
              ...entry.asset,
              tags: entry.asset.tags.map(({ tag }) => tag),
            }
          : null,
        imageAsset: entry.image
          ? {
              ...entry.image,
              tags: entry.image.tags.map(({ tag }) => tag),
            }
          : null,
      })),
    }));

    res.json(response);
  } catch (error) {
    next(error);
  }
});
