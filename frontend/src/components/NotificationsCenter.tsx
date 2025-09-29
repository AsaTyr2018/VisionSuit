import { useMemo, useState } from 'react';

import type {
  NotificationCategory,
  NotificationItem,
} from '../types/api';

const categoryConfig: Record<NotificationCategory, { label: string; description: string; empty: string }> = {
  announcements: {
    label: 'Announcements',
    description: 'Broadcast updates from the administrator team.',
    empty: 'No announcements yet.',
  },
  moderation: {
    label: 'Moderation',
    description: 'Decisions for your models and images with reviewer notes.',
    empty: 'No moderation updates yet.',
  },
  likes: {
    label: 'Likes',
    description: 'Reactions to your models and images.',
    empty: 'No likes recorded yet.',
  },
  comments: {
    label: 'Comments',
    description: 'Feedback on your published work.',
    empty: 'No comments yet.',
  },
};

const dateFormatter = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const resolveNotificationCopy = (notification: NotificationItem) => {
  const data = (notification.data ?? {}) as Record<string, unknown>;
  const category = typeof data.category === 'string' ? data.category : undefined;
  const actorName = typeof data.actorName === 'string' ? data.actorName : null;
  const entityTitle = typeof data.entityTitle === 'string' ? data.entityTitle : null;

  if (category === 'like' && actorName) {
    return {
      heading: notification.title,
      body: notification.body,
      caption: entityTitle ? `Asset: ${entityTitle}` : null,
    };
  }

  if (category === 'comment' && actorName) {
    return {
      heading: notification.title,
      body: notification.body,
      caption: entityTitle ? `Asset: ${entityTitle}` : null,
    };
  }

  if (category === 'moderation') {
    return {
      heading: notification.title,
      body: notification.body,
      caption: entityTitle ? `Asset: ${entityTitle}` : null,
    };
  }

  return {
    heading: notification.title,
    body: notification.body,
    caption: null as string | null,
  };
};

const getNotificationActions = (
  notification: NotificationItem,
  onOpenModel?: (modelId: string) => void,
  onOpenImage?: (imageId: string) => void,
) => {
  const data = (notification.data ?? {}) as Record<string, unknown>;
  const entityType = typeof data.entityType === 'string' ? data.entityType : undefined;
  const entityId = typeof data.entityId === 'string' ? data.entityId : undefined;

  if (!entityType || !entityId) {
    return null;
  }

  if (entityType === 'model' && onOpenModel) {
    return () => onOpenModel(entityId);
  }

  if (entityType === 'image' && onOpenImage) {
    return () => onOpenImage(entityId);
  }

  return null;
};

export interface NotificationsCenterProps {
  notifications: Record<NotificationCategory, NotificationItem[]>;
  unreadCounts: Record<NotificationCategory, number>;
  onMarkNotificationRead: (notification: NotificationItem, category: NotificationCategory) => void;
  onMarkCategoryRead: (category: NotificationCategory | null) => void;
  onOpenModel?: (modelId: string) => void;
  onOpenImage?: (imageId: string) => void;
}

export const NotificationsCenter = ({
  notifications,
  unreadCounts,
  onMarkNotificationRead,
  onMarkCategoryRead,
  onOpenModel,
  onOpenImage,
}: NotificationsCenterProps) => {
  const [activeCategory, setActiveCategory] = useState<NotificationCategory>('announcements');

  const activeNotifications = notifications[activeCategory] ?? [];
  const unreadTotal = useMemo(
    () => Object.values(unreadCounts ?? {}).reduce((sum, value) => sum + (value ?? 0), 0),
    [unreadCounts],
  );

  return (
    <section className="notifications" aria-label="Notification center">
      <header className="notifications__header">
        <div>
          <h2 className="notifications__title">Notifications</h2>
          <p className="notifications__subtitle">
            {categoryConfig[activeCategory].description}
          </p>
        </div>
        <div className="notifications__summary">
          <span className="notifications__badge">{unreadTotal} unread</span>
          <button
            type="button"
            className="notifications__clear"
            onClick={() => onMarkCategoryRead(activeCategory)}
            disabled={activeNotifications.every((entry) => entry.readAt)}
          >
            Mark visible as read
          </button>
        </div>
      </header>

      <nav className="notifications__tabs" aria-label="Notification types">
        {(Object.keys(categoryConfig) as NotificationCategory[]).map((category) => {
          const unread = unreadCounts[category] ?? 0;
          return (
            <button
              key={category}
              type="button"
              className={`notifications__tab${activeCategory === category ? ' notifications__tab--active' : ''}`}
              onClick={() => setActiveCategory(category)}
            >
              <span>{categoryConfig[category].label}</span>
              {unread > 0 ? <span className="notifications__tab-badge">{unread}</span> : null}
            </button>
          );
        })}
      </nav>

      <div className="notifications__list" role="list">
        {activeNotifications.length === 0 ? (
          <p className="notifications__empty">{categoryConfig[activeCategory].empty}</p>
        ) : (
          activeNotifications.map((notification) => {
            const content = resolveNotificationCopy(notification);
            const isUnread = !notification.readAt;
            const action = getNotificationActions(notification, onOpenModel, onOpenImage);

            return (
              <article
                key={notification.id}
                className={`notification-card${isUnread ? ' notification-card--unread' : ''}`}
                role="listitem"
              >
                <div className="notification-card__body">
                  <div className="notification-card__title-row">
                    <h3 className="notification-card__title">{content.heading}</h3>
                    <time className="notification-card__timestamp" dateTime={notification.createdAt}>
                      {dateFormatter.format(new Date(notification.createdAt))}
                    </time>
                  </div>
                  {content.caption ? (
                    <p className="notification-card__caption">{content.caption}</p>
                  ) : null}
                  {content.body ? <p className="notification-card__message">{content.body}</p> : null}
                </div>
                <div className="notification-card__actions">
                  {isUnread ? (
                    <button
                      type="button"
                      className="notification-card__action"
                      onClick={() => onMarkNotificationRead(notification, activeCategory)}
                    >
                      Mark read
                    </button>
                  ) : null}
                  {action ? (
                    <button
                      type="button"
                      className="notification-card__action notification-card__action--primary"
                      onClick={action}
                    >
                      View item
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })
        )}
      </div>
    </section>
  );
};
