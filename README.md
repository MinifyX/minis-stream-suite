# Mini's Stream Suite

🇬🇧 [English version](README.en.md)

Eine Windows-App für Twitch-Streamer mit einem Addon-System für Alerts, Kanalpunkte, Commands und mehr.

**Aktueller Stand (v0.4):** Installierbare Windows-App mit Core, Bot-Account und sieben Addons.

**Kanalpunkte-Addon:**

- Belohnungen in **Gruppen** sortieren (z.B. „HudFX“). Eine Belohnung kann in mehreren Gruppen stecken.
- Eine ganze Gruppe mit einem Klick **pausieren, fortsetzen, aus- oder einblenden**.
- Eine ganze Gruppe für **Alerts stummschalten**. Das gilt automatisch auch für Belohnungen, die später dazukommen.
- Belohnungen **anlegen, bearbeiten und löschen**: Kosten, Beschreibung, Farbe, Limits, Abklingzeit.
- Im Dashboard angelegte Belohnungen **übernehmen**, damit die Suite sie steuern kann.

- **Keybinds:** Beim Einlösen Tasten drücken (auch bei HudFX-Belohnungen). Wahlweise auf diesem PC oder per **🛰 Satellite** auf einem zweiten PC.
- **Spiel-Regeln:** Gruppen nur bei bestimmten Spielen aktiv, automatisch beim Kategoriewechsel.

**Chat-Commands-Addon:**

- Eigene `!commands` mit Aliasen, Variablen (`{user}`, `{touser}`, `{count}`, `{random:1-6}`, `{pick:a|b}`, `{game}`, `{uptime}`, `{followage}` …), Rechten (Alle/Subs/VIPs/Mods/du) und Cooldowns (für alle und pro Zuschauer).
- Optional ein Keybind pro Command, auf diesem PC oder per 🛰 Satellite.
- Vorlagen, Trockenlauf-Test (sendet nichts) und Verlauf der letzten Aufrufe.
- Antworten schreibt der 🤖 Bot-Account, falls verknüpft, sonst dein eigener Account.

**Timer-Nachrichten-Addon:**

- Automatische Chat-Nachrichten alle X Minuten, aber nur, wenn seitdem genug im Chat los war (kein Spam in einen leeren Chat).
- Mehrere Nachrichten pro Timer, der Reihe nach oder zufällig. Nur wenn live (Stream-Start/-Ende kommt live per EventSub), optional nur bei bestimmten Spielen.
- Mindestabstand zwischen Timern, Vorschau mit Variablen, „Jetzt senden“, Vorlagen und Live-Status pro Timer.

**📊 Umfragen-Addon:**

- **Chat-Umfrage:** Zuschauer stimmen mit `!vote 2`, `!vote Pizza` oder einfach `2` ab. Bis zu 10 Antworten, beliebig lang, Stimme änderbar, einstellbar wer abstimmen darf. Geht in jedem Kanal.
- **Twitch-Umfrage:** die echte Umfrage oben im Twitch-Chat (Affiliate/Partner), optional mit Kanalpunkten für Zusatzstimmen. Auch Umfragen, die direkt bei Twitch gestartet werden, erscheinen im Overlay.
- **OBS-Overlay** (`/addons/polls/overlay.html`) mit Live-Balken, Restzeit und Gewinner. Farben, Größe und Anzeigedauer einstellbar.
- Nachrichten zu Start, Halbzeit und Ergebnis (mit Variablen), Mods starten per `!poll 90 Frage | A | B` und beenden mit `!endpoll`.
- Verlauf der letzten 30 Umfragen mit „↻ Nochmal“.

**👀 Lurk-Addon:**

- Lurken geht **nur** mit `!lurk` (optional mit Grund: `!lurk bin kochen`).
- Schreibt der Zuschauer danach wieder etwas, erkennt die Suite das automatisch: „Willkommen zurück, … Du hast 1 Std. 5 Min. gelurkt.“
- Statistik pro Zuschauer (Anzahl, Gesamtzeit, längster Lurk): `!lurkstats`, `!lurkstats @name`, `!toplurker`. In der App als Tabelle.
- Beim Streamende werden alle Lurks still beendet. Test-Bereich zum Ausprobieren, ohne etwas zu senden.

**🤖 Bot-Account:** Ein zweiter Twitch-Account (z.B. „MinisBot“) schreibt die Nachrichten der Suite (Commands, Timer, Umfragen, Lurk). Verknüpfen in der Übersicht: Es öffnet sich ein eigenes Anmeldefenster, dein Hauptaccount bleibt im Browser eingeloggt. Den Bot per Klick zum Mod machen (dann darf er schneller schreiben und Links posten). Klappt es mit dem Bot mal nicht, schreibt notfalls dein eigener Account. Was du im Chat-Fenster tippst, schreibst weiterhin du selbst.

Alle Chat-Nachrichten laufen über eine gemeinsame Warteschlange im Core (`core/chat.ts`), damit zusammen nie Twitchs Limit gerissen wird.

**Chat-Overlay & Chat-Fenster:**

- **OBS-Overlay** (`/addons/chat/overlay.html`) mit Twitch-, 7TV-, BTTV- und FFZ-Emotes, Abzeichen, Namensfarben und eingestreuten Events. Schrift, Hintergrund, Animation und Ausblenden sind einstellbar, dazu eine Live-Vorschau. Von Mods gelöschte Nachrichten verschwinden sofort.
- **Markdown & Farben** im Chat: `**fett**`, `*kursiv*`, `~~durch~~`, `` `code` ``, `[rot]Text[/]`, `[#ff00aa]Text[/]`, `[regenbogen]Text[/]`. Pro Funktion einstellbar, ab welcher Rolle sie erlaubt ist.
- **Chat-Fenster** wie Chatterino: lesen, schreiben und antworten, Events (auswählbar), Erwähnungen und Stichwörter hervorheben, immer im Vordergrund. Auch als OBS-Dock nutzbar (`/addons/chat/window.html`).
- Einlösungen, die im Alert-Filter stumm sind (z.B. HudFX), erscheinen nicht im Overlay. Im Fenster sind sie mit 🔕 markiert.

**🛰 Satellite (Zwei-PC-Setup):** Die Suite läuft auf dem Stream-PC, die Tasten werden auf dem Gaming-PC gedrückt. Unter Kanalpunkte → 🛰 Satellite den Zugang einschalten und die Satellite-Datei (`.cmd`) herunterladen. Auf dem Gaming-PC doppelklicken, installieren muss man nichts. Die Verbindung läuft über das Heimnetz (Port 7475) und ist mit einem geheimen Schlüssel geschützt. Oberfläche und API der Suite bleiben nur auf dem Stream-PC erreichbar.

> **Twitch-Einschränkung:** Eine App darf nur Belohnungen ändern, die sie selbst angelegt hat. Belohnungen aus dem Dashboard oder von anderen Apps (z.B. HudFX) sind 🔒 „nur lesen“. Sortieren und für Alerts stummschalten klappt trotzdem. Belohnungen von anderen Apps niemals übernehmen, sonst erkennt die andere App sie nicht mehr.

**Alerts-Addon mit Alert-Editor:**

- **Varianten** pro Event-Art (Follows, Abos, verschenkte Abos, Bits, Raids, Kanalpunkte) mit Bedingungen, z.B. „ab 1000 Bits“, „nur Verlängerungen ab 12 Monaten“ oder „nur diese Belohnungen“. Die oberste passende Variante gewinnt, oder es wird zufällig gewechselt.
- **Editor** wie bei Twitch: Layout, Hintergrund, Schrift, Farben, Animationen, Bild/Video, Sound, Vorlesen (Windows-Stimmen) und Effekte (Konfetti, Feuerwerk, …), mit Live-Vorschau.
- **Belohnungs-Filter**: Belohnungen, die nie einen Alert auslösen. So verrät kein Alert mehr deinen HudFX-Jumpscare.

## Installieren

`Minis-Stream-Suite-Setup-<version>.exe` ausführen. Die Suite landet im Startmenü und auf dem Desktop. Einstellungen und Logins bleiben bei Updates und beim Deinstallieren erhalten (`%APPDATA%\Mini's Stream Suite\`).

- **Schließen** (X) lässt die Suite im Infobereich unten rechts weiterlaufen, damit Overlays, Commands und Bot aktiv bleiben. Beenden: Rechtsklick auf das Symbol → Beenden. Abschaltbar in der Übersicht unter 🖥 App.
- **Mit Windows starten:** in der Übersicht unter 🖥 App einschalten. Die Suite startet dann unsichtbar im Infobereich.
- **Updates** kommen automatisch: Die Suite lädt neue Versionen von GitHub im Hintergrund und installiert sie beim Beenden (oder sofort per Klick in der Übersicht).
- Solange die .exe nicht signiert ist, warnt Windows SmartScreen beim ersten Start: „Weitere Informationen“ → „Trotzdem ausführen“.

Download: [Releases](https://github.com/MinifyX/minis-stream-suite/releases)

## Entwickeln

Voraussetzung: [Node.js](https://nodejs.org) (LTS).

```bash
npm install
npm start          # App aus dem Quellcode starten
npm run dist       # Installer bauen → release/Minis-Stream-Suite-Setup-<version>.exe
```

Zum Testen neben der echten Suite (eigener Datenordner und Port, echte Logins bleiben unberührt): Umgebungsvariablen `SUITE_DATA_DIR` und `SUITE_PORT` setzen.

## Einrichtung (einmalig)

1. **Mit Twitch verbinden** klicken und im Browser bestätigen. (Eine eigene Twitch-App brauchst du nicht, die Suite bringt eine mit. Wer mag, trägt unter „Erweitert“ eine eigene Client-ID ein.)
2. Optional: **🤖 Bot-Account** verknüpfen und zum Mod machen.
3. **In OBS:** Browser-Quelle mit `http://127.0.0.1:7474/addons/alerts/overlay.html` hinzufügen. Breite und Höhe wie im Editor unter „Vorschau“ (Standard 800×600).
4. Die nativen Twitch-Alerts ausschalten, damit Alerts nicht doppelt erscheinen.

## Aufbau

```
src/
  main.ts                 Einstieg: startet alles und öffnet das Fenster
  core/
    twitch/auth.ts        Twitch-Login (Device Code Flow, Tokens verschlüsselt gespeichert)
    twitch/eventsub.ts    Live-Events von Twitch per WebSocket
    twitch/events.ts      Einheitliche Event-Typen (redemption, follow, sub, …)
    twitch/api.ts         Helfer für die Twitch Helix API
    eventBus.ts           Verteilt Events an alle Addons
    server.ts             Lokaler Webserver: Oberfläche, Overlays, API, WebSocket
    addons.ts             Addon-System (Addon-Interface + Verwaltung)
    coreRoutes.ts         API für die Oberfläche
    chat.ts               Chat-Warteschlange (Bot oder eigener Account), {Variablen}, Rollen
    bot.ts                Bot-Account: Login im eigenen Fenster, Mod-Status, Einstellungen
    desktop.ts            Hauptfenster, Infobereich (Tray), Autostart
  addons/
    index.ts              Liste aller Addons
    alerts/index.ts       Alerts-Addon: API, Uploads, Test-Alerts
    alerts/model.ts       Varianten, Bedingungen, Design + Auswahl-Logik
    alerts/tts.ts         Sprachausgabe über Windows-Stimmen
    channelpoints/        Kanalpunkte-Addon (Gruppen, Belohnungen, Übernehmen)
    channelpoints/service.ts  Schnittstelle für andere Addons (Gruppen → Alerts)
    private/             Eigene Addons, die nicht ins Repo sollen (in .gitignore, optional)
    polls/index.ts        Umfragen: Chat- und Twitch-Umfragen, Mod-Commands, Verlauf
    lurk/index.ts         Lurk: !lurk, „Willkommen zurück“, Statistik
public/
  app/                    Oberfläche der App (HTML/CSS/JS)
  addons/alerts/
    editor.*              Alert-Editor
    renderer.js           Zeichnet Alerts (für Overlay UND Vorschau)
    library.js            Eingebaute Bilder (SVG) + Sounds (Web Audio)
    effects.js            Konfetti, Feuerwerk, Herzen, Sterne
    overlay.html          Browser-Quelle für OBS
  addons/channelpoints/   Oberfläche des Kanalpunkte-Addons
  addons/polls/           Oberfläche + overlay.html (Browser-Quelle für OBS)
  addons/lurk/            Oberfläche des Lurk-Addons
build/icon.png            App-Icon (Installer, Fenster, Infobereich)
```

**Ablauf eines Events:** Twitch → `eventsub.ts` → `EventBus` → Addons (z.B. Alerts entscheidet: Alert ja oder nein) → WebSocket → Overlay in OBS.

## Ein neues Addon bauen

1. `src/addons/<name>/index.ts` anlegen und ein `Addon`-Objekt exportieren (Vorlage: `alerts`).
2. In `src/addons/index.ts` zu `builtInAddons` hinzufügen.
3. Optional: Einstellungsseite und Overlay unter `public/addons/<name>/`.

Addons, die nur für dich sind und nicht ins Repo sollen, gehören nach `src/addons/private/` (steht in `.gitignore`). Dort eine `index.ts` anlegen, die `privateAddons: Addon[]` exportiert; die Suite lädt sie automatisch. Die Oberfläche kann dann per `publicDir` neben dem Code liegen.

Im `activate(ctx)` stehen dem Addon zur Verfügung:

- `ctx.events` für Twitch-Events
- `ctx.twitch` für die Twitch-API
- `ctx.settings()` für eigene Einstellungen
- `ctx.api` für eigene API-Routen
- `ctx.overlay.broadcast()` um Daten an Overlays zu schicken
- `ctx.provide()` / `ctx.use()` für Schnittstellen zwischen Addons (z.B. Kanalpunkte-Gruppen → Alerts)
- „Alert erscheint jetzt im Overlay“: `ctx.provide(ALERT_SHOWN_SERVICE, { alertShown(event) {…} })` (aus `addons/alerts`), z.B. um Licht oder Sounds genau zum Alert zu starten

Einstellungen liegen unter `%APPDATA%\Mini's Stream Suite\`.

## Roadmap

- [x] Core: Twitch-Login, EventSub, Overlay-Server, Addon-System
- [x] Alerts mit Filter pro Belohnung
- [x] Alert-Editor mit Varianten, eigenen Medien, Sprachausgabe und Effekten
- [x] Kanalpunkte-Addon: Belohnungen verwalten, Gruppen (z.B. „HudFX“), Gruppen pausieren und für Alerts stummschalten
- [ ] Kanalpunkte: Warteschlange (Einlösungen erledigen oder erstatten), Gruppen automatisch beim Stream-Start/-Ende schalten
- [x] Chat-Commands
- [x] Timer-Nachrichten
- [x] Eigener Bot-Account für Chat-Antworten
- [x] Umfragen (Chat + Twitch) mit OBS-Overlay
- [x] Lurk mit „Willkommen zurück“ und Statistik
- [x] Installer (.exe), Infobereich und Autostart
- [ ] Automatische Updates (GitHub Releases)
- [ ] Addon-Store mit Addons von außerhalb

## Mitmachen & Lizenz

Fehler gefunden oder eine Idee? Gern als [Issue](https://github.com/MinifyX/minis-stream-suite/issues) melden. Wie man mitentwickelt, steht in [CONTRIBUTING.md](CONTRIBUTING.md), wie ein Release entsteht in [docs/RELEASING.md](docs/RELEASING.md).

Die Suite ist freie Software unter der **GNU General Public License v3.0 oder neuer** ([LICENSE](LICENSE)). Du darfst sie benutzen, verändern und weitergeben. Veränderte Versionen, die du weitergibst, müssen ebenfalls unter der GPL und mit Quellcode erscheinen.

Die Suite ist kein offizielles Produkt von Twitch.
