import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { hashPassword, toAuthUser } from '../lib/auth';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';

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

export const usersRouter = Router();

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
