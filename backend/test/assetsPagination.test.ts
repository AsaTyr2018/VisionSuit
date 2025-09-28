import { strict as assert } from 'node:assert';
import type { Request, Response, NextFunction } from 'express';
import test from 'node:test';
import { ModerationStatus, type Prisma } from '@prisma/client';

import { assetsRouter } from '../src/routes/assets';
import { prisma } from '../src/lib/prisma';

const originalModelFindMany = prisma.modelAsset.findMany;
const originalImageFindMany = prisma.imageAsset.findMany;

const getRouteHandler = (path: string) => {
  const layer = (assetsRouter as unknown as { stack: unknown[] }).stack.find((entry: unknown) => {
    const candidate = entry as { route?: { path?: string; methods?: Record<string, boolean>; stack: { handle: unknown }[] } };
    return candidate.route?.path === path && Boolean(candidate.route?.methods?.get);
  }) as { route?: { stack: { handle: unknown }[] } } | undefined;

  if (!layer?.route?.stack?.[0]?.handle) {
    throw new Error(`Route handler for ${path} not found`);
  }

  return layer.route.stack[0].handle as (req: Request, res: Response, next: NextFunction) => unknown;
};

const createResponse = () => {
  let payload: unknown;
  const res = {
    json: (value: unknown) => {
      payload = value;
      return res;
    },
  } as unknown as Response;

  return {
    res,
    getPayload: () => payload,
  };
};

test.after(() => {
  prisma.modelAsset.findMany = originalModelFindMany;
  prisma.imageAsset.findMany = originalImageFindMany;
});

test('models listing keeps adult filters and paginates results', async () => {
  let capturedArgs: Prisma.ModelAssetFindManyArgs | null = null;

  prisma.modelAsset.findMany = (async (args) => {
    capturedArgs = args;
    return [];
  }) as typeof prisma.modelAsset.findMany;

  const handler = getRouteHandler('/models');
  const request = { query: {}, user: undefined } as unknown as Request;
  const { res, getPayload } = createResponse();

  await handler(request, res, (error?: unknown) => {
    if (error) {
      throw error;
    }
  });

  assert.ok(capturedArgs);
  assert.equal(capturedArgs?.take, 25);
  assert.deepEqual(capturedArgs?.orderBy, [
    { createdAt: 'desc' },
    { id: 'desc' },
  ]);
  const where = capturedArgs?.where as Prisma.ModelAssetWhereInput;
  assert.ok(where);
  assert.ok(Array.isArray(where.AND));
  assert.deepEqual(where.AND?.[0], {
    isPublic: true,
    moderationStatus: ModerationStatus.ACTIVE,
  });
  assert.deepEqual(where.AND?.[1], { isAdult: false });

  assert.deepEqual(getPayload(), { items: [], nextCursor: null, hasMore: false });
});

test('image listing applies viewer adult visibility and surfaces next cursor', async () => {
  let capturedArgs: Prisma.ImageAssetFindManyArgs | null = null;

  prisma.imageAsset.findMany = (async (args) => {
    capturedArgs = args;
    const count = args.take ?? 0;
    return Array.from({ length: count }, (_value, index) => ({
      id: `image-${index + 1}`,
      title: `Image ${index + 1}`,
      description: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ownerId: 'viewer-1',
      owner: { id: 'viewer-1', displayName: 'Viewer', email: 'viewer@example.com' },
      flaggedAt: null,
      flaggedById: null,
      flaggedBy: null,
      fileSize: 0,
      height: null,
      width: null,
      seed: null,
      model: null,
      sampler: null,
      cfgScale: null,
      steps: null,
      prompt: null,
      negativePrompt: null,
      storagePath: 'local/test',
      storageBucket: null,
      storageObject: null,
      storageProvider: null,
      isAdult: false,
      isPublic: true,
      moderationStatus: ModerationStatus.ACTIVE,
      tagScanPending: false,
      tagScanStatus: null,
      metadata: null,
      moderationSummary: null,
      moderationReports: [],
      tags: [],
      likes: [],
      _count: { likes: 0 },
    }));
  }) as typeof prisma.imageAsset.findMany;

  const handler = getRouteHandler('/images');
  const request = {
    query: { cursor: 'image-0', take: '2' },
    user: {
      id: 'viewer-1',
      email: 'viewer@example.com',
      displayName: 'Viewer',
      role: 'USER',
      showAdultContent: false,
    },
  } as unknown as Request;
  const { res, getPayload } = createResponse();

  await handler(request, res, (error?: unknown) => {
    if (error) {
      throw error;
    }
  });

  assert.ok(capturedArgs);
  assert.equal(capturedArgs?.take, 3);
  assert.deepEqual(capturedArgs?.cursor, { id: 'image-0' });
  assert.equal(capturedArgs?.skip, 1);
  const where = capturedArgs?.where as Prisma.ImageAssetWhereInput;
  assert.ok(where);
  assert.ok(Array.isArray(where.AND));
  assert.deepEqual(where.AND?.[0], {
    OR: [
      { ownerId: 'viewer-1' },
      {
        AND: [
          { isPublic: true },
          { moderationStatus: ModerationStatus.ACTIVE },
        ],
      },
    ],
  });
  assert.deepEqual(where.AND?.[1], {
    OR: [{ isAdult: false }, { ownerId: 'viewer-1' }],
  });

  const payload = getPayload() as { items: { id: string }[]; nextCursor: string | null; hasMore: boolean };
  assert.equal(payload.items.length, 2);
  assert.equal(payload.hasMore, true);
  assert.equal(payload.nextCursor, 'image-2');
});
