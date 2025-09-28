-- RedefineTables to add moderation summary metadata to assets and versions
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_ModelAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "trigger" TEXT,
    "version" TEXT NOT NULL,
    "fileSize" INTEGER,
    "checksum" TEXT,
    "storagePath" TEXT NOT NULL,
    "previewImage" TEXT,
    "metadata" JSONB,
    "moderationSummary" JSONB,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "isAdult" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "moderationStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "flaggedAt" DATETIME,
    "flaggedById" TEXT,
    CONSTRAINT "ModelAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ModelAsset_flaggedById_fkey" FOREIGN KEY ("flaggedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_ModelAsset" (
    "checksum",
    "createdAt",
    "description",
    "fileSize",
    "flaggedAt",
    "flaggedById",
    "id",
    "isAdult",
    "isPublic",
    "metadata",
    "moderationStatus",
    "ownerId",
    "previewImage",
    "slug",
    "storagePath",
    "title",
    "trigger",
    "updatedAt",
    "version"
)
SELECT
    "checksum",
    "createdAt",
    "description",
    "fileSize",
    "flaggedAt",
    "flaggedById",
    "id",
    "isAdult",
    "isPublic",
    "metadata",
    "moderationStatus",
    "ownerId",
    "previewImage",
    "slug",
    "storagePath",
    "title",
    "trigger",
    "updatedAt",
    "version"
FROM "ModelAsset";

DROP TABLE "ModelAsset";
ALTER TABLE "new_ModelAsset" RENAME TO "ModelAsset";
CREATE UNIQUE INDEX "ModelAsset_slug_key" ON "ModelAsset"("slug");
CREATE UNIQUE INDEX "ModelAsset_storagePath_key" ON "ModelAsset"("storagePath");

CREATE TABLE "new_ModelVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "previewImage" TEXT,
    "metadata" JSONB,
    "moderationSummary" JSONB,
    "fileSize" INTEGER,
    "checksum" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelVersion_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ModelAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

INSERT INTO "new_ModelVersion" (
    "checksum",
    "createdAt",
    "fileSize",
    "id",
    "metadata",
    "modelId",
    "previewImage",
    "storagePath",
    "updatedAt",
    "version"
)
SELECT
    "checksum",
    "createdAt",
    "fileSize",
    "id",
    "metadata",
    "modelId",
    "previewImage",
    "storagePath",
    "updatedAt",
    "version"
FROM "ModelVersion";

DROP TABLE "ModelVersion";
ALTER TABLE "new_ModelVersion" RENAME TO "ModelVersion";
CREATE UNIQUE INDEX "ModelVersion_storagePath_key" ON "ModelVersion"("storagePath");
CREATE UNIQUE INDEX "ModelVersion_modelId_version_key" ON "ModelVersion"("modelId", "version");

CREATE TABLE "new_ImageAsset" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "width" INTEGER,
    "height" INTEGER,
    "fileSize" INTEGER,
    "storagePath" TEXT NOT NULL,
    "prompt" TEXT,
    "negativePrompt" TEXT,
    "seed" TEXT,
    "model" TEXT,
    "sampler" TEXT,
    "cfgScale" REAL,
    "steps" INTEGER,
    "moderationSummary" JSONB,
    "autoTagSummary" JSONB,
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "isAdult" BOOLEAN NOT NULL DEFAULT false,
    "tagScanPending" BOOLEAN NOT NULL DEFAULT false,
    "tagScanStatus" TEXT NOT NULL DEFAULT 'idle',
    "tagScanQueuedAt" DATETIME,
    "tagScanCompletedAt" DATETIME,
    "tagScanError" TEXT,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "moderationStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "flaggedAt" DATETIME,
    "flaggedById" TEXT,
    CONSTRAINT "ImageAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImageAsset_flaggedById_fkey" FOREIGN KEY ("flaggedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

INSERT INTO "new_ImageAsset" (
    "cfgScale",
    "createdAt",
    "description",
    "fileSize",
    "flaggedAt",
    "flaggedById",
    "height",
    "id",
    "isAdult",
    "isPublic",
    "model",
    "moderationStatus",
    "negativePrompt",
    "ownerId",
    "prompt",
    "sampler",
    "seed",
    "steps",
    "storagePath",
    "title",
    "updatedAt",
    "width"
)
SELECT
    "cfgScale",
    "createdAt",
    "description",
    "fileSize",
    "flaggedAt",
    "flaggedById",
    "height",
    "id",
    "isAdult",
    "isPublic",
    "model",
    "moderationStatus",
    "negativePrompt",
    "ownerId",
    "prompt",
    "sampler",
    "seed",
    "steps",
    "storagePath",
    "title",
    "updatedAt",
    "width"
FROM "ImageAsset";

DROP TABLE "ImageAsset";
ALTER TABLE "new_ImageAsset" RENAME TO "ImageAsset";
CREATE UNIQUE INDEX "ImageAsset_storagePath_key" ON "ImageAsset"("storagePath");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
