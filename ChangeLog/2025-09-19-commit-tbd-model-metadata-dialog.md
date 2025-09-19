# Änderungsbericht – Metadaten-Aufbereitung & Tag-Dialog

## Zusammenfassung
- Safetensor-Metadaten werden nun rekursiv normalisiert. Werte wie `modelspec.architecture` oder verschachtelte `ss_metadata`-Einträge landen zuverlässig als Base-Model/Model-Name im Payload.
- Der Asset-Explorer filtert `ss_tag_frequency` aus der Tabellenansicht und öffnet die Datensatz-Tags in einem eigenen Dialog mit gruppierten Häufigkeiten.
- Neue UI-Komponenten (Button, Dialog, Tabellen-Styling) sorgen für eine klare Trennung zwischen Metadaten und Tag-Auswertung.
- README um Hinweis auf die erweiterte Metadatenlogik ergänzt.

## Details
### Backend
- Rekursive JSON-Erkennung für verschachtelte Safetensor-Felder implementiert.
- Kandidatenlisten für Base-Model und Model-Name um `modelspec.*` sowie `ss_metadata.*` Pfade erweitert.
- Alias-Handling vereinheitlicht, `modelAliases` enthält nun alle gefundenen Namen in stabiler Reihenfolge.

### Frontend
- Metadaten-Renderer ignoriert Tag-Frequenzen und hebt `extracted`-Werte ohne Präfix hervor.
- Neuer Datensatz-Tag-Dialog inklusive ESC-/Backdrop-Handhabung, Rollenzuordnung und Scroll-Optimierung.
- Zusätzliche Styles für Header-Buttons und Tabellen.

### Dokumentation
- Highlights um die intelligente Auswertung der LoRA-Metadaten ergänzt.
