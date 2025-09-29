import cors from 'cors';
import express, { NextFunction, Request, RequestHandler, Response } from 'express';
import multer from 'multer';
import morgan from 'morgan';
import { URL } from 'node:url';

import { appConfig } from './config';
import {
  PRISMA_STUDIO_COOKIE_NAME,
  PRISMA_STUDIO_COOKIE_PATH,
  PRISMA_STUDIO_PROXY_PREFIXES,
} from './devtools/constants';
import { createPrismaStudioProxy } from './devtools/prismaStudioProxy';
import { attachOptionalUser, requireAdmin, requireAuth } from './lib/middleware/auth';
import { MAX_TOTAL_SIZE_BYTES, MAX_UPLOAD_FILES } from './lib/uploadLimits';
import { router } from './routes';

const extractQueryToken = (value: unknown): string | null => {
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

const persistPrismaStudioSession: RequestHandler = (req, res, next) => {
  const query = req.query as Record<string, unknown>;
  const queryToken =
    extractQueryToken(query['accessToken']) ?? extractQueryToken(query['token']);

  if (!queryToken) {
    next();
    return;
  }

  res.cookie(PRISMA_STUDIO_COOKIE_NAME, queryToken, {
    httpOnly: true,
    sameSite: 'lax',
    secure: appConfig.env === 'production',
    maxAge: 60 * 60 * 1000,
    path: PRISMA_STUDIO_COOKIE_PATH,
  });

  try {
    const parsed = new URL(req.originalUrl, `http://${req.headers.host ?? 'localhost'}`);
    parsed.searchParams.delete('accessToken');
    parsed.searchParams.delete('token');
    const cleanedUrl = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    if (cleanedUrl !== req.originalUrl) {
      res.redirect(cleanedUrl);
      return;
    }
  } catch {
    // ignore malformed URLs and continue
  }

  next();
};

export const createApp = () => {
  const app = express();

  app.disable('etag');

  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(morgan(appConfig.env === 'production' ? 'combined' : 'dev'));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      environment: appConfig.env,
    });
  });

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
  });

  app.post('/db/logout', (_req, res) => {
    res.clearCookie(PRISMA_STUDIO_COOKIE_NAME, { path: PRISMA_STUDIO_COOKIE_PATH });
    res.status(204).end();
  });

  const prismaProxyHandler = createPrismaStudioProxy();
  for (const prefix of PRISMA_STUDIO_PROXY_PREFIXES) {
    app.use(prefix, persistPrismaStudioSession);
  }

  for (const prefix of PRISMA_STUDIO_PROXY_PREFIXES) {
    app.use(prefix, attachOptionalUser);
  }

  for (const prefix of PRISMA_STUDIO_PROXY_PREFIXES) {
    app.use(prefix, requireAuth, requireAdmin, prismaProxyHandler);
  }

  app.use('/api', attachOptionalUser);
  app.use('/api', router);

  app.use((req, res) => {
    res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({
          message: `A maximum of ${MAX_UPLOAD_FILES} files can be uploaded per request.`,
        });
        return;
      }

      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxSizeGb = (MAX_TOTAL_SIZE_BYTES / (1024 * 1024 * 1024)).toFixed(0);
        res.status(400).json({
          message: `One of the files exceeds the allowed size limit of ${maxSizeGb} GB.`,
        });
        return;
      }

      res.status(400).json({ message: err.message });
      return;
    }

    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ message: 'Unexpected server error' });
  });

  return app;
};
