/*
  Warnings:

  - Added the required column `ownerId` to the `ImageAsset` table without a default value. This is not possible if the table is not empty.
  - Added the required column `ownerId` to the `UploadDraft` table without a default value. This is not possible if the table is not empty.

*/
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
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImageAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_ImageAsset" ("cfgScale", "createdAt", "description", "fileSize", "height", "id", "model", "negativePrompt", "ownerId", "prompt", "sampler", "seed", "steps", "storagePath", "title", "updatedAt", "width")
SELECT "cfgScale",
       "createdAt",
       "description",
       "fileSize",
       "height",
       "id",
       "model",
       "negativePrompt",
       (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1),
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
CREATE TABLE "new_UploadDraft" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "assetType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "visibility" TEXT NOT NULL,
    "category" TEXT,
    "galleryMode" TEXT NOT NULL,
    "targetGallery" TEXT,
    "tags" JSONB NOT NULL,
    "files" JSONB NOT NULL,
    "fileCount" INTEGER NOT NULL,
    "totalSize" BIGINT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "UploadDraft_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_UploadDraft" ("assetType", "category", "createdAt", "description", "fileCount", "files", "galleryMode", "id", "ownerId", "status", "tags", "targetGallery", "title", "totalSize", "updatedAt", "visibility")
SELECT "assetType",
       "category",
       "createdAt",
       "description",
       "fileCount",
       "files",
       "galleryMode",
       "id",
       (SELECT "id" FROM "User" ORDER BY "createdAt" ASC LIMIT 1),
       "status",
       "tags",
       "targetGallery",
       "title",
       "totalSize",
       "updatedAt",
       "visibility"
FROM "UploadDraft";
DROP TABLE "UploadDraft";
ALTER TABLE "new_UploadDraft" RENAME TO "UploadDraft";
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'CURATOR',
    "bio" TEXT,
    "avatarUrl" TEXT,
    "passwordHash" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("avatarUrl", "bio", "createdAt", "displayName", "email", "id", "role", "passwordHash", "isActive", "lastLoginAt", "updatedAt")
SELECT "avatarUrl",
       "bio",
       "createdAt",
       "displayName",
       "email",
       "id",
       "role",
       '' AS "passwordHash",
       true AS "isActive",
       NULL AS "lastLoginAt",
       "updatedAt"
FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
