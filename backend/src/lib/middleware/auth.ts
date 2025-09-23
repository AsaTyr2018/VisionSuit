import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../prisma';
import { toAuthUser, verifyAccessToken } from '../auth';
import { appConfig } from '../../config';

const extractTokenFromQuery = (value: unknown): string | null => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    }
  }

  return null;
};

const extractToken = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (typeof header === 'string') {
    const trimmed = header.trim();
    if (trimmed.toLowerCase().startsWith('bearer ')) {
      const token = trimmed.slice(7).trim();
      if (token.length > 0) {
        return token;
      }
    }

    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  const query = req.query as Record<string, unknown>;
  const queryToken =
    extractTokenFromQuery(query['accessToken']) ?? extractTokenFromQuery(query['token']);

  if (queryToken) {
    return queryToken;
  }

  return null;
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
        showAdultContent: true,
      },
    });

    if (!user || !user.isActive) {
      res.status(401).json({ message: 'Benutzerkonto nicht verfügbar oder deaktiviert.' });
      return;
    }

    if (appConfig.platform.maintenanceMode && user.role !== 'ADMIN') {
      res.status(503).json({ message: 'Maintenance mode restricts access to administrators only.' });
      return;
    }

    req.user = toAuthUser(user);
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token ungültig oder abgelaufen.' });
  }
};

export const attachOptionalUser = async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const token = extractToken(req);
    if (!token) {
      next();
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
        showAdultContent: true,
      },
    });

    if (user && user.isActive) {
      req.user = toAuthUser(user);
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.warn('Optional auth token rejected:', error);
    }
  }

  next();
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    res.status(403).json({ message: 'Administratorrechte erforderlich.' });
    return;
  }

  next();
};

export const requireCurator = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    res.status(401).json({ message: 'Authentifizierung erforderlich.' });
    return;
  }

  if (req.user.role === 'USER') {
    res.status(403).json({ message: 'Kurator:innenrechte erforderlich.' });
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
