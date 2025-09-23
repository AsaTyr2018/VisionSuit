-- CreateTable
CREATE TABLE "GeneratorQueueState" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "isPaused" BOOLEAN NOT NULL DEFAULT false,
    "declineNewRequests" BOOLEAN NOT NULL DEFAULT false,
    "pausedAt" DATETIME,
    "activity" JSONB,
    "activityUpdatedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GeneratorQueueBlock" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GeneratorQueueBlock_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "GeneratorQueueBlock_userId_key" ON "GeneratorQueueBlock"("userId");
