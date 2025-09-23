export interface Tag {
  id: string;
  label: string;
  category?: string | null;
  isAdult: boolean;
}

export type UserRole = 'USER' | 'CURATOR' | 'ADMIN';

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
  showAdultContent: boolean;
}

export interface CommentAuthor {
  id: string;
  displayName: string;
  role: UserRole;
  avatarUrl: string | null;
}

export type ModerationStatus = 'ACTIVE' | 'FLAGGED' | 'REMOVED';

export interface ModerationActorSummary {
  id: string;
  displayName: string;
  email: string;
}

export interface ModerationReport {
  id: string;
  reason?: string | null;
  createdAt: string;
  reporter: {
    id: string;
    displayName: string;
    email: string;
  };
}

export interface AssetComment {
  id: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  likeCount: number;
  viewerHasLiked: boolean;
  author: CommentAuthor;
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

export type GeneratorAccessMode = 'ADMIN_ONLY' | 'MEMBERS';

export type GeneratorBaseModelType = 'SD1.5' | 'SDXL' | 'PonyXL';

export interface GeneratorBaseModelConfig {
  type: GeneratorBaseModelType;
  name: string;
  filename: string;
}

export type GeneratorBaseModelSource = 'catalog' | 'configured';

export interface GeneratorBaseModelOption extends GeneratorBaseModelConfig {
  id: string;
  asset: ModelAsset | null;
  isMissing: boolean;
  storagePath?: string | null;
  source?: GeneratorBaseModelSource;
}

export interface GeneratorRequestBaseModelSelection {
  id: string;
  name: string;
  type?: GeneratorBaseModelType | null;
  title?: string | null;
  slug?: string | null;
  version?: string | null;
  filename?: string | null;
  source?: GeneratorBaseModelSource;
}

export interface GeneratorSettings {
  id?: string | number;
  accessMode: GeneratorAccessMode;
  baseModels: GeneratorBaseModelConfig[];
  createdAt?: string;
  updatedAt?: string;
}

export interface GeneratorRequestLoRASelection {
  id: string;
  strength: number;
  title?: string | null;
  slug?: string | null;
}

export interface GeneratorRequestSummary {
  id: string;
  status: string;
  prompt: string;
  negativePrompt?: string | null;
  seed?: string | null;
  guidanceScale?: number | null;
  steps?: number | null;
  width: number;
  height: number;
  loras: GeneratorRequestLoRASelection[];
  baseModels: GeneratorRequestBaseModelSelection[];
  baseModel: {
    id: string;
    title: string;
    slug: string;
    version: string;
    previewImage?: string | null;
    previewImageBucket?: string | null;
    previewImageObject?: string | null;
    tags: Tag[];
  };
  owner: {
    id: string;
    displayName: string;
    role: UserRole;
  };
  createdAt: string;
  updatedAt: string;
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
  moderationStatus: ModerationStatus;
  flaggedAt?: string | null;
  flaggedBy?: ModerationActorSummary | null;
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
    receivedLikeCount: number;
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
  isAdult: boolean;
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
  moderationStatus: ModerationStatus;
  flaggedAt?: string | null;
  flaggedBy?: ModerationActorSummary | null;
  moderationReports?: ModerationReport[];
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
  isAdult: boolean;
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
  likeCount: number;
  viewerHasLiked: boolean;
  moderationStatus: ModerationStatus;
  flaggedAt?: string | null;
  flaggedBy?: ModerationActorSummary | null;
  moderationReports?: ModerationReport[];
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
  isUnderModeration: boolean;
  owner: {
    id: string;
    displayName: string;
    email: string;
  };
  createdAt: string;
  updatedAt: string;
  entries: GalleryEntry[];
}

export interface AdultSafetyKeyword {
  id: string;
  label: string;
  createdAt: string;
  updatedAt: string;
}

export interface MetaStats {
  modelCount: number;
  imageCount: number;
  galleryCount: number;
  tagCount: number;
}

export interface ModerationQueue {
  models: ModelAsset[];
  images: ImageAsset[];
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
    gpu: ServiceStatusDetails;
  };
}

export interface PlatformConfig {
  siteTitle: string;
  allowRegistration: boolean;
  maintenanceMode: boolean;
}

export interface PlatformConfigResponse {
  platform: PlatformConfig;
}

export interface AdminSettingsGeneral {
  siteTitle: string;
  allowRegistration: boolean;
  maintenanceMode: boolean;
}

export interface AdminSettingsConnections {
  backendHost: string;
  frontendHost: string;
  minioEndpoint: string;
  generatorNode: string;
  publicDomain: string;
}

export interface AdminSettings {
  general: AdminSettingsGeneral;
  connections: AdminSettingsConnections;
}

export interface AdminSettingsResponse {
  settings: AdminSettings;
}

export interface AuthResponse {
  token: string;
  user: User;
}
