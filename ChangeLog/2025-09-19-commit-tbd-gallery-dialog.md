# Changelog – 2025-09-19

## Kontext
Die gekoppelte Zwei-Spalten-Ansicht in Modell- und Galerie-Explorer führte zu eingeschränkter Übersichtlichkeit auf kleineren Displays. Ziel war eine losgelöste Detaildarstellung mit klarer Navigationsführung und wiederkehrbarer Rückkehr in die Grid-Ansicht.

## Umsetzung
- Galerie- und Modellexplorer öffnen Detailinformationen jetzt in modalen Dialogen mit eigener Backdrop-Navigation und Escape-Taste.
- Elternansichten erhalten Rückmeldungen, wenn Dialoge geschlossen werden, damit Deep-Links aus beiden Explorer-Richtungen weiterhin funktionieren.
- CSS-Layout wurde für frei skalierende Grid-Spalten, modale Container und responsive Höhenbegrenzungen aktualisiert.
- README hebt den neuen Dialog-Flow der Explorer hervor, um Nutzer:innen auf die geänderte Interaktion hinzuweisen.

## Tests & Validierung
- `npm run lint`
