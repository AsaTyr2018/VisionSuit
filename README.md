# VisionSuit

VisionSuit ist eine selbst-hostbare Plattform für kuratierte KI-Bildgalerien und LoRA-Safetensor-Hosting. Dieses Grundgerüst
liefert eine lauffähige Node.js-API, ein Prisma-Datenmodell mit Seed-Daten sowie ein React-Frontend als visuelles Konzept für
den Upload- und Kuration-Workflow.

## Architekturüberblick

| Bereich       | Stack & Zweck                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------- |
| **Backend**   | Express 5 (TypeScript) + Prisma + SQLite. Stellt REST-Endpunkte für Assets, Galerien und Statistiken bereit. |
| **Datenbank** | Prisma-Schema für Benutzer, LoRA-Assets, Galerie-Einträge und Tagging inklusive Referenzen & Constraints.    |
| **Frontend**  | Vite + React (TypeScript). Liefert einen ersten UI-Entwurf mit Platzhalterkarten und Statusanzeigen.         |

## Installation & Setup

Das Skript `./install.sh` richtet Backend und Frontend gemeinsam ein und fragt nach den wichtigsten Parametern.

```bash
./install.sh
```

Funktionen im Überblick:

- Installiert die npm-Abhängigkeiten für Backend und Frontend.
- Erstellt fehlende `.env`-Dateien aus den jeweiligen Vorlagen und stimmt `HOST`, `PORT` sowie `VITE_API_URL` aufeinander ab.
- Optionaler Direktaufruf von `npm run prisma:migrate` und `npm run seed` (Bestätigung per Prompt).

Nach Abschluss ist das Projekt sofort bereit für den Entwicklungsstart mit `./dev-start.sh`.

## Entwicklung starten

### Gemeinsamer Dev-Starter

Der Befehl `./dev-start.sh` startet Backend und Frontend gemeinsam im Watch-Modus und bindet beide Services an `0.0.0.0`.
So können sie von außen erreicht werden, z. B. in Container- oder Cloud-Umgebungen.

1. Abhängigkeiten installieren:
   ```bash
   (cd backend && npm install)
   (cd frontend && npm install)
   ```
2. Starter aufrufen:
   ```bash
   ./dev-start.sh
   ```

Standard-Ports:
- Backend: `4000` (änderbar über `BACKEND_PORT`)
- Frontend: `5173` (änderbar über `FRONTEND_PORT`)

> Tipp: Mit `HOST=0.0.0.0 ./dev-start.sh` lässt sich der Host explizit überschreiben, falls erforderlich.

> Hinweis: Für das Frontend ist Node.js **18 LTS** oder neuer erforderlich. Die Toolchain ist bewusst auf Vite 5 fixiert,
> damit lokale Entwicklungsumgebungen mit Node 18 weiterhin funktionieren.

### Einzelne Services

#### Backend
1. `cd backend`
2. Prüfe die Prisma-Umgebung:
   - Die Datei `prisma/.env` enthält standardmäßig `DATABASE_URL="file:./dev.db"` für die SQLite-Dev-Datenbank.
   - Passe den Pfad bei Bedarf an (z. B. für persistente Volumes) und kopiere die Datei für weitere Umgebungen.
3. Prisma-Schema anwenden und Seed laden (optional, für Demodaten):
   ```bash
   npm run prisma:migrate
   npm run seed
   ```
4. Entwicklungsserver (ebenfalls auf `0.0.0.0`):
   ```bash
   HOST=0.0.0.0 PORT=4000 npm run dev
   ```

#### Frontend
1. `cd frontend`
2. Entwicklungsserver starten:
   ```bash
   npm run dev -- --host 0.0.0.0 --port 5173
   ```
3. Node-Version prüfen:
   ```bash
   node -v
   ```
   Sollte die Ausgabe eine Version kleiner als 18 zeigen, bitte Node.js aktualisieren (z. B. via `nvm`).

## API-Schnittstellen (Auszug)
- `GET /health` – Health-Check des Servers.
- `GET /api/meta/stats` – Aggregierte Kennzahlen (Assets, Galerien, Tags).
- `GET /api/assets/models` – LoRA-Assets inkl. Owner, Tags, Metadaten.
- `GET /api/assets/images` – Bild-Assets (Prompt, Modelldaten, Tags).
- `GET /api/galleries` – Kuratierte Galerien mit zugehörigen Assets & Bildern.

## Datenmodell-Highlights
- **User** verwaltet Kurator:innen inklusive Rollen & Profilinfos.
- **ModelAsset** & **ImageAsset** besitzen eindeutige `storagePath`-Constraints für Dateiverweise.
- **Gallery** bündelt Assets/Bilder über `GalleryEntry` (Positionierung + Notizen).
- **Tag** wird über Pivot-Tabellen (`AssetTag`, `ImageTag`) zugewiesen.

## Seed-Inhalte
- Demo-Kurator*in inklusive Basisprofil.
- Beispiel-LoRA „NeoSynth Cinematic LoRA“ mit Metadaten & Trigger-Wörtern.
- Showcase-Bild samt Prompt-/Sampler-Informationen.
- Kuratierte Galerie „Featured Cinematic Set“ als Startpunkt für UI-Iterationen.

Weitere Schritte umfassen Upload-Flows, Review-Prozesse und erweiterte Filter-/Suchfunktionen.

## Rollback & Bereinigung

Für Test-Szenarien oder wenn ein kompletter Reset der Arbeitskopie benötigt wird, stellt das Repository das Skript
`./rollback.sh` bereit. Es entfernt installierte Abhängigkeiten, löscht Build-Artefakte, setzt Konfigurationsdateien auf ihre
Beispielwerte zurück und säubert Cache-Verzeichnisse für Front- und Backend.

```bash
# Übersicht der geplanten Schritte ohne Änderungen an der Arbeitskopie
./rollback.sh --dry-run

# Rollback ohne Rückfrage durchführen
./rollback.sh --yes
```

> Hinweis: Die lokalen `.env`-Dateien werden durch die jeweiligen `*.env.example`-Vorlagen ersetzt. Eigene Anpassungen sollten
> vor dem Rollback gesichert werden.
