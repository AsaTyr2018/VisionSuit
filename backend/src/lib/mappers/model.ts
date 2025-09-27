import { Prisma, ModelAsset, ModelModerationReport, ModelVersion, Tag, User } from '@prisma/client';

import { resolveStorageLocation } from '../storage';

export type HydratedModelAsset = ModelAsset & {
  tags: { tag: Tag }[];
  owner: Pick<User, 'id' | 'displayName' | 'email'>;
  flaggedBy?: Pick<User, 'id' | 'displayName' | 'email'> | null;
  versions: ModelVersion[];
  moderationReports?: (ModelModerationReport & {
    reporter: Pick<User, 'id' | 'displayName' | 'email'>;
  })[];
  moderationSummary?: Prisma.JsonValue | null;
};

export type MappedModerationReport = {
  id: string;
  reason: string | null;
  createdAt: string;
  reporter: {
    id: string;
    displayName: string;
    email: string;
  };
};

export type MappedModelVersion = {
  id: string;
  version: string;
  storagePath: string;
  storageBucket: string | null;
  storageObject: string | null;
  previewImage: string | null;
  previewImageBucket: string | null;
  previewImageObject: string | null;
  fileSize: number | null;
  checksum: string | null;
  metadata: Prisma.JsonValue | null;
  createdAt: Date;
  updatedAt: Date;
  isPrimary: boolean;
};

const mapModelVersion = (
  version: {
    id: string;
    version: string;
    storagePath: string;
    previewImage?: string | null;
    fileSize?: number | null;
    checksum?: string | null;
    metadata?: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
  },
  options: { isPrimary?: boolean } = {},
): MappedModelVersion => {
  const storage = resolveStorageLocation(version.storagePath);
  const preview = resolveStorageLocation(version.previewImage);

  return {
    id: version.id,
    version: version.version,
    storagePath: storage.url ?? version.storagePath,
    storageBucket: storage.bucket,
    storageObject: storage.objectName,
    previewImage: preview.url ?? version.previewImage ?? null,
    previewImageBucket: preview.bucket,
    previewImageObject: preview.objectName,
    fileSize: version.fileSize ?? null,
    checksum: version.checksum ?? null,
    metadata: version.metadata ?? null,
    createdAt: version.createdAt,
    updatedAt: version.updatedAt,
    isPrimary: Boolean(options.isPrimary),
  };
};

const parseNumericVersion = (value: string) => {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : null;
};

const compareVersionLabels = (a: string, b: string) => {
  const numericA = parseNumericVersion(a);
  const numericB = parseNumericVersion(b);

  if (numericA !== null && numericB !== null && numericA !== numericB) {
    return numericA - numericB;
  }

  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
};

const sortVersionsForDisplay = (a: MappedModelVersion, b: MappedModelVersion) => {
  if (a.isPrimary && !b.isPrimary) {
    return -1;
  }
  if (b.isPrimary && !a.isPrimary) {
    return 1;
  }

  if (a.isPrimary && b.isPrimary) {
    return 0;
  }

  return compareVersionLabels(a.version, b.version);
};

const getVersionRecency = (entry: MappedModelVersion) => {
  const created = new Date(entry.createdAt).getTime();
  const updated = new Date(entry.updatedAt).getTime();
  return Math.max(created, updated);
};

const sortVersionsByCreatedAtDesc = (a: MappedModelVersion, b: MappedModelVersion) =>
  getVersionRecency(b) - getVersionRecency(a);

export const mapModelAsset = (asset: HydratedModelAsset) => {
  const primaryVersionSource = asset.versions.find((entry) => entry.storagePath === asset.storagePath);
  const additionalVersionSources = asset.versions.filter((entry) => entry.storagePath !== asset.storagePath);

  const primaryVersion = mapModelVersion(
    {
      id: asset.id,
      version: asset.version,
      storagePath: asset.storagePath,
      previewImage: asset.previewImage,
      fileSize: asset.fileSize,
      checksum: asset.checksum,
      metadata: asset.metadata,
      createdAt: primaryVersionSource?.createdAt ?? asset.createdAt,
      updatedAt: primaryVersionSource?.updatedAt ?? asset.updatedAt,
    },
    { isPrimary: true },
  );

  const mappedAdditionalVersions = additionalVersionSources.map((entry) =>
    mapModelVersion(
      {
        id: entry.id,
        version: entry.version,
        storagePath: entry.storagePath,
        previewImage: entry.previewImage,
        fileSize: entry.fileSize,
        checksum: entry.checksum,
        metadata: entry.metadata,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      },
      { isPrimary: false },
    ),
  );

  const combinedVersions = [primaryVersion, ...mappedAdditionalVersions];
  const orderedVersions = [...combinedVersions].sort(sortVersionsForDisplay);
  const latestVersion = [...combinedVersions].sort(sortVersionsByCreatedAtDesc)[0] ?? primaryVersion;

  return {
    id: asset.id,
    slug: asset.slug,
    title: asset.title,
    description: asset.description,
    trigger: asset.trigger,
    isPublic: asset.isPublic,
    isAdult: asset.isAdult,
    version: latestVersion.version,
    fileSize: latestVersion.fileSize,
    checksum: latestVersion.checksum,
    storagePath: latestVersion.storagePath,
    storageBucket: latestVersion.storageBucket,
    storageObject: latestVersion.storageObject,
    previewImage: latestVersion.previewImage,
    previewImageBucket: latestVersion.previewImageBucket,
    previewImageObject: latestVersion.previewImageObject,
    metadata: latestVersion.metadata,
    owner: asset.owner,
    tags: asset.tags.map(({ tag }) => tag),
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
    versions: orderedVersions,
    latestVersionId: latestVersion.id,
    primaryVersionId: primaryVersion.id,
    moderationStatus: asset.moderationStatus,
    flaggedAt: asset.flaggedAt,
    flaggedBy: asset.flaggedBy
      ? {
          id: asset.flaggedBy.id,
          displayName: asset.flaggedBy.displayName,
          email: asset.flaggedBy.email,
        }
      : null,
    ...(asset.moderationReports
      ? {
          moderationReports: asset.moderationReports.map<MappedModerationReport>((report) => ({
            id: report.id,
            reason: report.reason ?? null,
            createdAt: report.createdAt.toISOString(),
            reporter: {
              id: report.reporter.id,
              displayName: report.reporter.displayName,
              email: report.reporter.email,
            },
          })),
        }
      : {}),
  };
};
