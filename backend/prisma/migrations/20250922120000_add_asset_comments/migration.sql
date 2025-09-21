-- CreateTable
CREATE TABLE "ModelComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modelId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ModelComment_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ModelAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModelComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ModelCommentLike" (
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ModelCommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "ModelComment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ModelCommentLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY ("commentId", "userId")
);

-- CreateTable
CREATE TABLE "ImageComment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "imageId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ImageComment_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "ImageAsset" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ImageComment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ImageCommentLike" (
    "commentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ImageCommentLike_commentId_fkey" FOREIGN KEY ("commentId") REFERENCES "ImageComment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ImageCommentLike_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    PRIMARY KEY ("commentId", "userId")
);

-- CreateIndex
CREATE INDEX "ModelComment_modelId_idx" ON "ModelComment"("modelId");

-- CreateIndex
CREATE INDEX "ModelCommentLike_userId_idx" ON "ModelCommentLike"("userId");

-- CreateIndex
CREATE INDEX "ImageComment_imageId_idx" ON "ImageComment"("imageId");

-- CreateIndex
CREATE INDEX "ImageCommentLike_userId_idx" ON "ImageCommentLike"("userId");
