import type { StorageLocation } from './storage';
import { resolveStorageLocation } from './storage';

const buildAvatarProxyPath = (userId: string) => `/api/users/${encodeURIComponent(userId)}/avatar`;

interface ResolveOptions {
  origin?: string | null;
  location?: StorageLocation;
}

export const resolveAvatarUrl = (
  userId: string,
  avatarValue: string | null | undefined,
  options?: ResolveOptions,
) => {
  const location = options?.location ?? resolveStorageLocation(avatarValue ?? undefined);

  if (location.bucket && location.objectName) {
    const path = buildAvatarProxyPath(userId);
    const origin = options?.origin?.replace(/\/$/, '');
    return origin ? `${origin}${path}` : path;
  }

  return location.url ?? avatarValue ?? null;
};
