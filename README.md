# Cockpit Plus – Abo-Verfahren

Separate Version von Cockpit Plus mit Kundenkonto, Abo pro Fahrzeug, automatischer Sperre und Admin-Bereich.
Die bisherige Version (Branch `main`) bleibt unverändert.

## Was ist drin?

| Ordner | Inhalt |
|---|---|
| `web/` | Öffentliche Seiten für Netlify: Anmeldung/Registrierung/PIN/Fahrzeugwahl (`index.html`), Admin-Bereich (`admin/`), AGB, Datenschutz, Impressum |
| `app/cockpit.html` | Das eigentliche Programm (Kassenbuch, Fahrtenbuch, Schichtauswertung) – **liegt NICHT auf Netlify**, sondern verschlossen auf dem Server |
| `app/shim.js` | Verbindungsstück: trennt Daten pro Fahrzeug und sichert sie auf dem Server |
| `supabase/migrations/001_abo_schema.sql` | Datenbank (Tabellen, Zugriffsregeln, Funktionen) |
| `supabase/functions/` | Server-Funktionen: Abo/Mollie (`billing`), Mollie-Rückmeldung (`mollie-webhook`), Programm ausliefern (`app-code`), Admin-Aktionen (`admin`), tägliche Prüfung (`daily-check`) |
| `tools/build-app.mjs` | Baut `app/cockpit.html` aus der normalen Cockpit-Plus-Datei (Berechnungslogik bleibt unverändert) |

## So funktioniert die Sicherheit

1. Auf Netlify liegt nur die Anmeldeseite. Das Programm lädt der Server erst nach Login **mit bezahltem Abo und freigegebenem Gerät** (`app-code`).
2. Alle Daten liegen in der Datenbank. Die Datenbank selbst prüft bei jedem Zugriff, ob das Abo aktiv ist (Row Level Security). Gesperrt = keine Daten.
3. Status (bezahlt / offen / gesperrt) setzt nur der Server – über die Rückmeldungen von Mollie. Am Handy lässt sich daran nichts ändern.
4. PIN pro Gerät (verschlüsselt gespeichert, 5 Fehlversuche → neu anmelden), Geräte-Limit pro Konto (Standard 3).
5. Admin-Bereich nur für eingetragene Admins **mit Zwei-Faktor-Code**. Admins sehen Konten und Zahlungen, aber **keine** Kassenbuch-/Fahrtenbuchdaten der Kunden.

Ehrlicher Hinweis: Ein zahlender Kunde mit Technikwissen könnte den Programmcode einmal aus dem Browser abspeichern. Ohne Konto hat er damit aber keine Daten, keine Sicherung, keinen Portal-Abruf und keine Updates. Weiterschicken des Links/der App bringt nichts – Empfänger sehen nur die Anmeldeseite.

## Abläufe

- **Registrierung:** Zugang → Firmendaten + Fahrzeuge + AGB-Häkchen (gespeichert mit Version, Zeit, IP, Gerät) → SEPA-Mandat (IBAN) → PIN festlegen → Fahrzeug wählen → App startet.
- **Abo:** 1 Abo pro Unternehmer, Betrag = Fahrzeuge × Preis. Erster Monat sofort, dann monatlich automatisch.
- **Fahrzeug hinzufügen:** Abo steigt sofort, Restmonat wird anteilig eingezogen. **Abbestellen:** ab nächstem Monat günstiger.
- **Zahlung platzt:** Status „Zahlung offen“, Hinweis in der App, 14 Tage Frist (einstellbar). Danach automatische Sperre.
- **Nachzahlen:** Knopf „Offenen Betrag jetzt bezahlen“ → nach Zahlungseingang automatische Freischaltung.
- **Kündigung:** zum Ende des bezahlten Monats.
- **Neue AGB-Version:** In `settings.agb_version` hochsetzen → jeder Kunde muss beim nächsten Start neu bestätigen.

---

## Einrichtung (Schritt für Schritt)

### 1. Supabase (Server + Datenbank)
1. Auf <https://supabase.com> Konto anlegen → **New project** → Region **Frankfurt (eu-central-1)** → starkes Datenbank-Passwort notieren.
2. Plan auf **Pro** stellen (keine Pausen, tägliche Backups).
3. **SQL Editor** → Inhalt von `supabase/migrations/001_abo_schema.sql` einfügen → **Run**.
4. **Authentication → URL Configuration:** *Site URL* = eure App-Adresse (z. B. `https://cockpitplus.netlify.app`).
5. **Authentication → Providers → Email:** „Confirm email“ eingeschaltet lassen.
6. **Storage → Bucket `app`** → Datei `app/cockpit.html` hochladen (genau dieser Name).
7. **Project Settings → API:** *Project URL* und *anon public key* kopieren → in `web/config.js` eintragen.

### 2. Mollie (Zahlungen)
1. Auf <https://www.mollie.com/de> Firmenkonto anlegen, Verifizierung abschließen (Ausweis, Gewerbe, Geschäftskonto).
2. Zahlungsart **SEPA-Lastschrift** aktivieren. Beim Mollie-Support freischalten lassen: **„Mandate per API anlegen“** (für das IBAN-Formular). Bis dahin funktioniert die Alternative „Kreditkarte/PayPal“.
3. **Entwickler → API-Schlüssel:** zuerst den **Test-Schlüssel** (`test_…`) verwenden, nach erfolgreichem Test den **Live-Schlüssel** (`live_…`).

### 3. Server-Funktionen hochladen
Mit der Supabase-CLI (Claude Code kann das übernehmen):
```bash
supabase login
supabase link --project-ref <projekt-id>
supabase secrets set MOLLIE_API_KEY=test_xxx APP_URL=https://cockpitplus.netlify.app \
  ALLOWED_ORIGINS=https://cockpitplus.netlify.app CRON_SECRET=<langes-zufallswort>
supabase functions deploy billing app-code admin
supabase functions deploy mollie-webhook daily-check --no-verify-jwt
```

### 4. Tägliche Sperrprüfung
**Database → Extensions → `pg_cron`** aktivieren, dann im SQL Editor:
```sql
select cron.schedule('cockpit-lock-overdue', '15 3 * * *', $$select public.lock_overdue_companies()$$);
```

### 5. Netlify
Neue Website aus diesem Ordner/Branch, *Publish directory* = `web` (steht schon in `netlify.toml`).

### 6. Admins anlegen (Hasan + Partner)
1. Supabase → **Authentication → Users → Add user** (E-Mail + Passwort) – für beide.
2. Im SQL Editor:
```sql
insert into public.admins (user_id, name)
select id, 'Hasan' from auth.users where email = 'HASAN@EMAIL';
insert into public.admins (user_id, name)
select id, 'PARTNER' from auth.users where email = 'PARTNER@EMAIL';
```
3. `https://<app>/admin/` öffnen → anmelden → QR-Code mit Authenticator-App scannen.

### 7. Testen (mit Mollie-Testschlüssel)
- Registrieren (im Mollie-Testmodus mit einer gültigen Test-IBAN laut Mollie-Doku), App öffnen, Daten eingeben, abmelden/anmelden → Daten müssen wieder da sein.
- Im Mollie-Testdashboard eine Zahlung auf „failed“ setzen → Kunde muss „Zahlung offen“ sehen.
- Im Admin-Bereich sperren → App muss sich sperren. Freischalten → wieder offen.
- Danach Live-Schlüssel eintragen.

### Einstellungen ändern
```sql
update public.settings set price_per_vehicle = 7.00, grace_days = 14, max_devices = 3 where id = 1;
```

### Neue Cockpit-Plus-Version einspielen
```bash
node tools/build-app.mjs ../OKS-System/index.html   # erzeugt app/cockpit.html
```
Dann `app/cockpit.html` in Supabase Storage (Bucket `app`) ersetzen. Kunden bekommen sie beim nächsten Start.

## Vor dem Live-Start
- [ ] AGB, Datenschutzerklärung, Impressum, AV-Vertrag anwaltlich prüfen (`web/agb.html`, `web/datenschutz.html`, `web/impressum.html`)
- [ ] `CREDITOR_NAME` und `SUPPORT_EMAIL` in `web/config.js`
- [ ] Preis netto/brutto festlegen
- [ ] E-Mail-Erinnerung bei geplatzter Zahlung anbinden (Stelle im Code: `mollie-webhook`, „TODO E-Mail“)
- [ ] Sicherheits-Check durch IT-Freelancer
- [ ] Bestehende Kunden: Daten aus der alten Version per „Sicherung“ (ZIP) exportieren und in der neuen Version pro Fahrzeug wiederherstellen

## Demo ansehen
Solange `web/config.js` leer ist, laufen Kundenseite und Admin-Bereich im **Demo-Modus** mit Beispieldaten.
- Kundenseite: `/` (beliebige E-Mail/Passwort) · gesperrt: `/?zustand=gesperrt` · Zahlung offen: `/?zustand=offen`
- Admin: `/admin/` (beliebige Daten, Code: 6 beliebige Ziffern)
