# Änderungsbericht – 19.09.2025 (Commit TBD)

## Überblick
- Frontend robuster gegenüber fehlenden Bild-Metadaten gemacht, damit Galerien und Übersichten nicht mehr abstürzen.
- README-Highlights um den Hinweis zur neuen Fehlertoleranz ergänzt.

## Frontend
- `ImageAsset`-Typ aktualisiert, sodass Metadaten optional vom Backend geliefert werden können.
- Galerie-Alben und Bildlisten prüfen Metadaten-Felder konsequent per Optional-Chaining und halten Lightbox & Vorschauraster stabil.
- Suche und Detail-Karten in der Image-Galerie berücksichtigen fehlende Metadata ohne Fehlermeldung.

## Dokumentation
- README um eine Kurznotiz zur robusten Metadatenanzeige erweitert, damit Betreiber*innen den Fix nachvollziehen können.

## Tests
- `npm run build` (Frontend)

_Eintrag wird nach Release mit der finalen Commit-ID aktualisiert._
