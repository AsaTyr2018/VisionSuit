import type { ModerationStatus, User } from '../types/api';

export const isAuditPlaceholderForViewer = (
  moderationStatus: ModerationStatus,
  ownerId: string,
  viewer?: User | null,
) => {
  if (!viewer) {
    return false;
  }

  if (viewer.role === 'ADMIN') {
    return false;
  }

  return moderationStatus === 'FLAGGED' && viewer.id === ownerId;
};
