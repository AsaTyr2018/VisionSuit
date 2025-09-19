# VisionSuit

VisionSuit ist eine selbst-hostbare Plattform für kuratierte KI-Bildgalerien und LoRA-Safetensor-Hosting. Dieses Grundgerüst
liefert eine lauffähige Node.js-API, ein Prisma-Datenmodell mit Seed-Daten sowie ein React-Frontend als visuelles Konzept für
den Upload- und Kuration-Workflow.

## Highlights

- **Dashboard-Navigation** – Linke Seitenleiste mit direkter Umschaltung zwischen Home, Models und Images sowie Live-Service-Status für Frontend, Backend und MinIO.
- **Rollenbasierte Authentifizierung** – Login-Dialog mit JWT-Token, persistiertem Zustand und Admin-Dashboard für Benutzer-, Modell- und Bildverwaltung.
- **Upload-Wizard** – dreistufiger Assistent für Basisdaten, Dateiupload & Review inklusive Validierungen, Drag & Drop sowie Rückmeldung aus dem produktiven Upload-Endpunkt (`POST /api/uploads`).
- **Galerie-Entwürfe** – separater Bild-Upload aus dem Galerie-Explorer, Multi-Upload (bis 12 Dateien/2 GB) mit automatischer Galerie-Auswahl oder -Neuanlage.
- **Produktionsreifes Frontend** – Sticky-Navigation, Live-Status-Badge, Trust-Metriken und CTA-Panels transportieren einen fertigen Produktlook inklusive Toast-Benachrichtigungen für Upload-Events.
- **Upload-Governance** – neue UploadDraft-Persistenz mit Audit-Trail, Größenlimit (≤ 2 GB), Dateianzahl-Limit (≤ 12 Dateien) und automatischem Übergang in die Analyse-Queue.
- **Datengetriebene Explorer** – performante Filter für LoRA-Bibliothek & Galerien mit Volltextsuche, Tag-Badges, Pagination und aktiven Filterhinweisen.
- **Direkte MinIO-Ingests** – Uploads landen unmittelbar in den konfigurierten Buckets, werden automatisch mit Tags versehen und tauchen ohne Wartezeit in Explorer & Galerien auf.
- **Gesicherte Downloads** – Dateien werden über `/api/storage/:bucket/:objectId` durch das Backend geproxied; eine Datenbank-Tabelle ordnet die anonymisierten Objekt-IDs wieder den ursprünglichen Dateinamen zu.
- **Galerie-Alben** – Collections zeigen mehrteilige Sets mit heroischen Vorschaubildern, Thumbnail-Leiste und Zoom-Lightbox für fokussierte Präsentationen.
- **Robuste Metadatenanzeige** – Galerie- und Bildansichten bleiben stabil, selbst wenn Einträge ohne ausgefüllte Bild-Metadaten vom Backend geliefert werden.

## Architekturüberblick

| Bereich       | Stack & Zweck                                                                                   |
| ------------- | ----------------------------------------------------------------------------------------------- |
| **Backend**   | Express 5 (TypeScript) + Prisma + SQLite. Stellt REST-Endpunkte für Assets, Galerien und Statistiken bereit. |
| **Datenbank** | Prisma-Schema für Benutzer, LoRA-Assets, Galerie-Einträge und Tagging inklusive Referenzen & Constraints.    |
| **Storage**   | MinIO (S3-kompatibel) verwaltet Buckets für Modell- und Bilddateien und wird automatisch provisioniert.      |
| **Frontend**  | Vite + React (TypeScript). Enthält einen datengetriebenen Explorer für LoRA-Assets & Galerien inkl. Filter. |

## Installation & Setup

### Voraussetzungen

Stelle sicher, dass folgende Werkzeuge verfügbar sind:

- Node.js (empfohlen: 22 LTS) und npm
- Python 3 (für kleine Hilfsskripte im Installer)
- Docker Engine (inklusive laufendem Daemon)
- Docker Compose Plugin oder die Legacy-Binary `docker-compose`
- Portainer CE (wird auf Wunsch direkt über das Installationsskript eingerichtet)

Das Skript `./install.sh` richtet Backend und Frontend gemeinsam ein und fragt nach den wichtigsten Parametern.

```bash
./install.sh
```

Funktionen im Überblick:

- Prüft, ob Docker, Docker Compose und Portainer verfügbar sind und bietet ggf. die automatische Installation von Portainer CE an.
- Installiert die npm-Abhängigkeiten für Backend und Frontend.
- Erstellt fehlende `.env`-Dateien aus den jeweiligen Vorlagen und stimmt `HOST`, `PORT` sowie `VITE_API_URL` aufeinander ab.
- Richtet den MinIO-Zugangspunkt samt Zugangsdaten und Bucket-Namen ein (Secret-Key wird bei Bedarf automatisch generiert) und startet anschließend einen passenden Docker-Container (`visionsuit-minio`).
- Optionaler Direktaufruf von `npm run prisma:migrate` und `npm run seed` (Bestätigung per Prompt).

Nach Abschluss ist das Projekt sofort bereit für den Entwicklungsstart mit `./dev-start.sh`.

### Initialer Admin-Account via CLI

Der Upload- und Administrationsbereich setzt ein angemeldetes Konto voraus. Ein initiales Admin-Profil lässt sich direkt per SSH auf der Zielmaschine einrichten:

```bash
cd backend
npm run create-admin -- \
  --email=admin@example.com \
  --password="super-sicheres-passwort" \
  --name="VisionSuit Admin" \
  --bio="Optionaler Profiltext"
```

Das Skript erstellt den Account (oder aktualisiert ihn bei erneutem Aufruf) mit der Rolle `ADMIN`, aktiviert ihn und hinterlegt das gehashte Passwort in der Datenbank.

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

### Node.js-Versionen & Kompatibilität

- Die Vite-CLI gibt unter Node.js 18.19.x einen Warnhinweis aus, funktioniert aber dank eines mitgelieferten
  Polyfills ohne Fehlermeldung. Die npm-Skripte laden `scripts/node18-crypto-polyfill.cjs` automatisch vor,
  wodurch `crypto.hash` auf älteren LTS-Versionen verfügbar wird.
- Für neue Installationen wird Node.js **22 LTS** empfohlen, um die Warnung zu vermeiden und zukünftige Vite-Releases
  ohne Anpassungen nutzen zu können. Ein Wechsel gelingt beispielsweise via `nvm install 22 && nvm use 22`.


### Einzelne Services

#### Backend
1. `cd backend`
2. Stelle sicher, dass `./.env` aus der Vorlage erzeugt ist:
   - `cp .env.example .env` legt eine lokale Entwicklungsdatei mit `DATABASE_URL="file:./dev.db"` an.
   - Prisma CLI und Server teilen sich damit dieselbe Datenbank-URL; separate `prisma/.env`-Dateien werden nicht mehr benötigt.
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
4. Öffne `http://localhost:5173`, um den Explorer mit Echtzeit-Filtern für LoRAs und Galerien zu testen.

## Frontend-Erlebnis

Der aktuelle Prototyp fokussiert sich auf einen klaren Kontrollraum mit Service-Transparenz und datengetriebenen Explorern:

- **Neue Shell** – Ein dauerhaft sichtbares Sidebar-Layout bündelt die Hauptnavigation (Home, Models, Images) und zeigt den Status von Frontend, Backend und MinIO auf einen Blick.
- **Admin-Panel** – Eigener Bereich für Administrator:innen mit Benutzerverwaltung (CRUD), Asset-Neuzuordnung, Tag-Editing und Lösch-Workflows für Modelle und Bilder.
- **Home-Dashboard** – Kachel-Layout mit den neuesten Modellen und Bildern inklusive Kurator:innen, Versionen, Prompts und Tag-Highlights.
- **Models** – Der ausgebaute Model Explorer bleibt Dreh- und Angelpunkt für LoRA-Recherchen mit Volltext, Typ- und Größenfiltern sowie Lazy-Loading.
- **Images** – Die Bildgalerie kombiniert Volltextsuche, Sortierung und Tag-Anrisse mit kuratierten Alben samt Collage-Layout und Zoom-Lightbox.
- **Upload-Wizard** – Jederzeit erreichbar über die Shell; validiert Eingaben, verwaltet Datei-Drops und liefert unmittelbares Backend-Feedback – inklusive eigenem Galerie-Modus für Bildserien.

Die Explorer-Filter arbeiten vollständig clientseitig und reagieren selbst auf große Datenmengen ohne zusätzliche Server-Requests.

### Upload-Pipeline & Backend

1. **Auth-Check** – Jeder Upload erfordert ein gültiges JWT; das Backend schlägt bei fehlender/abgelaufener Authentifizierung sofort mit `401` oder `403` fehl.
2. **Session anlegen** – Der Wizard legt per `POST /api/uploads` einen `UploadDraft` inklusive Owner, Sichtbarkeit, Tags und erwarteter Dateien an.
3. **Direkter Storage-Ingest** – Dateien werden gestreamt nach MinIO übertragen (`s3://bucket/<uuid>`). Das Backend vergibt dafür zufällige Objekt-IDs, speichert sie inklusive Dateiname, Content-Type und Größe in `StorageObject` und reicht nur die anonymisierte ID weiter.
4. **Asset-Erzeugung & Linking** – Das Backend erzeugt sofort `ModelAsset`- bzw. `ImageAsset`-Datensätze, verknüpft Tags, erstellt auf Wunsch neue Galerien und setzt Cover-Bilder automatisch.
5. **Explorer-Refresh & Audit** – UploadDrafts erhalten einen `processed`-Status, Explorer-Kacheln sind direkt sichtbar und alle Storage-Informationen (Bucket, Object-Key, Public-URL) werden im API-Response ausgespielt.

Der Upload-Endpunkt validiert pro Request bis zu **12 Dateien** und reagiert mit klaren Fehlermeldungen, sobald Größen- oder Anzahllimits überschritten werden.

## API-Schnittstellen (Auszug)
- `GET /health` – Health-Check des Servers.
- `POST /api/auth/login` – Authentifizierung via E-Mail/Passwort; liefert JWT und User-Details.
- `GET /api/auth/me` – Prüft ein JWT und liefert das aktuelle Profil zurück.
- `GET /api/meta/stats` – Aggregierte Kennzahlen (Assets, Galerien, Tags).
- `GET /api/assets/models` – LoRA-Assets inkl. Owner, Tags, Metadaten.
- `GET /api/assets/images` – Bild-Assets (Prompt, Modelldaten, Tags).
- `GET /api/galleries` – Kuratierte Galerien mit zugehörigen Assets & Bildern.
- `GET /api/storage/:bucket/:objectId` – Proxied-Dateizugriff über ID-Auflösung in der Datenbank.
- `POST /api/uploads` – Legt eine UploadDraft-Session (nur mit gültigem Token) an, prüft Limits & Validierung und plant Dateien für die Analyse-Queue ein.
- `GET /api/users` – Administrations-Endpunkt für Benutzerlisten (JWT + Rolle `ADMIN` erforderlich).
- `POST /api/users` – Neue Benutzer:innen anlegen (Admin-only).
- `PUT /api/users/:id` – Bestehende Accounts pflegen, deaktivieren oder Passwort neu setzen (Admin-only).
- `DELETE /api/users/:id` – Benutzer:innen löschen (Admin-only, kein Self-Delete).

## Datenmodell-Highlights
- **User** verwaltet Kurator:innen inklusive Rollen & Profilinfos.
- **ModelAsset** & **ImageAsset** besitzen eindeutige `storagePath`-Constraints für Dateiverweise.
- **StorageObject** verwaltet Bucket, Objekt-ID, Originalnamen und Metadaten, damit Downloads trotz anonymisierter Pfade den richtigen Dateinamen behalten.
- **Gallery** bündelt Assets/Bilder über `GalleryEntry` (Positionierung + Notizen).
- **Tag** wird über Pivot-Tabellen (`AssetTag`, `ImageTag`) zugewiesen.
- **UploadDraft** protokolliert Upload-Sessions mit Dateiliste, Gesamtgröße, Status und Audit-Timestamps.

## Seed-Inhalte
- Demo-Kurator*in inklusive Basisprofil.
- Beispiel-LoRA „NeoSynth Cinematic LoRA“ mit Metadaten & Trigger-Wörtern.
- Showcase-Bild samt Prompt-/Sampler-Informationen.
- Kuratierte Galerie „Featured Cinematic Set“ als Startpunkt für UI-Iterationen.

Weitere Schritte umfassen Upload-Flows, Review-Prozesse und erweiterte Filter-/Suchfunktionen.

## Storage mit MinIO

- Der Backend-Start ruft `initializeStorage` auf und sorgt (abhängig von `MINIO_AUTO_CREATE_BUCKETS`) dafür, dass die konfigurierten
  Buckets existieren. So entfällt das manuelle Anlegen per Konsole.
- Die relevanten Variablen liegen in `backend/.env` (`STORAGE_DRIVER`, `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_BUCKET_*`, …).
  Standardmäßig werden zwei Buckets (`visionsuit-models`, `visionsuit-images`) genutzt.
- `install.sh` erzeugt nach dem Abfragen deiner Zugangsdaten automatisch einen MinIO-Docker-Container namens `visionsuit-minio`.
  - Die Daten werden im Ordner `docker-data/minio/` unterhalb des Repos persistiert.
  - Der API-Port entspricht deiner Eingabe (`MINIO_PORT`), der Administrationszugang liegt standardmäßig auf Port `MINIO_PORT + 1`.
  - Existiert bereits ein Container, kannst du ihn direkt weiterverwenden oder komfortabel neu provisionieren lassen.
- Portainer CE lässt sich im selben Schritt (optional) bereitstellen und bietet dir ein Dashboard für MinIO und weitere Container.

Da MinIO in vielen Setups nur intern erreichbar ist, übernimmt das Backend das Ausliefern der Dateien. Über den Proxy-Endpunkt `/api/storage/:bucket/:objectId` wird die Objekt-ID zunächst in `StorageObject` aufgelöst, anschließend Content-Type, Dateigröße sowie ursprünglicher Dateiname gesetzt – Downloads und Inline-Previews im Frontend funktionieren damit trotz anonymisierter MinIO-Pfade zuverlässig.

## Rollback & Bereinigung

Für Test-Szenarien oder wenn ein kompletter Reset der Arbeitskopie benötigt wird, stellt das Repository das Skript
`./rollback.sh` bereit. Es entfernt installierte Abhängigkeiten, löscht Build-Artefakte, setzt Konfigurationsdateien auf ihre
Beispielwerte zurück, säubert Cache-Verzeichnisse für Front- und Backend **und** räumt sämtliche lokal installierten Node.js
Toolchains samt globalen npm/pnpm/yarn-Artefakten auf.

**Was wird zurückgesetzt?**

- npm-Abhängigkeiten und Build-Ordner in `backend/` und `frontend/`.
- `.env`-Dateien werden aus den jeweiligen `*.env.example`-Vorlagen wiederhergestellt.
- Projektweite Cache-Verzeichnisse (`.turbo`, `.cache`, `.eslintcache`, `.vite`, `tsconfig.tsbuildinfo`).
- npm-Cache (`npm cache clean --force`, falls verfügbar) sowie globale Prefixes im Home-Verzeichnis (z. B. `~/.npm-global`).
- Lokale Node-Versionen und Toolchains in Home- oder Projektpfaden (u. a. `~/.nvm`, `~/.fnm`, `~/.asdf/installs/nodejs`,
  `~/.volta`, `./.toolchains`).

> ⚠️ **Achtung**: Der Toolchain-Purge löscht alle lokal via nvm/fnm/asdf/volta installierten Node.js-Versionen sowie globale
> npm-Installationen im Home-Verzeichnis. Prüfe mit `./rollback.sh --dry-run`, ob weitere Projekte betroffen wären, und sichere
> ggf. benötigte Toolchains vor dem produktiven Lauf.

```bash
# Übersicht der geplanten Schritte ohne Änderungen an der Arbeitskopie
./rollback.sh --dry-run

# Rollback ohne Rückfrage durchführen
./rollback.sh --yes
```

> Hinweis: Die lokalen `.env`-Dateien werden durch die jeweiligen `*.env.example`-Vorlagen ersetzt. Eigene Anpassungen sollten
> vor dem Rollback gesichert werden.
