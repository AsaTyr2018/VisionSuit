import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import morgan from 'morgan';

import { appConfig } from './config';
import { router } from './routes';

export const createApp = () => {
  const app = express();

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

  app.use('/api', router);

  app.use((req, res) => {
    res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ message: 'Unexpected server error' });
  });

  return app;
};
