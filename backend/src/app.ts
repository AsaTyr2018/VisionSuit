import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import morgan from 'morgan';

import { appConfig } from './config';
import { MAX_TOTAL_SIZE_BYTES, MAX_UPLOAD_FILES } from './lib/uploadLimits';
import { attachOptionalUser } from './lib/middleware/auth';
import { router } from './routes';

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

  app.use('/api', attachOptionalUser);
  app.use('/api', router);

  app.use((req, res) => {
    res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        res.status(400).json({
          message: `Es können maximal ${MAX_UPLOAD_FILES} Dateien pro Upload übertragen werden.`,
        });
        return;
      }

      if (err.code === 'LIMIT_FILE_SIZE') {
        const maxSizeGb = (MAX_TOTAL_SIZE_BYTES / (1024 * 1024 * 1024)).toFixed(0);
        res.status(400).json({
          message: `Eine der Dateien überschreitet das erlaubte Größenlimit von ${maxSizeGb} GB.`,
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
