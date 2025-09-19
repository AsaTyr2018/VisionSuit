# Changelog – 2025-09-19

## Kontext
Der Upload-Assistent enthielt noch zahlreiche deutschsprachige Texte, Platzhalter und Statusmeldungen. Für eine konsistente englische Nutzeroberfläche sollten sämtliche verbleibenden Strings überprüft, übersetzt und auf Lesbarkeit hin optimiert werden. Zusätzlich musste die README den Fortschritt der Frontend-Übersetzung widerspiegeln.

## Umsetzung
- Alle Nutzer:innen sichtbaren Texte im `UploadWizard` wurden ins Englische übertragen, inklusive Validierungsfehlern, Hilfetexten, Fortschrittsanzeige und Footer-Aktionen.
- Neue Mapping-Konstante `CATEGORY_LABELS` ergänzt, damit Zusammenfassungen die englischen Kategorienamen anzeigen.
- Erfolgs- und Reviewmeldungen neu formuliert, damit Beschreibungen, Upload-Limits sowie Benachrichtigungen natürliche englische Formulierungen verwenden.
- Bereits angepasste Komponenten (`App`, `AdminPanel`, `AssetExplorer`, `GalleryExplorer`, `LoginDialog`, `ModelVersionDialog`, `AssetCard`) liegen in dieser Änderung konsolidiert in englischer Sprache vor.
- README-Highlights um einen Hinweis auf das nun englischsprachige UI ergänzt.

## Tests & Validierung
- `npm run lint`
