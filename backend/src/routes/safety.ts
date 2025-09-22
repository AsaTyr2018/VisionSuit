import { Prisma } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import { prisma } from '../lib/prisma';
import { listAdultSafetyKeywords } from '../lib/adult-keywords';

export const safetyRouter = Router();

safetyRouter.use(requireAuth, requireAdmin);

const createKeywordSchema = z.object({
  label: z
    .string()
    .trim()
    .min(1, 'Keyword label cannot be empty.')
    .max(120, 'Keyword label must be 120 characters or fewer.'),
});

safetyRouter.get('/keywords', async (_req, res, next) => {
  try {
    const keywords = await listAdultSafetyKeywords();
    res.json({ keywords });
  } catch (error) {
    next(error);
  }
});

safetyRouter.post('/keywords', async (req, res, next) => {
  try {
    const parsed = createKeywordSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid payload.', errors: parsed.error.flatten() });
      return;
    }

    const keyword = await prisma.adultSafetyKeyword.create({
      data: { label: parsed.data.label },
    });

    res.status(201).json({ keyword });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      res.status(409).json({ message: 'A keyword with this label already exists.' });
      return;
    }

    next(error);
  }
});

safetyRouter.delete('/keywords/:id', async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'Keyword ID is required.' });
      return;
    }

    await prisma.adultSafetyKeyword.delete({ where: { id } });

    res.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      res.status(404).json({ message: 'Keyword not found.' });
      return;
    }

    next(error);
  }
});
