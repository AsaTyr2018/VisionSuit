import { Router } from 'express';
import { z } from 'zod';

import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { applyAdminSettings, getAdminSettings, type AdminSettings } from '../lib/settings';
import { scheduleAdultKeywordRecalculation } from './safety';

const trimmedString = z.string().trim();

const metadataThresholdSchema = z.object({
  adult: z
    .number()
    .int('Adult metadata threshold must be a whole number.')
    .min(0, 'Adult metadata threshold cannot be negative.')
    .max(250, 'Adult metadata threshold is too large.'),
  minor: z
    .number()
    .int('Minor metadata threshold must be a whole number.')
    .min(0, 'Minor metadata threshold cannot be negative.')
    .max(250, 'Minor metadata threshold is too large.'),
  beast: z
    .number()
    .int('Bestiality metadata threshold must be a whole number.')
    .min(0, 'Bestiality metadata threshold cannot be negative.')
    .max(250, 'Bestiality metadata threshold is too large.'),
});

const settingsSchema = z.object({
  general: z.object({
    siteTitle: trimmedString.min(1, 'Site title is required.').max(120, 'Site title is too long.'),
    allowRegistration: z.boolean(),
    maintenanceMode: z.boolean(),
    bypassNsfwFilter: z.boolean(),
  }),
  connections: z.object({
    backendHost: trimmedString.min(1, 'Backend host is required.').max(255, 'Backend host is too long.'),
    frontendHost: trimmedString.min(1, 'Frontend host is required.').max(255, 'Frontend host is too long.'),
    minioEndpoint: trimmedString.min(1, 'MinIO endpoint is required.').max(255, 'MinIO endpoint is too long.'),
    generatorNode: z
      .string()
      .optional()
      .transform((value) => (value ?? '').trim())
      .pipe(z.string().max(255, 'GPU node address is too long.')),
    publicDomain: z
      .string()
      .optional()
      .transform((value) => (value ?? '').trim())
      .pipe(z.string().max(255, 'Domain is too long.')),
  }),
  safety: z.object({
    metadataThresholds: metadataThresholdSchema,
  }),
});

export const settingsRouter = Router();

settingsRouter.use(requireAuth, requireAdmin);

settingsRouter.get('/', async (_req, res, next) => {
  try {
    const settings = await getAdminSettings();
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

settingsRouter.put('/', async (req, res, next) => {
  try {
    const parsed = settingsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid settings payload.', errors: parsed.error.flatten() });
      return;
    }

    const existing = await getAdminSettings();
    const payload: AdminSettings = {
      ...parsed.data,
      safety: {
        ...parsed.data.safety,
        imageAnalysis: existing.safety.imageAnalysis,
      },
    };

    const result = await applyAdminSettings(payload);
    if (result.metadataThresholdsChanged) {
      void scheduleAdultKeywordRecalculation();
    }

    res.json({ settings: result.settings });
  } catch (error) {
    next(error);
  }
});

