import { randomUUID } from 'node:crypto';

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { hashPassword, toAuthUser, verifyPassword } from '../lib/auth';
import { requireAdmin, requireAuth, requireSelfOrAdmin } from '../lib/middleware/auth';
import { resolveStorageLocation, storageBuckets, storageClient } from '../lib/storage';
import { MAX_AVATAR_SIZE_BYTES } from '../lib/uploadLimits';

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

const updateProfileSchema = z
  .object({
    displayName: z.string().min(2).max(160).optional(),
    bio: z.string().max(600).nullable().optional(),
    avatarUrl: z.string().url().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'No profile changes provided.',
  });

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(8),
    newPassword: z.string().min(8),
    confirmPassword: z.string().min(8),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'New passwords do not match.',
    path: ['confirmPassword'],
  });

const bulkDeleteSchema = z.object({
  ids: z.array(z.string().trim().min(1)).min(1),
});

export const usersRouter = Router();

const avatarUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 1,
    fileSize: MAX_AVATAR_SIZE_BYTES,
  },
});

const isPng = (buffer: Buffer) =>
  buffer.length >= 8 &&
  buffer[0] === 0x89 &&
  buffer[1] === 0x50 &&
  buffer[2] === 0x4e &&
  buffer[3] === 0x47 &&
  buffer[4] === 0x0d &&
  buffer[5] === 0x0a &&
  buffer[6] === 0x1a &&
  buffer[7] === 0x0a;

const isJpeg = (buffer: Buffer) =>
  buffer.length >= 4 &&
  buffer[0] === 0xff &&
  buffer[1] === 0xd8 &&
  buffer[buffer.length - 2] === 0xff &&
  buffer[buffer.length - 1] === 0xd9;

const isWebp = (buffer: Buffer) =>
  buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';

const isGif = (buffer: Buffer) =>
  buffer.length >= 6 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a');

const detectAvatarFormat = (buffer: Buffer): 'png' | 'jpeg' | 'webp' | 'gif' | null => {
  if (isPng(buffer)) {
    return 'png';
  }

  if (isJpeg(buffer)) {
    return 'jpeg';
  }

  if (isWebp(buffer)) {
    return 'webp';
  }

  if (isGif(buffer)) {
    return 'gif';
  }

  return null;
};

const avatarMimeTypes: Record<'png' | 'jpeg' | 'webp', string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

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

usersRouter.post('/:id/avatar', requireAuth, requireSelfOrAdmin, (req, res, next) => {
  avatarUpload.single('avatar')(req, res, async (error: unknown) => {
    if (error) {
      if (error instanceof multer.MulterError) {
        if (error.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ message: 'Avatar exceeds the 5 MB limit.' });
          return;
        }

        res.status(400).json({ message: `Avatar upload failed: ${error.message}` });
        return;
      }

      next(error instanceof Error ? error : new Error('Unexpected avatar upload error.'));
      return;
    }

    const { id } = req.params;

    if (!id) {
      res.status(400).json({ message: 'User ID missing.' });
      return;
    }

    const file = req.file as Express.Multer.File | undefined;
    if (!file) {
      res.status(400).json({ message: 'No avatar file provided.' });
      return;
    }

    if (file.size === 0) {
      res.status(400).json({ message: 'Avatar file is empty.' });
      return;
    }

    const format = detectAvatarFormat(file.buffer);

    if (format === 'gif') {
      res.status(400).json({ message: 'Animated GIFs are not supported for avatars.' });
      return;
    }

    if (!format) {
      res.status(400).json({ message: 'Avatar must be a PNG, JPEG, or WebP image.' });
      return;
    }

    const mimeType = avatarMimeTypes[format];
    const extension = format === 'jpeg' ? 'jpg' : format;

    try {
      const existingUser = await prisma.user.findUnique({
        where: { id },
        select: {
          id: true,
          email: true,
          displayName: true,
          role: true,
          bio: true,
          avatarUrl: true,
        },
      });

      if (!existingUser) {
        res.status(404).json({ message: 'Benutzer wurde nicht gefunden.' });
        return;
      }

      const bucket = storageBuckets.images;
      const objectName = `avatars/${id}/${Date.now()}-${randomUUID()}.${extension}`;

      try {
        await storageClient.putObject(bucket, objectName, file.buffer, file.size, {
          'Content-Type': mimeType,
        });
      } catch (storageError) {
        console.error('Failed to upload avatar to storage', storageError);
        res.status(500).json({ message: 'Failed to store avatar image.' });
        return;
      }

      const storedUri = `s3://${bucket}/${objectName}`;

      let updatedUser;

      try {
        updatedUser = await prisma.user.update({
          where: { id },
          data: { avatarUrl: storedUri },
          select: {
            id: true,
            email: true,
            displayName: true,
            role: true,
            bio: true,
            avatarUrl: true,
          },
        });
      } catch (dbError) {
        console.error('Failed to update user avatar', dbError);
        try {
          await storageClient.removeObject(bucket, objectName);
        } catch (cleanupError) {
          console.warn('Failed to cleanup orphaned avatar upload', cleanupError);
        }
        res.status(500).json({ message: 'Failed to persist avatar image.' });
        return;
      }

      const previousAvatar = resolveStorageLocation(existingUser.avatarUrl ?? undefined);
      if (
        previousAvatar.bucket === bucket &&
        typeof previousAvatar.objectName === 'string' &&
        previousAvatar.objectName.startsWith(`avatars/${id}/`)
      ) {
        storageClient
          .removeObject(bucket, previousAvatar.objectName)
          .catch((cleanupError) => console.warn('Failed to remove previous avatar object', cleanupError));
      }

      res.json({ user: toAuthUser(updatedUser) });
    } catch (handlerError) {
      next(handlerError);
    }
  });
});

usersRouter.put('/:id/profile', requireAuth, requireSelfOrAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'User ID missing.' });
      return;
    }

    const parseResult = updateProfileSchema.safeParse(req.body);
    if (!parseResult.success) {
      res
        .status(400)
        .json({ message: 'Profile update failed.', errors: parseResult.error.flatten() });
      return;
    }

    const payload = parseResult.data;
    const updates: Record<string, unknown> = {};

    if (payload.displayName) {
      const trimmed = payload.displayName.trim();
      if (trimmed.length < 2) {
        res.status(400).json({ message: 'Display name must be at least 2 characters.' });
        return;
      }
      updates.displayName = trimmed;
    }

    if (payload.bio !== undefined) {
      if (payload.bio === null) {
        updates.bio = null;
      } else {
        const trimmedBio = payload.bio.trim();
        updates.bio = trimmedBio.length === 0 ? null : trimmedBio;
      }
    }

    if (payload.avatarUrl !== undefined) {
      updates.avatarUrl = payload.avatarUrl;
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ message: 'No profile changes provided.' });
      return;
    }

    const user = await prisma.user.update({
      where: { id },
      data: updates,
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        bio: true,
        avatarUrl: true,
      },
    });

    res.json({ user: toAuthUser(user) });
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as { code: string }).code === 'P2025') {
      res.status(404).json({ message: 'Benutzer wurde nicht gefunden.' });
      return;
    }

    next(error);
  }
});

usersRouter.put('/:id/password', requireAuth, requireSelfOrAdmin, async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'User ID missing.' });
      return;
    }

    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Password update failed.', errors: parsed.error.flatten() });
      return;
    }

    const { currentPassword, newPassword } = parsed.data;

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, passwordHash: true },
    });

    if (!user) {
      res.status(404).json({ message: 'Benutzer wurde nicht gefunden.' });
      return;
    }

    const isValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!isValid) {
      res.status(400).json({ message: 'Current password is incorrect.' });
      return;
    }

    const newHash = await hashPassword(newPassword);
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: newHash },
    });

    res.json({ message: 'Password updated successfully.' });
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
