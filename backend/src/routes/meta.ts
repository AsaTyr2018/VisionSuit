import { Router } from 'express';

import { prisma } from '../lib/prisma';
import { storageBuckets, storageClient } from '../lib/storage';

export const metaRouter = Router();

metaRouter.get('/stats', async (_req, res, next) => {
  try {
    const [modelCount, imageCount, galleryCount, tagCount] = await Promise.all([
      prisma.modelAsset.count(),
      prisma.imageAsset.count(),
      prisma.gallery.count(),
      prisma.tag.count(),
    ]);

    res.json({
      modelCount,
      imageCount,
      galleryCount,
      tagCount,
    });
  } catch (error) {
    next(error);
  }
});

metaRouter.get('/status', async (_req, res, next) => {
  try {
    const uniqueBuckets = Array.from(new Set(Object.values(storageBuckets)));

    let minioStatus: 'online' | 'offline' | 'degraded' = 'online';
    let minioMessage = 'MinIO Storage verbunden.';

    for (const bucket of uniqueBuckets) {
      try {
        const exists = await storageClient.bucketExists(bucket);
        if (!exists) {
          minioStatus = 'degraded';
          minioMessage = `Bucket "${bucket}" wurde nicht gefunden.`;
          break;
        }
      } catch (error) {
        minioStatus = 'offline';
        minioMessage = `Keine Verbindung zu MinIO möglich: ${(error as Error).message}`;
        break;
      }
    }

    res.json({
      timestamp: new Date().toISOString(),
      services: {
        backend: {
          status: 'online' as const,
          message: 'API erreichbar.',
        },
        minio: {
          status: minioStatus,
          message: minioMessage,
        },
      },
    });
  } catch (error) {
    next(error);
  }
});
