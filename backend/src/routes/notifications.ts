import { Router } from 'express';
import { z } from 'zod';

import { prisma } from '../lib/prisma';
import {
  createNotification,
  getNotificationsForUser,
  markNotificationsAsRead,
  subscribeToNotifications,
  serializeNotification,
} from '../lib/notifications';
import { requireAdmin, requireAuth } from '../lib/middleware/auth';
import type { NotificationType } from '@prisma/client';

export const notificationsRouter = Router();

notificationsRouter.get('/', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentication required.' });
      return;
    }

    const summary = await getNotificationsForUser(req.user.id);
    res.json({
      notifications: summary.deck,
      unreadCounts: summary.unreadCounts,
      totalUnread: summary.totalUnread,
    });
  } catch (error) {
    next(error);
  }
});

notificationsRouter.get('/stream', requireAuth, (req, res) => {
  if (!req.user) {
    res.status(401).json({ message: 'Authentication required.' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  res.flushHeaders?.();

  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  sendEvent('ready', { timestamp: new Date().toISOString() });

  const unsubscribe = subscribeToNotifications(req.user.id, (payload) => {
    sendEvent('notification', payload);
  });

  const keepAlive = setInterval(() => {
    sendEvent('heartbeat', { timestamp: new Date().toISOString() });
  }, 30000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

const announcementSchema = z.object({
  title: z.string().trim().min(3).max(160),
  message: z.string().trim().min(1).max(800),
});

notificationsRouter.post('/announcements', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentication required.' });
      return;
    }

    const parsed = announcementSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid announcement payload.', errors: parsed.error.flatten() });
      return;
    }

    const recipients = await prisma.user.findMany({
      where: { isActive: true },
      select: { id: true },
    });

    const data = {
      category: 'announcement' as const,
      authorId: req.user.id,
      authorName: req.user.displayName,
    };

    for (const recipient of recipients) {
      await createNotification({
        userId: recipient.id,
        type: 'ANNOUNCEMENT',
        title: parsed.data.title,
        body: parsed.data.message,
        data,
      });
    }

    res.status(201).json({ recipients: recipients.length });
  } catch (error) {
    next(error);
  }
});

notificationsRouter.post('/:id/read', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentication required.' });
      return;
    }

    const { id } = req.params;
    if (!id) {
      res.status(400).json({ message: 'Notification ID missing.' });
      return;
    }

    const notification = await prisma.notification.findFirst({
      where: { id, userId: req.user.id },
    });

    if (!notification) {
      res.status(404).json({ message: 'Notification not found.' });
      return;
    }

    const { unreadCounts, totalUnread } = await markNotificationsAsRead(req.user.id, { ids: [id] });
    const refreshed = await prisma.notification.findUnique({ where: { id } });

    if (!refreshed) {
      res.status(404).json({ message: 'Notification not found.' });
      return;
    }

    res.json({
      notification: serializeNotification(refreshed),
      unreadCounts,
      totalUnread,
    });
  } catch (error) {
    next(error);
  }
});

const markAllSchema = z.object({
  category: z.enum(['announcements', 'moderation', 'likes', 'comments']).optional(),
});

const categoryToType: Record<string, NotificationType> = {
  announcements: 'ANNOUNCEMENT',
  moderation: 'MODERATION',
  likes: 'LIKE',
  comments: 'COMMENT',
};

notificationsRouter.post('/read-all', requireAuth, async (req, res, next) => {
  try {
    if (!req.user) {
      res.status(401).json({ message: 'Authentication required.' });
      return;
    }

    const parsed = markAllSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ message: 'Invalid request body.', errors: parsed.error.flatten() });
      return;
    }

    const category = parsed.data.category;
    const type = category ? categoryToType[category] : null;

    const { unreadCounts, totalUnread, updatedIds } = await markNotificationsAsRead(req.user.id, {
      type,
    });

    res.json({ unreadCounts, totalUnread, updatedIds });
  } catch (error) {
    next(error);
  }
});
