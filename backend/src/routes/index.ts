import { Router } from 'express';

import { assetsRouter } from './assets';
import { authRouter } from './auth';
import { galleriesRouter } from './galleries';
import { metaRouter } from './meta';
import { uploadsRouter } from './uploads';
import { storageRouter } from './storage';
import { usersRouter } from './users';
import { rankingsRouter } from './rankings';

export const router = Router();

router.use('/auth', authRouter);
router.use('/assets', assetsRouter);
router.use('/galleries', galleriesRouter);
router.use('/meta', metaRouter);
router.use('/uploads', uploadsRouter);
router.use('/storage', storageRouter);
router.use('/users', usersRouter);
router.use('/rankings', rankingsRouter);
