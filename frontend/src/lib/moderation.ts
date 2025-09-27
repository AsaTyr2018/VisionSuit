import type { ModerationStatus, User } from '../types/api';

export type AuditVisibilityState = 'visible' | 'placeholder' | 'hidden';

export const getAuditVisibilityStateForViewer = (
  moderationStatus: ModerationStatus,
  ownerId: string,
  viewer?: User | null,
): AuditVisibilityState => {
  if (moderationStatus !== 'FLAGGED') {
    return 'visible';
  }

  if (viewer?.role === 'ADMIN') {
    return 'visible';
  }

  if (viewer && viewer.id === ownerId) {
    return 'placeholder';
  }

  return 'hidden';
};

export const isAuditPlaceholderForViewer = (
  moderationStatus: ModerationStatus,
  ownerId: string,
  viewer?: User | null,
) => getAuditVisibilityStateForViewer(moderationStatus, ownerId, viewer) === 'placeholder';

export const isAuditHiddenFromViewer = (
  moderationStatus: ModerationStatus,
  ownerId: string,
  viewer?: User | null,
) => getAuditVisibilityStateForViewer(moderationStatus, ownerId, viewer) === 'hidden';
