import { Router } from 'express';
import { z } from 'zod';

import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { applyAdminSettings, getAdminSettings } from '../lib/settings';

const trimmedString = z.string().trim();

const settingsSchema = z.object({
  general: z.object({
    siteTitle: trimmedString.min(1, 'Site title is required.').max(120, 'Site title is too long.'),
    allowRegistration: z.boolean(),
    maintenanceMode: z.boolean(),
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

    const updated = await applyAdminSettings(parsed.data);
    res.json({ settings: updated });
  } catch (error) {
    next(error);
  }
});

