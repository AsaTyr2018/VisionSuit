import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import { createAccessToken, toAuthUser, verifyPassword } from '../lib/auth';
import { requireAuth } from '../lib/middleware/auth';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
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

authRouter.get('/me', requireAuth, async (req, res) => {
  res.json({ user: req.user });
});
