# VisionSuit – Änderungsbericht

## Übersicht
- UI-Entrümpelung der Dashboard-Header-Leiste (Aktualisieren/Upload entfernt)
- Präzisere Call-to-Action-Beschriftungen in Models- und Galerie-Explorer
- Galerie-Upload-Assistent mit Dropdown zur Auswahl bestehender Sammlungen inkl. Rollenfilter

## Details
### Dashboard-Header
- Entfernt die redundanten Aktionen "Aktualisieren" und "Upload starten" aus dem Haupt-Header.
- Fokus bleibt auf Titel und Beschreibung der aktiven Ansicht.

### Explorer-Aktionen
- Models-Bereich: Button-Label zu "LoRA-Upload öffnen" vereinheitlicht.
- Galerie-Bereich: Call-to-Action zu "Galerie-Upload öffnen" umbenannt.

### Upload-Wizard
- Bestehende Galerien werden beim Öffnen automatisch geladen und nach Rolle gefiltert (Admin = alle, Curator = eigene).
- Radio-Option "Bestehende Galerie" nutzt jetzt ein Dropdown mit Titeln + Kurator:innen.
- Fehler-/Hinweistexte für Ladefehler oder fehlende Galerien ergänzt.
- Review-Schritt zeigt ausgewählte Galerie verständlich an.
- Styling für Dropdown & Hilfetext hinzugefügt.

### Dokumentation
- README-Highlight zu Galerie-Entwürfen aktualisiert (Hinweis auf rollenbasiertes Dropdown).
