export interface Tag {
  id: string;
  label: string;
  category?: string | null;
}

export interface ModelAsset {
  id: string;
  slug: string;
  title: string;
  description?: string | null;
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
  dimensions?: { width: number; height: number };
  fileSize?: number | null;
  storagePath: string;
  storageBucket?: string | null;
  storageObject?: string | null;
  prompt?: string | null;
  negativePrompt?: string | null;
  metadata: ImageAssetMetadata;
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
