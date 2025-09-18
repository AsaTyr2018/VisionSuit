import { ImageAsset, ModelAsset, Tag, User } from '@prisma/client';
import { Router } from 'express';

import { prisma } from '../lib/prisma';

type HydratedModelAsset = ModelAsset & {
  tags: { tag: Tag }[];
  owner: Pick<User, 'id' | 'displayName' | 'email'>;
};

type HydratedImageAsset = ImageAsset & {
  tags: { tag: Tag }[];
};

const mapModelAsset = (asset: HydratedModelAsset) => ({
  id: asset.id,
  slug: asset.slug,
  title: asset.title,
  description: asset.description,
  version: asset.version,
  fileSize: asset.fileSize,
  checksum: asset.checksum,
  storagePath: asset.storagePath,
  previewImage: asset.previewImage,
  metadata: asset.metadata,
  owner: asset.owner,
  tags: asset.tags.map(({ tag }) => tag),
  createdAt: asset.createdAt,
  updatedAt: asset.updatedAt,
});

const mapImageAsset = (asset: HydratedImageAsset) => ({
  id: asset.id,
  title: asset.title,
  description: asset.description,
  dimensions:
    asset.width && asset.height ? { width: asset.width, height: asset.height } : undefined,
  fileSize: asset.fileSize,
  storagePath: asset.storagePath,
  prompt: asset.prompt,
  negativePrompt: asset.negativePrompt,
  metadata: {
    seed: asset.seed,
    model: asset.model,
    sampler: asset.sampler,
    cfgScale: asset.cfgScale,
    steps: asset.steps,
  },
  tags: asset.tags.map(({ tag }) => tag),
  createdAt: asset.createdAt,
  updatedAt: asset.updatedAt,
});

export const assetsRouter = Router();

assetsRouter.get('/models', async (_req, res, next) => {
  try {
    const assets = await prisma.modelAsset.findMany({
      include: {
        tags: { include: { tag: true } },
        owner: { select: { id: true, displayName: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json(assets.map(mapModelAsset));
  } catch (error) {
    next(error);
  }
});

assetsRouter.get('/images', async (_req, res, next) => {
  try {
    const images = await prisma.imageAsset.findMany({
      include: { tags: { include: { tag: true } } },
      orderBy: { createdAt: 'desc' },
    });

    res.json(images.map(mapImageAsset));
  } catch (error) {
    next(error);
  }
});
