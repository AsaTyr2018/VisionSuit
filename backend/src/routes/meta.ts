import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';

import { Router } from 'express';

import { prisma } from '../lib/prisma';
import { storageBuckets, storageClient } from '../lib/storage';
import { appConfig } from '../config';

type ServiceHealthStatus = 'online' | 'offline' | 'degraded';

const buildGpuHealthUrl = (rawValue: string): URL | null => {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  let base: URL;
  try {
    if (/^https?:\/\//i.test(trimmed)) {
      base = new URL(trimmed);
    } else {
      base = new URL(`http://${trimmed}`);
    }
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.warn('Failed to parse GPU node URL:', error);
    }
    return null;
  }

  if (!base.port) {
    base.port = base.protocol === 'https:' ? '443' : '8188';
  }

  const normalizedPath = base.pathname && base.pathname !== '/' ? base.pathname.replace(/\/$/, '') : '';
  base.pathname = `${normalizedPath}/system_stats`.replace(/\/{2,}/g, '/');
  return base;
};

const probeGpuNode = async (target: URL): Promise<{ status: ServiceHealthStatus; message: string }> =>
  new Promise((resolve) => {
    const client = target.protocol === 'https:' ? httpsRequest : httpRequest;

    const request = client(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: 'GET',
        timeout: 3500,
      },
      (response) => {
        const { statusCode } = response;
        response.resume();

        if (statusCode && statusCode >= 200 && statusCode < 300) {
          resolve({ status: 'online', message: 'GPU node reachable.' });
          return;
        }

        resolve({
          status: 'degraded',
          message: `GPU node responded with status ${statusCode ?? 0}.`,
        });
      },
    );

    request.on('timeout', () => {
      request.destroy(new Error('GPU node request timed out.'));
    });

    request.on('error', (error) => {
      resolve({ status: 'offline', message: `GPU node unreachable: ${error.message}` });
    });

    request.end();
  });

const getGpuNodeStatus = async (): Promise<{ status: ServiceHealthStatus; message: string }> => {
  const target = appConfig.network.generatorNodeUrl.trim();
  if (!target) {
    return {
      status: 'offline',
      message: 'GPU node not configured yet.',
    };
  }

  const url = buildGpuHealthUrl(target);
  if (!url) {
    return {
      status: 'offline',
      message: 'GPU node address is invalid. Update the connection settings.',
    };
  }

  try {
    return await probeGpuNode(url);
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      // eslint-disable-next-line no-console
      console.warn('GPU node probe failed:', error);
    }

    return {
      status: 'offline',
      message: 'GPU node did not respond to the health probe.',
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
