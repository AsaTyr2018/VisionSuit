# Änderungsbericht – 19.09.2025 (Commit TBD)

## Überblick
- Implementierung eines serverseitigen Metadatenscanners für Bild- und Safetensors-Dateien.
- Erweiterung des Upload-Workflows um gespeicherte Analyseergebnisse (Prompts, Seeds, Basismodelle).
- Anpassung der Galerie- und Modellendpunkte zur Auslieferung der extrahierten Daten inklusive neuer Filtermöglichkeiten im Frontend.
- Aktualisierung der Oberfläche (Explorer & Admin) zur Auswertung der Metadaten bei Suche und Filterung.
- Dokumentationsupdate in der README mit Hinweis auf die automatische Metadatenerfassung.

## Details
### Backend
- Hinzufügen eines `metadata`-Hilfsmoduls zur Extraktion von Stable-Diffusion-Parametern aus PNG/JPEG und von Headern aus Safetensors-Dateien.
- Integration der Auswertung in den Upload-Endpunkt inklusive Speicherung in `ModelAsset`- bzw. `ImageAsset`-Feldern und Upload-Drafts.
- Ausbau der Galerierouten, sodass Bildantworten ein konsistentes `metadata`-Objekt sowie Eigentümerdaten enthalten.

### Frontend
- Such- und Filterlogik der Explorer und des Admin-Dashboards nutzt nun extrahierte Modellnamen, Seeds und Sampler.
- Anzeige- und Filterfunktionen greifen auf die neuen Metadaten zu, wodurch Basismodelle schnell auffindbar sind.

### Dokumentation
- README um Highlight zur automatischen Metadatenerfassung ergänzt.
