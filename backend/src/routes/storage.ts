import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { pipeline } from 'node:stream/promises';

import { prisma } from '../lib/prisma';
import { storageBuckets, storageClient } from '../lib/storage';
import { requireAuth } from '../lib/middleware/auth';

const allowedBuckets = new Set(Object.values(storageBuckets));

const encodeFilename = (value: string) =>
  `"${value.replace(/"/g, '\\"')}"`;

const encodeFilenameStar = (value: string) =>
  `UTF-8''${encodeURIComponent(value)}`;

const sendNotFound = (res: Response) => {
  res.status(404).json({ message: 'Die angeforderte Datei wurde nicht gefunden.' });
};

const sendBucketNotAllowed = (res: Response) => {
  res.status(404).json({ message: 'Der angeforderte Storage-Bucket ist unbekannt.' });
};

export const storageRouter = Router();

storageRouter.use(requireAuth);

const handleObjectRequest = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const bucket = req.params.bucket;

    if (!bucket || !allowedBuckets.has(bucket)) {
      sendBucketNotAllowed(res);
      return;
    }

    const objectId = req.params.objectId;
    if (!objectId) {
      sendNotFound(res);
      return;
    }

    const storageObject = await prisma.storageObject.findUnique({ where: { id: objectId } });

    if (!storageObject || storageObject.bucket !== bucket) {
      sendNotFound(res);
      return;
    }

    const objectName = storageObject.objectName;

    if (!objectName) {
      sendNotFound(res);
      return;
    }

    let stat;
    try {
      stat = await storageClient.statObject(bucket, objectName);
    } catch (error) {
      const code = (error as Error & { code?: string }).code;
      if (code === 'NoSuchKey' || code === 'NotFound') {
        sendNotFound(res);
        return;
      }

      throw error;
    }

    const isHeadRequest = req.method === 'HEAD';
    const objectStream = isHeadRequest ? null : await storageClient.getObject(bucket, objectName);

    const contentType =
      storageObject.contentType ??
      stat.metaData?.['content-type'] ??
      stat.metaData?.['Content-Type'] ??
      stat.metaData?.['Content-type'] ??
      'application/octet-stream';

    res.setHeader('Content-Type', contentType);
    const contentLength =
      storageObject.size != null ? storageObject.size.toString() : stat.size.toString();
    res.setHeader('Content-Length', contentLength);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');

    if (stat.lastModified) {
      res.setHeader('Last-Modified', stat.lastModified.toUTCString());
    }

    if (stat.etag) {
      res.setHeader('ETag', stat.etag.startsWith('"') ? stat.etag : `"${stat.etag}"`);
    }

    const fileName = storageObject.originalName ?? objectName.split('/').pop();
    if (fileName) {
      res.setHeader(
        'Content-Disposition',
        `inline; filename=${encodeFilename(fileName)}; filename*=${encodeFilenameStar(fileName)}`,
      );
    }

    if (!objectStream) {
      res.status(200).end();
      return;
    }

    objectStream.on('error', next);

    await pipeline(objectStream, res);
  } catch (error) {
    next(error);
  }
};

storageRouter.get('/:bucket/:objectId', handleObjectRequest);
storageRouter.head('/:bucket/:objectId', handleObjectRequest);
