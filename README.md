# VisionSuit

VisionSuit ist eine selbst-hostbare Plattform für kuratierte KI-Bildgalerien und LoRA-Safetensor-Hosting. Dieses Grundgerüst
liefert eine lauffähige Node.js-API, ein Prisma-Datenmodell mit Seed-Daten sowie ein React-Frontend als visuelles Konzept für
den Upload- und Kuration-Workflow.

## Architekturüberblick

| Bereich     | Stack & Zweck |
| ----------- | ------------- |
| **Backend** | Express 5 (TypeScript) + Prisma + SQLite. Stellt REST-Endpunkte für Assets, Galerien und Systemstatistiken bereit. |
| **Datenbank** | Prisma-Schema für Benutzer, LoRA-Assets, Galerie-Einträge und Tagging inklusive Referenzen & Constraints. |
| **Frontend** | Vite + React (TypeScript). Liefert einen ersten UI-Entwurf mit Platzhalterkarten und Statusanzeigen. |

## Schnellstart

### Backend
1. `cd backend && npm install`
2. `cp .env.example .env`
3. Datenbank anwenden und befüllen:
   ```bash
   npm run prisma:migrate
   npm run seed
   ```
4. Entwicklungsserver starten: `npm run dev` (Standard: http://localhost:4000)

### Frontend
1. `cd frontend && npm install`
2. API-Basis anpassen (optional): `cp .env.example .env`
3. Entwicklungsserver starten: `npm run dev` (Standard: http://localhost:5173)

> **Hinweis:** Das Frontend zeigt Placeholder-Karten. Inhalte stammen aus dem Seed des Backends oder einer laufenden Instanz.

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
