import { EventEmitter } from 'node:events';

import type { Notification, NotificationType, Prisma } from '@prisma/client';

import { prisma } from './prisma';

export type NotificationCategory = 'announcements' | 'moderation' | 'likes' | 'comments';

export interface NotificationViewModel {
  id: string;
  type: NotificationType;
  title: string;
  body: string | null;
  data: unknown | null;
  readAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationEventPayload {
  notification: NotificationViewModel;
  unreadCounts: Record<NotificationCategory, number>;
  totalUnread: number;
}

export type NotificationDeck = Record<NotificationCategory, NotificationViewModel[]>;

const notificationTypeToCategory: Record<NotificationType, NotificationCategory> = {
  ANNOUNCEMENT: 'announcements',
  MODERATION: 'moderation',
  MODERATION_QUEUE: 'moderation',
  LIKE: 'likes',
  COMMENT: 'comments',
};

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

const cloneJsonValue = (value: Prisma.JsonValue | null): unknown | null => {
  if (value == null) {
    return null;
  }

  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return value;
  }
};

export const serializeNotification = (notification: Notification): NotificationViewModel => ({
  id: notification.id,
  type: notification.type,
  title: notification.title,
  body: notification.body ?? null,
  data: cloneJsonValue(notification.data),
  readAt: notification.readAt ? notification.readAt.toISOString() : null,
  createdAt: notification.createdAt.toISOString(),
  updatedAt: notification.updatedAt.toISOString(),
});

const calculateUnreadCounts = async (
  userId: string,
): Promise<Record<NotificationCategory, number>> => {
  const groups = await prisma.notification.groupBy({
    by: ['type'],
    where: { userId, readAt: null },
    _count: { _all: true },
  });

  const announcements = groups.find((group) => group.type === 'ANNOUNCEMENT')?._count._all ?? 0;
  const moderationDecisions = groups.find((group) => group.type === 'MODERATION')?._count._all ?? 0;
  const moderationQueue = groups.find((group) => group.type === 'MODERATION_QUEUE')?._count._all ?? 0;
  const likes = groups.find((group) => group.type === 'LIKE')?._count._all ?? 0;
  const comments = groups.find((group) => group.type === 'COMMENT')?._count._all ?? 0;

  return {
    announcements,
    moderation: moderationDecisions + moderationQueue,
    likes,
    comments,
  };
};

const buildEventPayload = async (
  userId: string,
  notification: Notification,
): Promise<NotificationEventPayload> => {
  const unreadCounts = await calculateUnreadCounts(userId);
  const totalUnread = Object.values(unreadCounts).reduce((sum, value) => sum + value, 0);

  return {
    notification: serializeNotification(notification),
    unreadCounts,
    totalUnread,
  };
};

export const publishNotification = async (
  userId: string,
  notification: Notification,
) => {
  const payload = await buildEventPayload(userId, notification);
  emitter.emit(userId, payload);
  return payload;
};

export const subscribeToNotifications = (
  userId: string,
  listener: (event: NotificationEventPayload) => void,
) => {
  const handler = (event: NotificationEventPayload) => listener(event);
  emitter.on(userId, handler);

  return () => {
    emitter.off(userId, handler);
  };
};

export interface CreateNotificationOptions {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  data?: Prisma.JsonValue | null;
  markAsRead?: boolean;
}

export const createNotification = async (
  options: CreateNotificationOptions,
) => {
  const notification = await prisma.notification.create({
    data: {
      userId: options.userId,
      type: options.type,
      title: options.title,
      body: options.body ?? null,
      data: options.data ?? null,
      readAt: options.markAsRead ? new Date() : null,
    },
  });

  await publishNotification(options.userId, notification);
  return notification;
};

export const getNotificationsForUser = async (
  userId: string,
): Promise<{ deck: NotificationDeck; unreadCounts: Record<NotificationCategory, number>; totalUnread: number }> => {
  const notifications = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });

  const deck: NotificationDeck = {
    announcements: [],
    moderation: [],
    likes: [],
    comments: [],
  };

  for (const notification of notifications) {
    const viewModel = serializeNotification(notification);
    const category = notificationTypeToCategory[notification.type];
    deck[category] = [...deck[category], viewModel];
  }

  const unreadCounts = await calculateUnreadCounts(userId);
  const totalUnread = Object.values(unreadCounts).reduce((sum, value) => sum + value, 0);

  return { deck, unreadCounts, totalUnread };
};

export const markNotificationsAsRead = async (
  userId: string,
  options: { ids?: string[]; type?: NotificationType | null } = {},
) => {
  const where: Prisma.NotificationWhereInput = { userId };

  if (options.ids && options.ids.length > 0) {
    where.id = { in: options.ids };
  }

  if (options.type) {
    where.type = options.type;
  }

  const existing = await prisma.notification.findMany({
    where: { ...where, readAt: null },
    select: { id: true },
  });

  if (existing.length > 0) {
    await prisma.notification.updateMany({
      where: { id: { in: existing.map((entry) => entry.id) } },
      data: { readAt: new Date() },
    });
  }

  const unreadCounts = await calculateUnreadCounts(userId);
  const totalUnread = Object.values(unreadCounts).reduce((sum, value) => sum + value, 0);

  return { unreadCounts, totalUnread, updatedIds: existing.map((entry) => entry.id) };
};

export const getNotificationCategory = (type: NotificationType): NotificationCategory =>
  notificationTypeToCategory[type];
