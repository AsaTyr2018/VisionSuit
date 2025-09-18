-- CreateTable
CREATE TABLE "UploadDraft" (
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
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
