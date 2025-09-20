import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { hashPassword, toAuthUser } from '../lib/auth';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { resolveStorageLocation } from '../lib/storage';

const createUserSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(160),
  password: z.string().min(8),
  role: z.enum(['CURATOR', 'ADMIN']).default('CURATOR'),
  bio: z.string().max(600).optional(),
  avatarUrl: z.string().url().optional(),
});

const updateUserSchema = z.object({
  email: z.string().email().optional(),
  displayName: z.string().min(2).max(160).optional(),
  password: z.string().min(8).optional(),
  role: z.enum(['CURATOR', 'ADMIN']).optional(),
  bio: z.string().max(600).nullable().optional(),
  avatarUrl: z.string().url().nullable().optional(),
  isActive: z.boolean().optional(),
});

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1),
});

export const usersRouter = Router();

const computeRank = (score: number) => {
  if (score >= 40) {
    return {
      label: 'Master Curator',
      description: 'Leads large-scale curation programs with sustained contributions.',
      minimumScore: 40,
      nextLabel: null,
      nextScore: null,
    };
  }

  if (score >= 18) {
    return {
      label: 'Senior Curator',
      description: 'Regularly delivers polished LoRAs and collections for the community.',
      minimumScore: 18,
      nextLabel: 'Master Curator',
      nextScore: 40,
    };
  }

  if (score >= 6) {
    return {
      label: 'Curator',
      description: 'Actively maintains a growing catalog of models and showcases.',
      minimumScore: 6,
      nextLabel: 'Senior Curator',
      nextScore: 18,
    };
  }

  return {
    label: 'Newcomer',
    description: 'Getting started with first uploads and curated collections.',
    minimumScore: 0,
    nextLabel: 'Curator',
    nextScore: 6,
  };
};

usersRouter.get('/:id/profile', async (req, res, next) => {
  try {
    const { id } = req.params;

    if (!id) {
      res.status(400).json({ message: 'User ID missing.' });
      return;
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        displayName: true,
        bio: true,
        avatarUrl: true,
        role: true,
        isActive: true,
        createdAt: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(404).json({ message: 'Profile not found.' });
      return;
    }

    const [models, galleries, imageCount] = await Promise.all([
      prisma.modelAsset.findMany({
        where: { ownerId: id },
        orderBy: { updatedAt: 'desc' },
        include: {
          tags: { include: { tag: true } },
        },
      }),
      prisma.gallery.findMany({
        where: { ownerId: id },
        orderBy: { updatedAt: 'desc' },
        include: {
          entries: { select: { id: true, imageId: true, assetId: true } },
        },
      }),
      prisma.imageAsset.count({ where: { ownerId: id } }),
    ]);

    const mappedModels = models.map((model) => {
      const preview = resolveStorageLocation(model.previewImage);
      return {
        id: model.id,
        title: model.title,
        slug: model.slug,
        version: model.version,
        description: model.description,
        previewImage: preview.url ?? model.previewImage ?? null,
        previewImageBucket: preview.bucket,
        previewImageObject: preview.objectName,
        updatedAt: model.updatedAt,
        createdAt: model.createdAt,
        tags: model.tags.map(({ tag }) => tag),
      };
    });

    const mappedGalleries = galleries.map((gallery) => {
      const cover = resolveStorageLocation(gallery.coverImage);
      const entryCount = gallery.entries.length;
      let imageEntryCount = 0;
      let modelEntryCount = 0;

      gallery.entries.forEach((entry) => {
        if (entry.imageId) {
          imageEntryCount += 1;
        }
        if (entry.assetId) {
          modelEntryCount += 1;
        }
      });

      return {
        id: gallery.id,
        title: gallery.title,
        slug: gallery.slug,
        description: gallery.description,
        isPublic: gallery.isPublic,
        coverImage: cover.url ?? gallery.coverImage ?? null,
        coverImageBucket: cover.bucket,
        coverImageObject: cover.objectName,
        updatedAt: gallery.updatedAt,
        createdAt: gallery.createdAt,
        stats: {
          entryCount,
          imageCount: imageEntryCount,
          modelCount: modelEntryCount,
        },
      };
    });

    const modelCount = mappedModels.length;
    const galleryCount = mappedGalleries.length;
    const contributionScore = modelCount * 3 + galleryCount * 2 + imageCount;
    const rank = computeRank(contributionScore);
    const avatar = resolveStorageLocation(user.avatarUrl ?? undefined);

    res.json({
      profile: {
        id: user.id,
        displayName: user.displayName,
        bio: user.bio ?? null,
        avatarUrl: avatar.url ?? user.avatarUrl ?? null,
        role: user.role,
        joinedAt: user.createdAt,
        rank: {
          ...rank,
          score: contributionScore,
        },
        stats: {
          modelCount,
          galleryCount,
          imageCount,
        },
        models: mappedModels,
        galleries: mappedGalleries,
      },
    });
  } catch (error) {
    next(error);
  }
});

usersRouter.use(requireAuth, requireAdmin);

usersRouter.get('/', async (_req, res, next) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
    });

    res.json({ users: users.map((user) => ({
      ...toAuthUser(user),
      isActive: user.isActive,
      lastLoginAt: user.lastLoginAt,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    })) });
  } catch (error) {
    next(error);
  }
});

usersRouter.post('/', async (req, res, next) => {
  try {
    const result = createUserSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ message: 'Benutzer konnte nicht erstellt werden.', errors: result.error.flatten() });
      return;
    }

    const payload = result.data;
    const passwordHash = await hashPassword(payload.password);

    const user = await prisma.user.create({
      data: {
        email: payload.email.toLowerCase(),
        displayName: payload.displayName,
        role: payload.role,
        passwordHash,
        bio: payload.bio ?? null,
        avatarUrl: payload.avatarUrl ?? null,
        isActive: true,
      },
    });

    res.status(201).json({ user: { ...toAuthUser(user), isActive: user.isActive } });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'P2002') {
      res.status(409).json({ message: 'E-Mail-Adresse wird bereits verwendet.' });
      return;
    }

    next(error);
  }
});

usersRouter.put('/:id', async (req, res, next) => {
  try {
    const result = updateUserSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ message: 'Aktualisierung fehlgeschlagen.', errors: result.error.flatten() });
      return;
    }

    const payload = result.data;
    const updates: Record<string, unknown> = {};

    if (payload.email) {
      updates.email = payload.email.toLowerCase();
    }

    if (payload.displayName) {
      updates.displayName = payload.displayName;
    }

    if (payload.role) {
      updates.role = payload.role;
    }

    if (payload.bio !== undefined) {
      updates.bio = payload.bio;
    }

    if (payload.avatarUrl !== undefined) {
      updates.avatarUrl = payload.avatarUrl;
    }

    if (payload.isActive !== undefined) {
      updates.isActive = payload.isActive;
    }

    if (payload.password) {
      updates.passwordHash = await hashPassword(payload.password);
    }

    const user = await prisma.user.update({
      where: { id: req.params.id },
      data: updates,
    });

    res.json({ user: { ...toAuthUser(user), isActive: user.isActive } });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'P2025') {
      res.status(404).json({ message: 'Benutzer wurde nicht gefunden.' });
      return;
    }

    if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'P2002') {
      res.status(409).json({ message: 'E-Mail-Adresse wird bereits verwendet.' });
      return;
    }

    next(error);
  }
});

usersRouter.delete('/:id', async (req, res, next) => {
  try {
    const targetId = req.params.id;

    if (req.user?.id === targetId) {
      res.status(400).json({ message: 'Das eigene Konto kann nicht gelöscht werden.' });
      return;
    }

    await prisma.user.delete({ where: { id: targetId } });
    res.status(204).send();
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'P2025') {
      res.status(404).json({ message: 'Benutzer wurde nicht gefunden.' });
      return;
    }

    next(error);
  }
});

usersRouter.post('/bulk-delete', async (req, res, next) => {
  try {
    const parsed = bulkDeleteSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Ungültige Anfrage.', errors: parsed.error.flatten() });
      return;
    }

    if (!req.user) {
      res.status(401).json({ message: 'Authentifizierung erforderlich.' });
      return;
    }

    const uniqueIds = Array.from(new Set(parsed.data.ids.filter((id) => id !== req.user?.id)));

    if (uniqueIds.length === 0) {
      res.status(400).json({ message: 'Keine gültigen Ziel-IDs übermittelt.' });
      return;
    }

    const usersToDelete = await prisma.user.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });

    if (usersToDelete.length === 0) {
      res.status(404).json({ message: 'Keine passenden Benutzer:innen gefunden.' });
      return;
    }

    await prisma.user.deleteMany({
      where: {
        id: {
          in: usersToDelete.map((user) => user.id),
        },
      },
    });

    res.json({ deleted: usersToDelete.map((user) => user.id) });
  } catch (error) {
    next(error);
  }
});
