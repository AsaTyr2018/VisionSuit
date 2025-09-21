-- Guarded create to avoid conflicts if the table was provisioned manually
CREATE TABLE IF NOT EXISTS "ModelVersion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "previewImage" TEXT,
    "metadata" JSONB,
    "fileSize" INTEGER,
    "checksum" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelVersion_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ModelAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImageAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ImageAsset" ("cfgScale", "createdAt", "description", "fileSize", "height", "id", "model", "negativePrompt", "ownerId", "prompt", "sampler", "seed", "steps", "storagePath", "title", "updatedAt", "width") SELECT "cfgScale", "createdAt", "description", "fileSize", "height", "id", "model", "negativePrompt", "ownerId", "prompt", "sampler", "seed", "steps", "storagePath", "title", "updatedAt", "width" FROM "ImageAsset";
DROP TABLE "ImageAsset";
ALTER TABLE "new_ImageAsset" RENAME TO "ImageAsset";
CREATE UNIQUE INDEX "ImageAsset_storagePath_key" ON "ImageAsset"("storagePath");
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
    "isPublic" BOOLEAN NOT NULL DEFAULT true,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ModelAsset" ("checksum", "createdAt", "description", "fileSize", "id", "metadata", "ownerId", "previewImage", "slug", "storagePath", "title", "trigger", "updatedAt", "version") SELECT "checksum", "createdAt", "description", "fileSize", "id", "metadata", "ownerId", "previewImage", "slug", "storagePath", "title", "trigger", "updatedAt", "version" FROM "ModelAsset";
DROP TABLE "ModelAsset";
ALTER TABLE "new_ModelAsset" RENAME TO "ModelAsset";
CREATE UNIQUE INDEX "ModelAsset_slug_key" ON "ModelAsset"("slug");
CREATE UNIQUE INDEX "ModelAsset_storagePath_key" ON "ModelAsset"("storagePath");
CREATE TABLE "new_RankTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "minimumScore" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_RankTier" ("createdAt", "description", "id", "isActive", "label", "minimumScore", "position", "updatedAt") SELECT "createdAt", "description", "id", "isActive", "label", "minimumScore", "position", "updatedAt" FROM "RankTier";
DROP TABLE "RankTier";
ALTER TABLE "new_RankTier" RENAME TO "RankTier";
CREATE UNIQUE INDEX "RankTier_minimumScore_key" ON "RankTier"("minimumScore");
CREATE TABLE "new_RankingSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "modelWeight" INTEGER NOT NULL DEFAULT 3,
    "galleryWeight" INTEGER NOT NULL DEFAULT 2,
    "imageWeight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_RankingSettings" ("createdAt", "galleryWeight", "id", "imageWeight", "modelWeight", "updatedAt") SELECT "createdAt", "galleryWeight", "id", "imageWeight", "modelWeight", "updatedAt" FROM "RankingSettings";
DROP TABLE "RankingSettings";
ALTER TABLE "new_RankingSettings" RENAME TO "RankingSettings";
CREATE TABLE "new_UserRankingState" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "scoreOffset" INTEGER NOT NULL DEFAULT 0,
    "isExcluded" BOOLEAN NOT NULL DEFAULT false,
    "lastResetAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UserRankingState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UserRankingState" ("createdAt", "isExcluded", "lastResetAt", "scoreOffset", "updatedAt", "userId") SELECT "createdAt", "isExcluded", "lastResetAt", "scoreOffset", "updatedAt", "userId" FROM "UserRankingState";
DROP TABLE "UserRankingState";
ALTER TABLE "new_UserRankingState" RENAME TO "UserRankingState";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

CREATE UNIQUE INDEX IF NOT EXISTS "ModelVersion_storagePath_key" ON "ModelVersion"("storagePath");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "ModelVersion_modelId_version_key" ON "ModelVersion"("modelId", "version");
