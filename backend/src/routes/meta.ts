import { Router } from 'express';

import { prisma } from '../lib/prisma';

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
