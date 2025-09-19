# Änderungsbericht (Commit wird nach Merge ergänzt)

## Zusammenfassung
- Behebt den Storage-Proxyrouten-Pfad, damit Express 5 den Platzhalter akzeptiert.
- Fügt eine gemeinsame Handler-Funktion für GET- und HEAD-Anfragen hinzu, um Wiederholungen zu vermeiden.

## Details
Die bisherige Route verwendete den Ausdruck `/:bucket/:objectKey(.*)`, der mit der in Express 5 verwendeten Version von `path-to-regexp` kollidierte. Dadurch schlug der Serverstart fehl. Die neue Variante `/:bucket/*` verarbeitet nun geschachtelte Objektpfade zuverlässig und leitet die erste Platzhaltervariable (`req.params[0]`) als Objekt-Key weiter. Zudem wird derselbe Handler sowohl für GET- als auch für HEAD-Anfragen verwendet. Der finale Commit-Hash wird nach dem Merge in den Dateinamen übertragen.
