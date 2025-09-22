-- CreateTable
CREATE TABLE "AdultSafetyKeyword" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
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
    "isAdult" BOOLEAN NOT NULL DEFAULT false,
    "ownerId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "moderationStatus" TEXT NOT NULL DEFAULT 'ACTIVE',
    "flaggedAt" DATETIME,
    "flaggedById" TEXT,
    CONSTRAINT "ImageAsset_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "ImageAsset_flaggedById_fkey" FOREIGN KEY ("flaggedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ImageAsset" ("cfgScale", "createdAt", "description", "fileSize", "flaggedAt", "flaggedById", "height", "id", "isPublic", "model", "moderationStatus", "negativePrompt", "ownerId", "prompt", "sampler", "seed", "steps", "storagePath", "title", "updatedAt", "width") SELECT "cfgScale", "createdAt", "description", "fileSize", "flaggedAt", "flaggedById", "height", "id", "isPublic", "model", "moderationStatus", "negativePrompt", "ownerId", "prompt", "sampler", "seed", "steps", "storagePath", "title", "updatedAt", "width" FROM "ImageAsset";
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
INSERT INTO "new_ModelAsset" ("checksum", "createdAt", "description", "fileSize", "flaggedAt", "flaggedById", "id", "isPublic", "metadata", "moderationStatus", "ownerId", "previewImage", "slug", "storagePath", "title", "trigger", "updatedAt", "version") SELECT "checksum", "createdAt", "description", "fileSize", "flaggedAt", "flaggedById", "id", "isPublic", "metadata", "moderationStatus", "ownerId", "previewImage", "slug", "storagePath", "title", "trigger", "updatedAt", "version" FROM "ModelAsset";
DROP TABLE "ModelAsset";
ALTER TABLE "new_ModelAsset" RENAME TO "ModelAsset";
CREATE UNIQUE INDEX "ModelAsset_slug_key" ON "ModelAsset"("slug");
CREATE UNIQUE INDEX "ModelAsset_storagePath_key" ON "ModelAsset"("storagePath");
CREATE TABLE "new_Tag" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "category" TEXT,
    "isAdult" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Tag" ("category", "createdAt", "id", "label", "updatedAt") SELECT "category", "createdAt", "id", "label", "updatedAt" FROM "Tag";
DROP TABLE "Tag";
ALTER TABLE "new_Tag" RENAME TO "Tag";
CREATE UNIQUE INDEX "Tag_label_key" ON "Tag"("label");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'USER',
    "bio" TEXT,
    "avatarUrl" TEXT,
    "passwordHash" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "showAdultContent" BOOLEAN NOT NULL DEFAULT false,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("avatarUrl", "bio", "createdAt", "displayName", "email", "id", "isActive", "lastLoginAt", "passwordHash", "role", "updatedAt") SELECT "avatarUrl", "bio", "createdAt", "displayName", "email", "id", "isActive", "lastLoginAt", "passwordHash", "role", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "AdultSafetyKeyword_label_key" ON "AdultSafetyKeyword"("label");
