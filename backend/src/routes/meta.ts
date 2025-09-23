import { Router } from 'express';

import { prisma } from '../lib/prisma';
import { storageBuckets, storageClient } from '../lib/storage';
import { appConfig } from '../config';
import { AgentRequestError, GeneratorAgentClient } from '../lib/generator/agentClient';

type ServiceHealthStatus = 'online' | 'offline' | 'degraded';

const getGpuNodeStatus = async (): Promise<{ status: ServiceHealthStatus; message: string }> => {
  const target = appConfig.network.generatorNodeUrl.trim();
  if (!target) {
    return {
      status: 'offline',
      message: 'GPU agent not configured yet.',
    };
  }

  try {
    const client = new GeneratorAgentClient(target);
    const health = await client.getHealth();
    if (health.busy) {
      return {
        status: 'degraded',
        message: 'GPU agent online but currently processing a job.',
      };
    }

    return {
      status: 'online',
      message: 'GPU agent online and ready.',
    };
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.warn('GPU agent probe failed:', error);
    }

    if (error instanceof AgentRequestError) {
      return {
        status: 'offline',
        message: `GPU agent health probe failed: ${error.message}`,
      };
    }

    if (error instanceof Error) {
      return {
        status: 'offline',
        message: `GPU agent unreachable: ${error.message}`,
      };
    }

    return {
      status: 'offline',
      message: 'GPU agent did not respond to the health probe.',
    };
  }
};

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
    let minioMessage = 'MinIO storage connected.';

    for (const bucket of uniqueBuckets) {
      try {
        const exists = await storageClient.bucketExists(bucket);
        if (!exists) {
          minioStatus = 'degraded';
          minioMessage = `Bucket "${bucket}" was not found.`;
          break;
        }
      } catch (error) {
        minioStatus = 'offline';
        minioMessage = `Unable to connect to MinIO: ${(error as Error).message}`;
        break;
      }
    }

    const gpuStatus = await getGpuNodeStatus();

    res.json({
      timestamp: new Date().toISOString(),
      services: {
        backend: {
          status: 'online' as const,
          message: 'API reachable.',
        },
        minio: {
          status: minioStatus,
          message: minioMessage,
        },
        gpu: gpuStatus,
      },
    });
  } catch (error) {
    next(error);
  }
});

metaRouter.get('/config', (_req, res) => {
  res.json({
    platform: {
      siteTitle: appConfig.platform.siteTitle,
      allowRegistration: appConfig.platform.allowRegistration,
      maintenanceMode: appConfig.platform.maintenanceMode,
    },
  });
});
