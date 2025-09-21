import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import type { AuthenticatedUser } from '../lib/auth';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../lib/middleware/auth';
import { resolveStorageLocation } from '../lib/storage';

export const galleriesRouter = Router();

type HydratedGallery = Prisma.GalleryGetPayload<{
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
            owner: { select: { id: true, displayName: true } };
          };
        };
      };
    };
  };
}>;

type HydratedGalleryImage = NonNullable<HydratedGallery['entries'][number]['image']>;

const canViewResource = (
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

const mapGalleryImageAsset = (image: HydratedGalleryImage) => {
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

const mapGallery = (
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

const noteTransformer = z
  .string()
  .trim()
  .max(600)
  .nullable()
  .transform((value) => {
    if (value == null) {
      return null;
    }

    return value.length > 0 ? value : null;
  });

const updateGallerySchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z
    .string()
    .trim()
    .max(1500)
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) {
        return null;
      }

      return value.length > 0 ? value : null;
    }),
  ownerId: z.string().trim().min(1).optional(),
  isPublic: z.boolean().optional(),
  coverImage: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .transform((value) => {
      if (value == null) {
        return value;
      }

      return value.length > 0 ? value : null;
    }),
  entries: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        position: z.number().int().min(0),
        note: noteTransformer.optional(),
      }),
    )
    .optional(),
  removeEntryIds: z.array(z.string().trim().min(1)).optional(),
});

galleriesRouter.get('/', async (req, res, next) => {
  try {
    const viewer = req.user;
    const isAdmin = viewer?.role === 'ADMIN';
    const galleries = await prisma.gallery.findMany({
      include: {
        owner: { select: { id: true, displayName: true, email: true } },
        entries: {
          include: {
            image: {
              include: {
                tags: { include: { tag: true } },
                owner: { select: { id: true, displayName: true, email: true } },
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

    const visibleGalleries = isAdmin
      ? galleries
      : galleries.filter((gallery) => {
          if (gallery.isPublic) {
            return true;
          }

          if (!viewer) {
            return false;
          }

          return gallery.ownerId === viewer.id;
        });

    const mapOptions: { viewer?: AuthenticatedUser; includePrivate?: boolean } = {};
    if (viewer) {
      mapOptions.viewer = viewer;
    }
    if (isAdmin) {
      mapOptions.includePrivate = true;
    }
    res.json(visibleGalleries.map((gallery) => mapGallery(gallery, mapOptions)));
  } catch (error) {
    next(error);
  }
});

galleriesRouter.put('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'Galerie-ID fehlt.' });
      return;
    }

    const parsed = updateGallerySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Übermittelte Daten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const gallery = await prisma.gallery.findUnique({
      where: { id },
      include: {
        owner: { select: { id: true, displayName: true, email: true } },
        entries: {
          include: {
            image: {
              include: {
                tags: { include: { tag: true } },
                owner: { select: { id: true, displayName: true, email: true } },
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
    });

    if (!gallery) {
      res.status(404).json({ message: 'Galerie wurde nicht gefunden.' });
      return;
    }

    const isAdmin = req.user.role === 'ADMIN';
    if (gallery.ownerId !== req.user.id && !isAdmin) {
      res.status(403).json({ message: 'Keine Berechtigung zur Bearbeitung dieser Galerie.' });
      return;
    }

    if (parsed.data.ownerId && parsed.data.ownerId !== gallery.ownerId && !isAdmin) {
      res.status(403).json({ message: 'Nur Administrator:innen können den Besitz ändern.' });
      return;
    }

    const removalIds = parsed.data.removeEntryIds
      ?.filter((entryId) => gallery.entries.some((entry) => entry.id === entryId))
      .map((entryId) => entryId) ?? [];

    const entryUpdates = parsed.data.entries?.filter((entry) =>
      gallery.entries.some((existing) => existing.id === entry.id),
    );

    const galleryUpdates: Prisma.GalleryUpdateInput = {};

    if (parsed.data.title) {
      galleryUpdates.title = parsed.data.title;
    }

    if (parsed.data.description !== undefined) {
      galleryUpdates.description = parsed.data.description;
    }

    if (parsed.data.isPublic !== undefined) {
      galleryUpdates.isPublic = parsed.data.isPublic;
    }

    if (parsed.data.coverImage !== undefined) {
      galleryUpdates.coverImage = parsed.data.coverImage;
    }

    if (parsed.data.ownerId && parsed.data.ownerId !== gallery.ownerId) {
      galleryUpdates.owner = { connect: { id: parsed.data.ownerId } };
    }

    const updated = await prisma.$transaction(async (tx) => {
      if (removalIds.length > 0) {
        await tx.galleryEntry.deleteMany({
          where: {
            galleryId: gallery.id,
            id: { in: removalIds },
          },
        });
      }

      if (entryUpdates && entryUpdates.length > 0) {
        for (const entry of entryUpdates) {
          const data: Prisma.GalleryEntryUpdateInput = {
            position: entry.position,
          };

          if (entry.note !== undefined) {
            data.note = entry.note;
          }

          await tx.galleryEntry.update({
            where: { id: entry.id },
            data,
          });
        }
      }

      const hasGalleryUpdates = Object.keys(galleryUpdates).length > 0;

      if (hasGalleryUpdates) {
        return tx.gallery.update({
          where: { id: gallery.id },
          data: galleryUpdates,
          include: {
            owner: { select: { id: true, displayName: true, email: true } },
            entries: {
          include: {
            image: {
              include: {
                tags: { include: { tag: true } },
                owner: { select: { id: true, displayName: true, email: true } },
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
        });
      }

      return tx.gallery.findUnique({
        where: { id: gallery.id },
        include: {
          owner: { select: { id: true, displayName: true, email: true } },
          entries: {
            include: {
              image: {
                include: {
                  tags: { include: { tag: true } },
                  owner: { select: { id: true, displayName: true, email: true } },
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
      });
    });

    if (!updated) {
      res.status(500).json({ message: 'Galerie konnte nicht aktualisiert werden.' });
      return;
    }

    res.json(mapGallery(updated, { viewer: req.user, includePrivate: true }));
  } catch (error) {
    next(error);
  }
});

galleriesRouter.delete('/:id', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'Galerie-ID fehlt.' });
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const gallery = await prisma.gallery.findUnique({
      where: { id },
      select: { id: true, ownerId: true },
    });

    if (!gallery) {
      res.status(404).json({ message: 'Galerie wurde nicht gefunden.' });
      return;
    }

    if (gallery.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      res.status(403).json({ message: 'Keine Berechtigung zum Löschen dieser Galerie.' });
      return;
    }

    await prisma.$transaction(async (tx) => {
      await tx.galleryEntry.deleteMany({ where: { galleryId: gallery.id } });
      await tx.gallery.delete({ where: { id: gallery.id } });
    });

    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
