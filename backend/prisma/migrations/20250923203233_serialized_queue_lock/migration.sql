-- AlterTable
ALTER TABLE "GeneratorQueueState" ADD COLUMN "activeRequestId" TEXT;
ALTER TABLE "GeneratorQueueState" ADD COLUMN "lockedAt" DATETIME;
