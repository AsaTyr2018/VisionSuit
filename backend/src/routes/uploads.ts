import crypto from 'node:crypto';

import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';

import { prisma } from '../lib/prisma';

const MAX_TOTAL_SIZE = 2_147_483_648; // 2 GB per Request

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: 12,
    fileSize: MAX_TOTAL_SIZE,
  },
});

const normalizeTagInput = (value: unknown): string[] => {
  if (value == null) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return [];
};

const createUploadSchema = z
  .object({
    assetType: z.enum(['lora', 'image']),
    title: z.string().min(1).max(180),
    description: z
      .string()
      .trim()
      .max(1500)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    visibility: z.enum(['private', 'public']),
    category: z
      .string()
      .trim()
      .max(80)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    galleryMode: z.enum(['existing', 'new']),
    targetGallery: z
      .string()
      .trim()
      .max(160)
      .optional()
      .transform((value) => (value && value.length > 0 ? value : undefined)),
    tags: z
      .array(z.string().trim().min(1).max(60))
      .max(24)
      .optional()
      .default([]),
  })
  .superRefine((data, ctx) => {
    if (data.galleryMode === 'existing' && !data.targetGallery) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targetGallery'],
        message: 'Bitte gib eine bestehende Galerie an oder wähle "Neue Galerie".',
      });
    }
  });

export const uploadsRouter = Router();

uploadsRouter.post('/', upload.array('files'), async (req, res, next) => {
  try {
    const files = (req.files ?? []) as Express.Multer.File[];

    if (files.length === 0) {
      res.status(400).json({ message: 'Mindestens eine Datei wird für den Upload benötigt.' });
      return;
    }

    const tags = normalizeTagInput(req.body.tags);
    const parseResult = createUploadSchema.safeParse({
      ...req.body,
      tags,
    });

    if (!parseResult.success) {
      const errors = parseResult.error.flatten();
      res.status(400).json({
        message: 'Übermittelte Upload-Daten sind nicht gültig.',
        errors,
      });
      return;
    }

    const payload = parseResult.data;
    const totalSize = files.reduce((sum, file) => sum + file.size, 0);

    if (totalSize > MAX_TOTAL_SIZE) {
      res.status(400).json({
        message: 'Gesamtgröße der Dateien überschreitet das Limit von 2 GB.',
      });
      return;
    }
    const uploadReference = crypto.randomUUID();

    const draft = await prisma.uploadDraft.create({
      data: {
        id: uploadReference,
        assetType: payload.assetType,
        title: payload.title,
        description: payload.description ?? null,
        visibility: payload.visibility,
        category: payload.category ?? null,
        galleryMode: payload.galleryMode,
        targetGallery: payload.galleryMode === 'existing' ? payload.targetGallery ?? null : null,
        tags: payload.tags,
        files: files.map((file) => ({
          name: file.originalname,
          size: file.size,
          type: file.mimetype,
        })),
        fileCount: files.length,
        totalSize: BigInt(totalSize),
      },
    });

    res.status(201).json({
      uploadId: draft.id,
      message:
        'Upload-Session wurde erstellt und für die Hintergrundverarbeitung vorgemerkt. Status: „queued“',
    });
  } catch (error) {
    next(error);
  }
});
