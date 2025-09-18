import { Router } from 'express';

import { assetsRouter } from './assets';
import { galleriesRouter } from './galleries';
import { metaRouter } from './meta';
import { uploadsRouter } from './uploads';

export const router = Router();

router.use('/assets', assetsRouter);
router.use('/galleries', galleriesRouter);
router.use('/meta', metaRouter);
router.use('/uploads', uploadsRouter);
