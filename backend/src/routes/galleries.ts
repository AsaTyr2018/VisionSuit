import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import type { AuthenticatedUser } from '../lib/auth';
import { detectImageFormat, isStaticImageFormat, staticImageMimeTypes } from '../lib/image-format';
import { prisma } from '../lib/prisma';
import { requireAuth } from '../lib/middleware/auth';
import {
  canViewResource,
  HydratedGallery,
  HydratedGalleryImage,
  mapGallery,
  mapGalleryImageAsset,
} from '../lib/mappers/gallery';
import { resolveStorageLocation, storageBuckets, storageClient } from '../lib/storage';

export const galleriesRouter = Router();

const MAX_GALLERY_COVER_SIZE_BYTES = 8 * 1024 * 1024;

const coverUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: MAX_GALLERY_COVER_SIZE_BYTES,
  },
});

const galleryInclude = {
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
} satisfies Prisma.GalleryInclude;

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
      include: galleryInclude,
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
          include: galleryInclude,
        });
      }

      return tx.gallery.findUnique({
        where: { id: gallery.id },
        include: galleryInclude,
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

galleriesRouter.post('/:id/cover', requireAuth, (req, res, next) => {
  coverUpload.single('cover')(req, res, async (error: unknown) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ message: 'Cover exceeds the 8 MB limit.' });
          return;
        }

        res.status(400).json({ message: `Cover upload failed: ${error.message}` });
        return;
      }

      next(error instanceof Error ? error : new Error('Unexpected cover upload error.'));
      return;
    }

    try {
      const { id } = req.params;

      if (!id) {
        res.status(400).json({ message: 'Galerie-ID fehlt.' });
        return;
      }

      const file = req.file as Express.Multer.File | undefined;
      if (!file) {
        res.status(400).json({ message: 'Kein Cover-Bild gefunden.' });
        return;
      }

      if (file.size === 0) {
        res.status(400).json({ message: 'Cover-Datei ist leer.' });
        return;
      }

      const format = detectImageFormat(file.buffer);
      if (!format) {
        res.status(400).json({ message: 'Cover muss als PNG, JPEG oder WebP vorliegen.' });
        return;
      }

      if (!isStaticImageFormat(format)) {
        res.status(400).json({ message: 'Animierte GIFs werden für Cover nicht unterstützt.' });
        return;
      }

      const gallery = await prisma.gallery.findUnique({
        where: { id },
        include: galleryInclude,
      });

      if (!gallery) {
        res.status(404).json({ message: 'Galerie wurde nicht gefunden.' });
        return;
      }

      if (!req.user) {
        res.status(401).json({ message: 'Authentifizierung erforderlich.' });
        return;
      }

      const isAdmin = req.user.role === 'ADMIN';
      if (gallery.ownerId !== req.user.id && !isAdmin) {
        res.status(403).json({ message: 'Keine Berechtigung zum Aktualisieren des Covers.' });
        return;
      }

      const mimeType = staticImageMimeTypes[format];
      const extension = format === 'jpeg' ? 'jpg' : format;
      const bucket = storageBuckets.images;
      const objectName = `gallery-covers/${id}/${Date.now()}-${randomUUID()}.${extension}`;

      try {
        await storageClient.putObject(bucket, objectName, file.buffer, file.size, {
          'Content-Type': mimeType,
        });
      } catch (storageError) {
        console.error('Failed to upload gallery cover to storage', storageError);
        res.status(500).json({ message: 'Cover konnte nicht gespeichert werden.' });
        return;
      }

      const storedUri = `s3://${bucket}/${objectName}`;

      let updatedGallery: HydratedGallery | null = null;

      try {
        updatedGallery = await prisma.gallery.update({
          where: { id },
          data: { coverImage: storedUri },
          include: galleryInclude,
        });
      } catch (dbError) {
        console.error('Failed to persist gallery cover', dbError);
        try {
          await storageClient.removeObject(bucket, objectName);
        } catch (cleanupError) {
          console.warn('Failed to cleanup gallery cover upload', cleanupError);
        }
        res.status(500).json({ message: 'Cover konnte nicht aktualisiert werden.' });
        return;
      }

      const previousCover = resolveStorageLocation(gallery.coverImage ?? undefined);
      if (
        previousCover.bucket === bucket &&
        typeof previousCover.objectName === 'string' &&
        previousCover.objectName.startsWith(`gallery-covers/${id}/`)
      ) {
        storageClient
          .removeObject(bucket, previousCover.objectName)
          .catch((cleanupError) => console.warn('Failed to remove previous gallery cover', cleanupError));
      }

      const mapped = mapGallery(updatedGallery, {
        viewer: req.user as AuthenticatedUser,
        includePrivate: isAdmin,
      });

      res.json({ gallery: mapped });
    } catch (handlerError) {
      next(handlerError);
    }
  });
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
