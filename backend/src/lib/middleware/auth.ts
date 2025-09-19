import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../prisma';
import { toAuthUser, verifyAccessToken } from '../auth';

const extractToken = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return null;
  }

  const trimmed = header.trim();
  if (trimmed.toLowerCase().startsWith('bearer ')) {
    return trimmed.slice(7).trim();
  }

  return trimmed.length > 0 ? trimmed : null;
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = extractToken(req);
    if (!token) {
      res.status(401).json({ message: 'Authentication token missing.' });
      return;
    }

    const payload = verifyAccessToken(token);
    const user = await prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        email: true,
        displayName: true,
        role: true,
        bio: true,
        avatarUrl: true,
        isActive: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ message: 'Benutzerkonto nicht verfügbar oder deaktiviert.' });
      return;
    }

    req.user = toAuthUser(user);
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token ungültig oder abgelaufen.' });
  }
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    res.status(403).json({ message: 'Administratorrechte erforderlich.' });
    return;
  }

  next();
};

export const requireSelfOrAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    res.status(401).json({ message: 'Authentifizierung erforderlich.' });
    return;
  }

  const targetId = req.params.userId ?? req.params.id;

  if (req.user.role === 'ADMIN' || (targetId && targetId === req.user.id)) {
    next();
    return;
  }

  res.status(403).json({ message: 'Keine Berechtigung für diese Aktion.' });
};
