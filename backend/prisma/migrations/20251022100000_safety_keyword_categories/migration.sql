-- RedefineTables
PRAGMA foreign_keys=OFF;

CREATE TABLE "new_SafetyKeyword" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "label" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'ADULT',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "new_SafetyKeyword" ("id", "label", "createdAt", "updatedAt")
SELECT "id", "label", "createdAt", "updatedAt"
FROM "AdultSafetyKeyword";

DROP TABLE "AdultSafetyKeyword";

ALTER TABLE "new_SafetyKeyword" RENAME TO "SafetyKeyword";

CREATE UNIQUE INDEX "SafetyKeyword_category_label_key" ON "SafetyKeyword"("category", "label");

PRAGMA foreign_keys=ON;
