-- CreateTable
CREATE TABLE "ModelModerationReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelModerationReport_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ModelAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModelModerationReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE "ImageModerationReport" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imageId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImageModerationReport_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ImageAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ImageModerationReport_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ModelModerationReport_modelId_idx" ON "ModelModerationReport"("modelId");
CREATE INDEX "ImageModerationReport_imageId_idx" ON "ImageModerationReport"("imageId");
