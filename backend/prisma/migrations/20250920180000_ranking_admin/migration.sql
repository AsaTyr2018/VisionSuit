-- CreateTable
CREATE TABLE "RankingSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "modelWeight" INTEGER NOT NULL DEFAULT 3,
    "galleryWeight" INTEGER NOT NULL DEFAULT 2,
    "imageWeight" INTEGER NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RankTier" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "label" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "minimumScore" INTEGER NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT 1,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "UserRankingState" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "scoreOffset" INTEGER NOT NULL DEFAULT 0,
    "isExcluded" BOOLEAN NOT NULL DEFAULT 0,
    "lastResetAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "UserRankingState_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RankTier_minimumScore_key" ON "RankTier"("minimumScore");

-- Insert default settings and tiers
INSERT INTO "RankingSettings" ("id", "modelWeight", "galleryWeight", "imageWeight") VALUES (1, 3, 2, 1);

INSERT INTO "RankTier" ("id", "label", "description", "minimumScore", "position") VALUES
    (lower(hex(randomblob(16))), 'Newcomer', 'Getting started with first uploads and curated collections.', 0, 0),
    (lower(hex(randomblob(16))), 'Curator', 'Actively maintains a growing catalog of models and showcases.', 6, 1),
    (lower(hex(randomblob(16))), 'Senior Curator', 'Regularly delivers polished LoRAs and collections for the community.', 18, 2),
    (lower(hex(randomblob(16))), 'Master Curator', 'Leads large-scale curation programs with sustained contributions.', 40, 3);
