import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { createAccessToken, hashPassword, toAuthUser, verifyPassword } from '../lib/auth';
import { requireAuth } from '../lib/middleware/auth';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const registerSchema = z.object({
  email: z.string().email(),
  displayName: z.string().min(2).max(160),
  password: z.string().min(8),
});

export const authRouter = Router();

authRouter.post('/login', async (req, res, next) => {
  try {
    const result = loginSchema.safeParse(req.body);
    if (!result.success) {
      res.status(400).json({ message: 'Bitte gültige Zugangsdaten angeben.' });
      return;
    }

    const { email, password } = result.data;
    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        bio: true,
        avatarUrl: true,
        passwordHash: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ message: 'Benutzerkonto nicht gefunden oder deaktiviert.' });
      return;
    }

    const passwordValid = await verifyPassword(password, user.passwordHash);
    if (!passwordValid) {
      res.status(401).json({ message: 'E-Mail oder Passwort sind nicht korrekt.' });
      return;
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });

    const token = createAccessToken({
      sub: user.id,
      role: user.role,
      displayName: user.displayName,
      email: user.email,
    });

    res.json({
      token,
      user: toAuthUser(user),
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Registrierungsdaten sind ungültig.', errors: parsed.error.flatten() });
      return;
    }

    const email = parsed.data.email.toLowerCase();
    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      res.status(409).json({ message: 'Für diese E-Mail-Adresse existiert bereits ein Konto.' });
      return;
    }

    const passwordHash = await hashPassword(parsed.data.password);
    const user = await prisma.user.create({
      data: {
        email,
        displayName: parsed.data.displayName.trim(),
        passwordHash,
        role: 'USER',
        isActive: true,
      },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        bio: true,
        avatarUrl: true,
      },
    });

    const token = createAccessToken({
      sub: user.id,
      role: user.role,
      displayName: user.displayName,
      email: user.email,
    });

    res.status(201).json({
      token,
      user: toAuthUser(user),
    });
  } catch (error) {
    next(error);
  }
});

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});
