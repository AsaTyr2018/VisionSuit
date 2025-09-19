# Änderungsbericht – VisionSuit

## Kontext
- Einführung einer vollständigen Authentifizierungs- und Administrationsschicht für VisionSuit.
- Absicherung aller Upload- und Verwaltungsfunktionen gegen anonyme Nutzung.

## Durchgeführte Arbeiten
- Backend um JWT-Auth-Flow ergänzt (`/api/auth/login`, `/api/auth/me`), Passwort-Hashing integriert und Middleware für Auth/Role-Checks bereitgestellt.
- Upload-, Asset- und Bild-Routen überarbeitet: Owner-Zuordnung erzwungen, CRUD-Operationen rollenbasiert abgesichert und Löschpfade inklusive Storage-Cleanup gehärtet.
- Administrations-API für Benutzerverwaltung erstellt (Anlegen, Aktualisieren, Deaktivieren, Löschen) und CLI-Skript zum Provisionieren eines initialen Admin-Accounts hinzugefügt.
- Frontend um Auth-Context, Login-Dialog, Admin-Dashboard und tokenbasierte Upload-Steuerung erweitert; Navigation und Layout für angemeldete Nutzer:innen optimiert.
- Styling für Sidebar, Modals und Admin-Karten erweitert sowie API-Layer um Auth-/CRUD-Endpunkte ergänzt.
- README modernisiert (Auth-Highlights, Admin-Skript, API-Übersicht) und Linting-Anpassungen vorgenommen.

## Tests & Validierung
- `npm run lint` im Backend (TypeScript) – Erfolgreich.
- `npm run lint` im Frontend (ESLint) – Erfolgreich.
