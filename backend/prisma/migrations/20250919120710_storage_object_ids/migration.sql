-- CreateTable
CREATE TABLE "StorageObject" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bucket" TEXT NOT NULL,
    "objectName" TEXT NOT NULL,
    "originalName" TEXT,
    "contentType" TEXT,
    "size" BIGINT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "StorageObject_bucket_objectName_key" ON "StorageObject"("bucket", "objectName");
