# Mini's Stream Suite

Eine Windows-App für Twitch-Streamer mit einem Addon-System für Alerts, Kanalpunkte, Commands und mehr.

**Aktueller Stand (v0.1):** Core plus **Alerts-Addon**. Damit kannst du pro Kanalpunkte-Belohnung festlegen, ob ein Alert kommt. So verrät zum Beispiel kein Alert mehr deinen HudFX-Jumpscare.

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
4. **In OBS:** Browser-Quelle mit `http://127.0.0.1:7474/addons/alerts/overlay.html` hinzufügen, 1920×1080.
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
    alerts/index.ts       Alerts-Addon: Filter-Logik + API
public/
  app/                    Oberfläche der App (HTML/CSS/JS)
  addons/alerts/          Overlay für OBS + Einstellungsseite
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

Einstellungen liegen unter `%APPDATA%\Mini's Stream Suite\`.

## Roadmap

- [x] Core: Twitch-Login, EventSub, Overlay-Server, Addon-System
- [x] Alerts mit Filter pro Belohnung
- [ ] Kanalpunkte-Addon: Belohnungen verwalten, Gruppen (z.B. „HudFX“), alle Belohnungen einer Gruppe pausieren
- [ ] Chat-Commands
- [ ] Eigene Sounds, Bilder und Designs für Alerts
- [ ] Installer (.exe) und Autostart
- [ ] Addon-Store mit Addons von außerhalb
