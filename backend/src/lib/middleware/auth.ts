import type { NextFunction, Request, Response } from 'express';

import { prisma } from '../prisma';
import { toAuthUser, verifyAccessToken } from '../auth';
import { appConfig } from '../../config';
import {
  PRISMA_STUDIO_COOKIE_NAME,
  PRISMA_STUDIO_COOKIE_PATH,
  PRISMA_STUDIO_PROXY_PREFIXES,
} from '../../devtools/constants';

const isPrismaStudioRequest = (req: Request) => {
  const url = req.originalUrl ?? '';
  const base = req.baseUrl ?? '';
  return PRISMA_STUDIO_PROXY_PREFIXES.some(
    (prefix) => url.startsWith(prefix) || base.startsWith(prefix),
  );
};

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

const extractTokenFromCookies = (cookieHeader: string | undefined, cookieName: string): string | null => {
  if (!cookieHeader || cookieHeader.trim().length === 0) {
    return null;
  }

  const segments = cookieHeader.split(';');
  for (const segment of segments) {
    const [name, ...rest] = segment.split('=');
    if (!name) {
      continue;
    }

    if (name.trim() !== cookieName) {
      continue;
    }

    const value = rest.join('=').trim();
    if (value.length === 0) {
      return null;
    }

    try {
      return decodeURIComponent(value);
    } catch {
      return value;
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

  if (isPrismaStudioRequest(req)) {
    const cookieToken = extractTokenFromCookies(req.headers.cookie, PRISMA_STUDIO_COOKIE_NAME);
    if (cookieToken) {
      return cookieToken;
    }
  }

  return null;
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = extractToken(req);
    if (!token) {
      if (isPrismaStudioRequest(req)) {
        res.clearCookie(PRISMA_STUDIO_COOKIE_NAME, { path: PRISMA_STUDIO_COOKIE_PATH });
      }
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
      if (isPrismaStudioRequest(req)) {
        res.clearCookie(PRISMA_STUDIO_COOKIE_NAME, { path: PRISMA_STUDIO_COOKIE_PATH });
      }
      res.status(401).json({ message: 'User account unavailable or deactivated.' });
      return;
    }

    if (appConfig.platform.maintenanceMode && user.role !== 'ADMIN') {
      res.status(503).json({ message: 'Maintenance mode restricts access to administrators only.' });
      return;
    }

    req.user = toAuthUser(user);
    next();
  } catch (error) {
    if (isPrismaStudioRequest(req)) {
      res.clearCookie(PRISMA_STUDIO_COOKIE_NAME, { path: PRISMA_STUDIO_COOKIE_PATH });
    }
    res.status(401).json({ message: 'Token invalid or expired.' });
  }
};

export const attachOptionalUser = async (req: Request, res: Response, next: NextFunction) => {
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
    if (isPrismaStudioRequest(req)) {
      res.clearCookie(PRISMA_STUDIO_COOKIE_NAME, { path: PRISMA_STUDIO_COOKIE_PATH });
    }
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.warn('Optional auth token rejected:', error);
    }
  }

  next();
};

export const requireAdmin = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    res.status(403).json({ message: 'Administrator privileges required.' });
    return;
  }

  next();
};

export const requireCurator = (req: Request, res: Response, next: NextFunction) => {
  if (!req.user) {
    res.status(401).json({ message: 'Authentication required.' });
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
    res.status(401).json({ message: 'Authentication required.' });
    return;
  }

  const targetId = req.params.userId ?? req.params.id;

  if (req.user.role === 'ADMIN' || (targetId && targetId === req.user.id)) {
    next();
    return;
  }

  res.status(403).json({ message: 'Not authorized for this action.' });
};
