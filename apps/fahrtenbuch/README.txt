OKS Steuer-App - Netlify Paket

Deployment:
1. ZIP bei Netlify per Drag & Drop hochladen oder Ordner deployen.
2. Build command leer lassen oder npm run build verwenden.
3. Publish directory: .

Neu in dieser Version:
- CSV-Import fragt nach Klick auf Import manuell ab, welche Spalten genutzt werden sollen:
  Fahrer/Fahreranzeige, Zahlungsquelle, Belegtext, Fahrpreis/Gesamtbetrag, Datum/Zeit und optionale Hilfsspalten.
- Tagesabschlüsse/Tagessummen werden ignoriert.
- Tageszuordnung basiert auf dem Fahrtbeginn aus dem Belegtext und korrigiert Fahrten über Mitternacht.
- Umsatzsteuer bleibt erhalten: unter 50 km = 7 %, ab 50 km = 19 %.
- Bestehende Steuerberater-, SIP-, Design-, Auswertungs- und Zusammenrechnungsfunktionen bleiben enthalten.


Lizenzhinweis:
Dieses Programm / diese App gehört Hasan Ordu. Alle Rechte vorbehalten. Siehe LICENSE.txt.
