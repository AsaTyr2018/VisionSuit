# VisionSuit Workflow-Plan

## 1. Projektüberblick
- **Ziel**: Aufbau einer selbst-hostbaren Plattform (Node.js) für KI-generierte Bildgalerien und das Hosting von LoRA-Safetensors.
- **USP**: Einheitliche Upload-Erfahrung mit automatischer Metadaten-Extraktion, intelligente Verknüpfung zwischen Bildern und LoRAs sowie performante Suche ohne Enterprise-Datenbanken.
- **Leitprinzipien**: Benutzerfreundliche, moderne Dark-UI, einfache Installation per Shell-Skript, Fokus auf Accessibility und moderate Hardware-Anforderungen.

## 2. Arbeitsphasen & Meilensteine
1. **Grundlagen & Planung (Woche 1)**
   - Anforderungsanalyse finalisieren, Datenmodell und API-Spezifikationen definieren.
   - Evaluierung von Bibliotheken für Bild-/Safetensor-Analyse (z. B. `sharp`, `safetensors` via Node bindings).
2. **Backend-Basis (Woche 2)**
   - Node.js-Projektstruktur aufsetzen (TypeScript + Express/Fastify, Prisma/Drizzle mit SQLite/PostgreSQL optional).
   - Authentifizierung/Autorisierung (Session + API-Key für Upload-Automatisierung) vorbereiten.
   - Datei-Storage-Strategie definieren (lokal mit strukturierter Ordnerhierarchie + Checksums).
3. **Upload-Pipeline & Metadaten (Woche 3)**
   - Upload-Wizard API: Validierungen, Chunked Uploads, Virus-/Malware-Scan Hooks.
   - Metadaten-Extractor implementieren: Lesen von PNG/JPEG EXIF, JSON-Sidecars, Safetensor-Header.
   - Asynchrone Job-Queue für Analyse (BullMQ mit Redis-Alternative wie `bullmq-lite` oder SQLite-basierte Queue).
4. **Galerie- & Hosting-Funktionalität (Woche 4)**
   - REST/GraphQL-Endpunkte für Bilder & LoRAs (CRUD, Suche, Filter, Tagging).
   - Linking-Engine: automatische Zuordnung von LoRA-Dateien zu Bildergalerie-Einträgen anhand von Tags/Prompts.
   - Suchindizes ohne Elastic: Lightweight Volltext (SQLite FTS5) + Facettenfilter.
5. **Frontend Webpanel (Woche 5-6)**
   - Moderne Dark-UI mit React/Vite + Tailwind/Shadcn oder SvelteKit.
   - Upload-Wizard UI mit Schritt-für-Schritt-Formular, Validierungsfeedback, Drag & Drop.
   - Galerie-Ansicht mit Infinite Scroll, Filterleisten, Detail-Drawer für Metadaten & verbundenen LoRAs.
6. **Automatisierungs- & Installationsschicht (Woche 7)**
   - Shell-Installscript (bash/sh) zur automatischen Einrichtung (Node, Dependencies, DB Migration, PM2-Service).
   - Konfigurationsvorlagen (.env, storage-Pfade) erzeugen.
7. **Qualitätssicherung & Release (Woche 8)**
   - Tests (Unit, Integration, E2E mit Playwright/Cypress) aufsetzen.
   - Accessibility- und Performance-Audits (Lighthouse, axe-core).
   - Dokumentation, Onboarding-Anleitung, Release-Tagging.

## 3. Technische Kernkomponenten
- **Backend**: Node.js (LTS), TypeScript, Fastify/Express, Prisma/Drizzle ORM, SQLite als Default DB.
- **Storage**: Lokales Dateisystem mit strukturierter Ablage (`/assets/images`, `/assets/loras`), Hash-Prüfung.
- **Metadaten-Service**: Worker-Prozess mit Warteschlange, nutzt Libraries für EXIF & Safetensor-Parsing.
- **Suche & Filter**: SQLite FTS5 + Tagging-Relationen; Caching mit `node-cache` oder `redis` optional.
- **Frontend**: React (Vite) oder SvelteKit, TailwindCSS, Headless UI-Komponenten, sanfte Seitenübergänge via Framer Motion.
- **API-Sicherheit**: Rate-Limiting, Input-Sanitizing, Signierte Upload-URLs, CSRF-Schutz im Panel.

## 4. Upload-Wizard Flow
1. Benutzer authentifiziert sich.
2. Schritt "Basisdaten": Name, Typ (Bild/LoRA), Kategorie, Tags, Beschreibung.
3. Schritt "Dateien": Drag & Drop, Upload-Progress, Hash-Prüfung.
4. Schritt "Review": Zusammenfassung + automatische Metadatenvorschau.
5. Submit → API legt Eintrag an, stößt Analyse-Queue an.
6. Nach Analyse: Verknüpft Bilder ↔ LoRAs, reichert Tags/Prompts an, sendet Benachrichtigung.

## 5. Metadaten-Extraktion & Verknüpfung
- **Bilder**: EXIF, Prompt-JSON im PNG-Text-Chunk (Stable Diffusion), Dimensionsdaten, Modellinformationen.
- **LoRAs**: Lesen des Safetensor-Headers, extrahieren von Netzwerkarchitektur, Trigger-Wörtern, Base-Model.
- **Matching-Logik**: Vergleicht Tags, Trigger-Wörter, Prompt-Hash; manuelle Nachbearbeitung im UI möglich.
- **Moderation**: Hashing (Perceptual Hash) zum Duplikatabgleich, Flagging-Regeln für sensible Inhalte.

## 6. Such- & Filterfunktionen
- Filter nach Typ, Kategorie, Tags, Modell, Auflösung, Upload-Datum.
- Volltextsuche über Titel, Beschreibung, extrahierte Prompts.
- Sortierungen (Neueste, Beliebteste, Bewertung nach Community-Feedback).
- Optional: Favoriten-/Sammlungs-Funktionen pro Benutzer.

## 7. Deployment & Betrieb
- Zielplattform: Self-hosted Linux (Debian/Ubuntu) ohne Docker.
- Installscript erledigt: Node-Installation (nvm oder binary), `npm install`, DB-Migration, Start via PM2/Systemd.
- Logging: Winston/Pino + rotierende Logs.
- Backup-Strategie: Cronjob für DB + Assets (rsync/Restic).

## 8. Risiko- & Mitigationsliste
- **Große Dateien**: Chunked Upload + Resume, Storage Quotas.
- **Metadaten-Vielfalt**: Fallbacks für unbekannte Formate, modulare Parser.
- **Performance der Suche**: Caching-Schicht, asynchrone Indizierung.
- **Rechtliches**: Opt-in für Nutzungsbedingungen, Content-Moderation/DMCA-Workflow.

## 9. Nächste konkrete Schritte
1. Feinkonzept Datenmodell & API-Schema dokumentieren.
2. Proof-of-Concept für Safetensor-Parsing in Node.js erstellen.
3. UI-Wireframes (Upload-Wizard, Galerie, Detailseite) definieren.
4. Installationsskript-Anforderungen sammeln (Unterstützte OS, Abhängigkeiten).

Dieser Workflow-Plan dient als Leitfaden und kann nach Bedarf verfeinert werden, sobald technische Evaluierungen abgeschlossen sind.
