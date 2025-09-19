# Admin-Steuerzentrale überarbeitet

## Überblick
- Admin-Panel neu strukturiert, um 1000+ Benutzer:innen, Modelle und Bilder mit Suchfeldern, Rollenselektion und Sichtbarkeitsfiltern schnell zu filtern.
- Mehrfachauswahl mit Bulk-Löschungen für Accounts, Modelle und Bilder inklusive Rückmeldungen und Sicherheitsabfragen implementiert.
- Galerie- und Albumbearbeitung ergänzt: Metadaten, Sichtbarkeit, Besitzer:in, Cover-Pfad sowie Reihenfolge und Notizen von Einträgen lassen sich direkt anpassen oder entfernen.

## Backend
- Batch-Endpoints für Benutzer:innen, Modell-Assets und Bild-Assets eingeführt (inklusive Storage-Aufräumung und Rechteprüfung).
- Galerie-Endpunkte erweitert (PUT/DELETE) mit Validierung, Transaktionen und Rückgabe des aktualisierten Galerie-Objekts.

## Frontend
- AdminPanel komplett refaktoriert: tabellarische Layouts, Filtertoolbars, Auswahl-Leisten und neue Galerie-Editoren integriert.
- CSS überarbeitet, um neue Tabellen- und Editor-Oberflächen konsistent in das bestehende Dark-Theme einzubetten.
- App-View-Metadaten und README-Highlights aktualisiert, um die erweiterten Admin-Fähigkeiten zu dokumentieren.

## Tests
- `npm run lint` (backend)
- `npm run lint` (frontend)
