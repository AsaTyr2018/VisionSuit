-- AlterTable
ALTER TABLE "GeneratorRequest" ADD COLUMN "errorReason" TEXT;
ALTER TABLE "GeneratorRequest" ADD COLUMN "outputBucket" TEXT;
ALTER TABLE "GeneratorRequest" ADD COLUMN "outputPrefix" TEXT;

-- CreateTable
CREATE TABLE "GeneratorArtifact" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "requestId" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "storagePath" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GeneratorArtifact_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "GeneratorRequest" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "GeneratorArtifact_requestId_idx" ON "GeneratorArtifact"("requestId");
