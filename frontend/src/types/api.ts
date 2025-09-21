export interface Tag {
  id: string;
  label: string;
  category?: string | null;
}

export type UserRole = 'CURATOR' | 'ADMIN';

export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  bio?: string | null;
  avatarUrl?: string | null;
  isActive?: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserProfileRank {
  label: string;
  description: string;
  minimumScore: number;
  nextLabel: string | null;
  nextScore: number | null;
  score: number;
  isBlocked: boolean;
}

export interface RankingSettings {
  id?: string;
  modelWeight: number;
  galleryWeight: number;
  imageWeight: number;
  isFallback?: boolean;
}

export interface RankTier {
  id?: string;
  label: string;
  description: string;
  minimumScore: number;
  position?: number;
  isActive?: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserProfileModelSummary {
  id: string;
  title: string;
  slug: string;
  version: string;
  description?: string | null;
  isPublic: boolean;
  previewImage?: string | null;
  previewImageBucket?: string | null;
  previewImageObject?: string | null;
  updatedAt: string;
  createdAt: string;
  tags: Tag[];
}

export interface UserProfileGallerySummary {
  id: string;
  title: string;
  slug: string;
  description?: string | null;
  isPublic: boolean;
  coverImage?: string | null;
  coverImageBucket?: string | null;
  coverImageObject?: string | null;
  updatedAt: string;
  createdAt: string;
  stats: {
    entryCount: number;
    imageCount: number;
    modelCount: number;
  };
}

export interface UserProfile {
  id: string;
  displayName: string;
  bio: string | null;
  avatarUrl: string | null;
  role: UserRole;
  joinedAt: string;
  rank: UserProfileRank;
  stats: {
    modelCount: number;
    galleryCount: number;
    imageCount: number;
  };
  models: UserProfileModelSummary[];
  galleries: UserProfileGallerySummary[];
  visibility?: {
    includePrivate: boolean;
    audit: boolean;
  };
}

export interface ModelVersion {
  id: string;
  version: string;
  storagePath: string;
  storageBucket?: string | null;
  storageObject?: string | null;
  previewImage?: string | null;
  previewImageBucket?: string | null;
  previewImageObject?: string | null;
  fileSize?: number | null;
  checksum?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  isPrimary: boolean;
}

export interface ModelAsset {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  trigger?: string | null;
  isPublic: boolean;
  version: string;
  fileSize?: number | null;
  checksum?: string | null;
  storagePath: string;
  storageBucket?: string | null;
  storageObject?: string | null;
  previewImage?: string | null;
  previewImageBucket?: string | null;
  previewImageObject?: string | null;
  metadata?: Record<string, unknown> | null;
  owner: {
    id: string;
    displayName: string;
    email: string;
  };
  tags: Tag[];
  versions: ModelVersion[];
  latestVersionId: string;
  primaryVersionId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ImageAssetMetadata {
  seed?: string | null;
  model?: string | null;
  sampler?: string | null;
  cfgScale?: number | null;
  steps?: number | null;
}

export interface ImageAsset {
  id: string;
  title: string;
  description?: string | null;
  isPublic: boolean;
  dimensions?: { width: number; height: number };
  fileSize?: number | null;
  storagePath: string;
  storageBucket?: string | null;
  storageObject?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  metadata?: ImageAssetMetadata | null;
  owner: {
    id: string;
    displayName: string;
    email: string;
  };
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
}

export interface GalleryEntry {
  id: string;
  position: number;
  note?: string | null;
  modelAsset?: ModelAsset | null;
  imageAsset?: ImageAsset | null;
}

export interface Gallery {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
  coverImage?: string | null;
  coverImageBucket?: string | null;
  coverImageObject?: string | null;
  isPublic: boolean;
  owner: {
    id: string;
    displayName: string;
    email: string;
  };
  createdAt: string;
  updatedAt: string;
  entries: GalleryEntry[];
}

export interface MetaStats {
  modelCount: number;
  imageCount: number;
  galleryCount: number;
  tagCount: number;
}

export type ServiceHealthStatus = 'online' | 'offline' | 'degraded';

export interface ServiceStatusDetails {
  status: ServiceHealthStatus;
  message?: string | null;
}

export interface ServiceStatusResponse {
  timestamp: string;
  services: {
    backend: ServiceStatusDetails;
    minio: ServiceStatusDetails;
  };
}

export interface AuthResponse {
  token: string;
  user: User;
}
