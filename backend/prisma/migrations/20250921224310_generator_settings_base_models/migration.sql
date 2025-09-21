-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_GeneratorSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "accessMode" TEXT NOT NULL DEFAULT 'ADMIN_ONLY',
    "baseModels" JSONB NOT NULL DEFAULT [],
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_GeneratorSettings" ("accessMode", "createdAt", "id", "updatedAt") SELECT "accessMode", "createdAt", "id", "updatedAt" FROM "GeneratorSettings";
DROP TABLE "GeneratorSettings";
ALTER TABLE "new_GeneratorSettings" RENAME TO "GeneratorSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
