/*
  Warnings:

  - A unique constraint covering the columns `[storagePath]` on the table `ImageAsset` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[storagePath]` on the table `ModelAsset` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "ImageAsset_storagePath_key" ON "ImageAsset"("storagePath");

-- CreateIndex
CREATE UNIQUE INDEX "ModelAsset_storagePath_key" ON "ModelAsset"("storagePath");
