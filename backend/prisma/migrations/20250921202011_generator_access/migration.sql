-- CreateTable
CREATE TABLE "GeneratorSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accessMode" TEXT NOT NULL DEFAULT 'ADMIN_ONLY',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GeneratorRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "baseModelId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "seed" TEXT,
    "guidanceScale" REAL,
    "steps" INTEGER,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "loraSelections" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GeneratorRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GeneratorRequest_baseModelId_fkey" FOREIGN KEY ("baseModelId") REFERENCES "ModelAsset" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
