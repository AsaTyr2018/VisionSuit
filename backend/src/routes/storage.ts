import type { Request, Response, NextFunction } from 'express';
import { Router } from 'express';
import { pipeline } from 'node:stream/promises';

import { prisma } from '../lib/prisma';
import { storageBuckets, storageClient } from '../lib/storage';

const allowedBuckets = new Set(Object.values(storageBuckets));

const encodeFilename = (value: string) =>
  `"${value.replace(/"/g, '\\"')}"`;

const encodeFilenameStar = (value: string) =>
  `UTF-8''${encodeURIComponent(value)}`;

const sendNotFound = (res: Response) => {
  res.status(404).json({ message: 'The requested file was not found.' });
};

const sendBucketNotAllowed = (res: Response) => {
  res.status(404).json({ message: 'The requested storage bucket is unknown.' });
};

export const storageRouter = Router();

type AccessDecision = 'allow' | 'unauthorized' | 'forbidden' | 'not-found';

const evaluateOwnershipAccess = (
  viewer: Request['user'],
  ownerId: string,
  isPublic: boolean,
): AccessDecision => {
  if (isPublic) {
    return 'allow';
  }

  if (!viewer) {
    return 'unauthorized';
  }

  if (viewer.role === 'ADMIN' || viewer.id === ownerId) {
    return 'allow';
  }

  return 'forbidden';
};

const resolveAccessDecision = async (
  viewer: Request['user'],
  objectUri: string,
): Promise<AccessDecision> => {
  const image = await prisma.imageAsset.findFirst({
    where: { storagePath: objectUri },
    select: { ownerId: true, isPublic: true },
  });

  if (image) {
    return evaluateOwnershipAccess(viewer, image.ownerId, image.isPublic);
  }

  const modelAsset = await prisma.modelAsset.findFirst({
    where: {
      OR: [{ storagePath: objectUri }, { previewImage: objectUri }],
    },
    select: { ownerId: true, isPublic: true },
  });

  if (modelAsset) {
    return evaluateOwnershipAccess(viewer, modelAsset.ownerId, modelAsset.isPublic);
  }

  const modelVersion = await prisma.modelVersion.findFirst({
    where: {
      OR: [{ storagePath: objectUri }, { previewImage: objectUri }],
    },
    select: {
      model: { select: { ownerId: true, isPublic: true } },
    },
  });

  if (modelVersion?.model) {
    return evaluateOwnershipAccess(viewer, modelVersion.model.ownerId, modelVersion.model.isPublic);
  }

  const gallery = await prisma.gallery.findFirst({
    where: { coverImage: objectUri },
    select: { ownerId: true, isPublic: true },
  });

  if (gallery) {
    return evaluateOwnershipAccess(viewer, gallery.ownerId, gallery.isPublic);
  }

  const userWithAvatar = await prisma.user.findFirst({
    where: { avatarUrl: objectUri },
    select: { id: true },
  });

  if (userWithAvatar) {
    return 'allow';
  }

  return 'not-found';
};

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

    const objectUri = `s3://${bucket}/${objectName}`;
    const accessDecision = await resolveAccessDecision(req.user, objectUri);

    if (accessDecision === 'unauthorized') {
      res.status(401).json({ message: 'Authentication is required to access this object.' });
      return;
    }

    if (accessDecision === 'forbidden') {
      res.status(403).json({ message: 'Not authorized to access this object.' });
      return;
    }

    if (accessDecision === 'not-found') {
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
