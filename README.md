# Mini's Stream Suite

Eine Windows-App für Twitch-Streamer mit einem Addon-System für Alerts, Kanalpunkte, Commands und mehr.

**Aktueller Stand (v0.3):** Core plus zwei Addons.

**Kanalpunkte-Addon:**

- Belohnungen in **Gruppen** sortieren (z.B. „HudFX“). Eine Belohnung kann in mehreren Gruppen stecken.
- Eine ganze Gruppe mit einem Klick **pausieren, fortsetzen, aus- oder einblenden**.
- Eine ganze Gruppe für **Alerts stummschalten**. Das gilt automatisch auch für Belohnungen, die später dazukommen.
- Belohnungen **anlegen, bearbeiten und löschen**: Kosten, Beschreibung, Farbe, Limits, Abklingzeit.
- Im Dashboard angelegte Belohnungen **übernehmen**, damit die Suite sie steuern kann.

> **Twitch-Einschränkung:** Eine App darf nur Belohnungen ändern, die sie selbst angelegt hat. Belohnungen aus dem Dashboard oder von anderen Apps (z.B. HudFX) sind 🔒 „nur lesen“. Sortieren und für Alerts stummschalten klappt trotzdem. Belohnungen von anderen Apps niemals übernehmen, sonst erkennt die andere App sie nicht mehr.

**Alerts-Addon mit Alert-Editor:**

- **Varianten** pro Event-Art (Follows, Abos, verschenkte Abos, Bits, Raids, Kanalpunkte) mit Bedingungen, z.B. „ab 1000 Bits“, „nur Verlängerungen ab 12 Monaten“ oder „nur diese Belohnungen“. Die oberste passende Variante gewinnt, oder es wird zufällig gewechselt.
- **Editor** wie bei Twitch: Layout, Hintergrund, Schrift, Farben, Animationen, Bild/Video, Sound, Vorlesen (Windows-Stimmen) und Effekte (Konfetti, Feuerwerk, …), mit Live-Vorschau.
- **Belohnungs-Filter**: Belohnungen, die nie einen Alert auslösen. So verrät kein Alert mehr deinen HudFX-Jumpscare.

## Starten

Voraussetzung: [Node.js](https://nodejs.org) (LTS).

```bash
npm install
npm start
```

## Einrichtung (einmalig)

1. **Twitch-App anlegen:** [dev.twitch.tv/console/apps/create](https://dev.twitch.tv/console/apps/create)
   - Name: z.B. `MinisStreamSuite` (das Wort „Twitch“ ist nicht erlaubt)
   - OAuth-Redirect-URL: `http://localhost`
   - Kategorie: *Application Integration*
   - Client-Typ: **Öffentlich**
2. Die **Client-ID** in der App unter *Übersicht* eintragen.
3. **Mit Twitch verbinden** klicken und im Browser bestätigen.
4. **In OBS:** Browser-Quelle mit `http://127.0.0.1:7474/addons/alerts/overlay.html` hinzufügen. Breite und Höhe wie im Editor unter „Vorschau“ (Standard 800×600).
5. Die nativen Twitch-Alerts ausschalten, damit Alerts nicht doppelt erscheinen.

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
  addons/
    index.ts              Liste aller Addons
    alerts/index.ts       Alerts-Addon: API, Uploads, Test-Alerts
    alerts/model.ts       Varianten, Bedingungen, Design + Auswahl-Logik
    alerts/tts.ts         Sprachausgabe über Windows-Stimmen
    channelpoints/        Kanalpunkte-Addon (Gruppen, Belohnungen, Übernehmen)
    channelpoints/service.ts  Schnittstelle für andere Addons (Gruppen → Alerts)
public/
  app/                    Oberfläche der App (HTML/CSS/JS)
  addons/alerts/
    editor.*              Alert-Editor
    renderer.js           Zeichnet Alerts (für Overlay UND Vorschau)
    library.js            Eingebaute Bilder (SVG) + Sounds (Web Audio)
    effects.js            Konfetti, Feuerwerk, Herzen, Sterne
    overlay.html          Browser-Quelle für OBS
  addons/channelpoints/   Oberfläche des Kanalpunkte-Addons
```

**Ablauf eines Events:** Twitch → `eventsub.ts` → `EventBus` → Addons (z.B. Alerts entscheidet: Alert ja oder nein) → WebSocket → Overlay in OBS.

## Ein neues Addon bauen

1. `src/addons/<name>/index.ts` anlegen und ein `Addon`-Objekt exportieren (Vorlage: `alerts`).
2. In `src/addons/index.ts` zu `builtInAddons` hinzufügen.
3. Optional: Einstellungsseite und Overlay unter `public/addons/<name>/`.

Im `activate(ctx)` stehen dem Addon zur Verfügung:

- `ctx.events` für Twitch-Events
- `ctx.twitch` für die Twitch-API
- `ctx.settings()` für eigene Einstellungen
- `ctx.api` für eigene API-Routen
- `ctx.overlay.broadcast()` um Daten an Overlays zu schicken
- `ctx.provide()` / `ctx.use()` für Schnittstellen zwischen Addons (z.B. Kanalpunkte-Gruppen → Alerts)

Einstellungen liegen unter `%APPDATA%\Mini's Stream Suite\`.

## Roadmap

- [x] Core: Twitch-Login, EventSub, Overlay-Server, Addon-System
- [x] Alerts mit Filter pro Belohnung
- [x] Alert-Editor mit Varianten, eigenen Medien, Sprachausgabe und Effekten
- [x] Kanalpunkte-Addon: Belohnungen verwalten, Gruppen (z.B. „HudFX“), Gruppen pausieren und für Alerts stummschalten
- [ ] Kanalpunkte: Warteschlange (Einlösungen erledigen oder erstatten), Gruppen automatisch beim Stream-Start/-Ende schalten
- [ ] Chat-Commands
- [ ] Installer (.exe) und Autostart
- [ ] Addon-Store mit Addons von außerhalb
