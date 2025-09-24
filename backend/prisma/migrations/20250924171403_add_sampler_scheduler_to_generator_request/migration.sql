-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GeneratorRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "baseModelId" TEXT,
    "baseModelSelections" JSONB,
    "prompt" TEXT NOT NULL,
    "negativePrompt" TEXT,
    "seed" TEXT,
    "guidanceScale" REAL,
    "steps" INTEGER,
    "sampler" TEXT NOT NULL DEFAULT 'dpmpp_2m_sde_gpu',
    "scheduler" TEXT NOT NULL DEFAULT 'karras',
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "loraSelections" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "errorReason" TEXT,
    "outputBucket" TEXT,
    "outputPrefix" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "GeneratorRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "GeneratorRequest_baseModelId_fkey" FOREIGN KEY ("baseModelId") REFERENCES "ModelAsset" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_GeneratorRequest" ("baseModelId", "baseModelSelections", "createdAt", "errorReason", "guidanceScale", "height", "id", "loraSelections", "negativePrompt", "outputBucket", "outputPrefix", "prompt", "seed", "status", "steps", "updatedAt", "userId", "width") SELECT "baseModelId", "baseModelSelections", "createdAt", "errorReason", "guidanceScale", "height", "id", "loraSelections", "negativePrompt", "outputBucket", "outputPrefix", "prompt", "seed", "status", "steps", "updatedAt", "userId", "width" FROM "GeneratorRequest";
DROP TABLE "GeneratorRequest";
ALTER TABLE "new_GeneratorRequest" RENAME TO "GeneratorRequest";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
