# Intro-Sequenz & Musik – Notizen

Umsetzung des Plans „Intro-Sequenz & Musik-Player für die Stream Suite“. Hier stehen die
Einrichtung, die Annahmen (im Code als `// ANNAHME:` markiert) und was noch offen ist.

## Überblick

| Teil | Wo |
|---|---|
| Intro-Addon (Backend, DONE-Aktionen, API) | `src/addons/intro/` |
| Intro-Player (OBS-Browserquelle) | `public/addons/intro/player.html`, `player.js` |
| State Machine (getestet) | `public/addons/intro/sequencer.js`, Tests in `src/addons/intro/sequencer.test.ts` |
| Musik-Addon (MusicManager, Provider, Spotify, Bibliothek) | `src/addons/music/` |
| Music-Host (eigenes Chrome/Edge-Fenster) | `public/addons/music/host.html`, `host.js` |
| Now-Playing-Overlay | `public/addons/music/now-playing.html` |
| Fernsteuer-Routen mit `X-Suite-Token` | `src/core/server.ts` (Option `token`), `ctx.api.remote` |

Beide Addons sind standardmäßig **aus** und werden im Addon-Store eingeschaltet. Für den
Szenenwechsel muss außerdem „OBS-Steuerung“ an und verbunden sein.

## Einrichtung

### 1. Intro

1. Addon-Store → **Intro-Sequenz** einschalten.
2. Medienordner wählen (Intro-Seite → Medien). Leer = `%APPDATA%\Mini's Stream Suite\addon-data\intro\media`.
3. Dateinamen der fünf Segmente eintragen. Video ist optional (leer = schwarzes Bild).
4. In OBS: **Browser**-Quelle mit der Adresse von der Intro-Seite (`…/addons/intro/player.html`),
   1920 × 1080, Haken bei **„Audio über OBS steuern“**. Nur **eine** solche Quelle.
   Nicht „Quelle herunterfahren, wenn nicht sichtbar“ anhaken – sonst lädt der Player jedes Mal neu.
5. Unter „Nach dem Intro“ die Stream-Szene wählen. Optional eine Intro-Szene für den Start.
6. Zum Ausprobieren ohne eigenes Material: `npm run intro:dummy` (braucht ffmpeg) erzeugt Testdateien
   in `media/intro` – mit Klick auf jedem Beat und Beat-Blitz im Bild, so hört/sieht man Lücken und Versatz.
   Mit `?debug=1` hinter der Player-Adresse zeigt der Player Zustand, Restzeit und Versatz an.

### 2. Musik

1. Addon-Store → **Musik** einschalten.
2. **Music-Host öffnen** (Musik-Seite). Die Suite startet Chrome (oder Edge) als eigenes App-Fenster mit
   eigenem Profil. Das Fenster offen lassen, minimieren ist ok.
3. **Spotify** (optional):
   1. <https://developer.spotify.com/dashboard> → „Create app“.
   2. Redirect URI: genau die Adresse von der Musik-Seite, z.B. `http://127.0.0.1:7474/addons/music/callback.html`
      (Spotify erlaubt nur `127.0.0.1`, nicht `localhost`; bei anderem `SUITE_PORT` ändert sich der Port).
   3. APIs: **Web API** und **Web Playback SDK** ankreuzen.
   4. Client ID in der Suite eintragen, unter „User Management“ den eigenen Account eintragen.
   5. „Mit Spotify verbinden“.
4. **Eigene Musik** (optional): Ordner wählen, jeder Unterordner ist eine Playlist.
5. Auto-Start-Playlist mit ⭐ markieren (Spotify-Playlist oder lokaler Ordner).
6. Now-Playing-Overlay: Browser-Quelle `…/addons/music/now-playing.html`, z.B. 800 × 200.

### 3. Audio-Routing in OBS

- **Intro-Ton** kommt aus der Browserquelle des Players („Audio über OBS steuern“).
- **Musik** kommt aus dem Music-Host-Fenster (bzw. bei „Desktop-App fernsteuern“ aus der Spotify-App):
  in OBS eine **Anwendungsaudioaufnahme** genau für dieses Fenster anlegen. Weil der Host ein eigenes
  Browserprofil hat, ist er ein eigener Prozess – dein normaler Browser landet nicht im Stream.
- Ob die Musik im **Twitch-VOD** landet, stellst du in OBS unter *Erweiterte Audioeigenschaften* bei den
  Spuren ein. Die Suite ändert daran nichts.

### 4. Streamdeck

Alle Fernsteuer-Endpunkte brauchen den Header `X-Suite-Token` (Schlüssel auf der Intro- oder Musik-Seite
unter „Streamdeck“, Umgebungsvariable `SUITE_API_TOKEN` hat Vorrang). Ohne → `401`.

```bash
curl -X POST -H "X-Suite-Token: <schlüssel>" http://127.0.0.1:7474/api/intro/go
curl -X POST -H "X-Suite-Token: <schlüssel>" -H "Content-Type: application/json" -d "{\"delta\":-10}" http://127.0.0.1:7474/api/music/volume
```

- Streamdeck: Plugin für HTTP-Anfragen (z.B. „API Ninja“ oder „Web Requests“), Methode POST, Header setzen.
- Bitfocus Companion: Modul „Generic HTTP“, Header `X-Suite-Token`.
- Der Server lauscht nur auf `127.0.0.1` (wie bisher) – Streamdeck/Companion müssen auf dem Stream-PC laufen.

Intro: `POST /api/intro/{start,go,outro,cancel-pending,abort,reset}`, `GET /api/intro/state`.
Musik: `POST /api/music/{play,pause,toggle,next,previous,volume,provider}`, `GET /api/music/{now-playing,state}`.
Fehler: `409` falscher Zustand / kein Player verbunden, `503` Provider oder Spotify nicht erreichbar,
`504` Player antwortet nicht.

## Anforderungen an das Medienmaterial

- **Audio:** WAV, 48 kHz, 24 bit, eine Datei pro Segment. Loops exakt auf ganze Takte, ohne Stille am
  Anfang oder Ende. **Kein MP3/AAC/Opus** für Segmente: Diese Formate setzen am Anfang und Ende
  Füll-Samples (Encoder-Delay/Padding), dann stimmen Loop-Grenzen nicht mehr.
- **Loops in FL Studio** mit Tail-Option **„Wrap remainder“** exportieren: Was über das Loop-Ende
  hinausklingt (Hall, Bass, Becken), wird an den Anfang gemischt – dann klickt die Wiederholung nicht.
- **Video:** ohne Tonspur, 1920 × 1080, eine Framerate für alle Segmente (z.B. 60 fps), WebM (VP9) oder
  MP4 (H.264), so lang wie das Audio.
- Das **Outro** inklusive Ausklang als **eine** Datei.

### Befund zu den gelieferten MP3s (`Desktop\IntroMusik\IntroMusic`)

- Tempo 124 BPM. Längen: Intro 12 Takte, Loop 1 8 Takte, Main 22 Takte, Loop 2 4 Takte, Outro 4 Takte
  (zusammen genau 120,000 s).
- Die MP3s haben keinen LAME/Xing-Gapless-Header; vorn stecken 1105 Samples Encoder-Versatz, hinten Padding.
  Daraus sind taktgenau geschnittene WAVs in `…\IntroMusic\suite-wav\` entstanden (zum Testen).
- **Loop 1 endet mitten in einem lauten Sound** (Pegel am Ende ~0,6, Anfang fast still). Das klickt bei jeder
  Wiederholung und beim Wechsel zu Main – unabhängig vom Player. Lösung: Loop 1 in FL Studio mit
  „Wrap remainder“ als WAV neu exportieren. Loop 2, Main → Loop 2 und Loop 2 → Outro sind sauber.

## Annahmen

- **Kein eigener Config-Mechanismus mit `.env`/jsonc:** Die Suite ist eine installierte Windows-App mit
  Einstellungsdateien in `%APPDATA%`. Alle Werte aus Abschnitt 7 des Plans sind in der Oberfläche
  einstellbar; `.env` wird nur beim Entwickeln (`npm start`) gelesen (`SUITE_API_TOKEN`,
  `SPOTIFY_CLIENT_ID`, `OBS_PASSWORD`).
- **OBS-Verbindung:** Das Intro nutzt die Verbindung des vorhandenen Addons „OBS-Steuerung“
  (Schnittstelle `ctx.use('obs')`) statt einer zweiten Verbindung. Host/Port/Passwort stehen daher dort.
- **Medienordner** frei wählbar statt relativ zum Programmordner (der ist bei der installierten App schreibgeschützt).
- **Video optional**, damit man den Beat ohne fertige Videos testen kann.
- **Trigger kurz vor der Grenze:** Ein Trigger wird bis 80 ms vor der Loop-Grenze noch für diese Grenze
  eingeplant (das schon eingeplante Segment wird ersetzt). Danach gilt er für die übernächste Grenze.
- **Mehrere Player:** Sind zwei Player-Seiten offen, würde das Intro doppelt laufen. Die Suite warnt
  in der Oberfläche; Befehle gehen an alle, die erste Antwort zählt.
- **„start“ aus DONE** geht erst nach „reset“ (wie im Plan).
- **SDK-Übertragung nach „ready“:** Die Wiedergabe wird nur dann auf die Suite übertragen, wenn gerade
  nirgends etwas läuft – sonst würde Musik auf dem Handy beim Start der Suite umziehen.
- **Auto-Start-Quelle bestimmt den Provider:** `local:…` spielt immer lokal, eine Spotify-URI über
  Spotify (SDK, wenn bereit, sonst Fernsteuerung).
- **Fade-in nach dem Intro läuft im Hintergrund:** Die DONE-Webhooks kommen direkt nach dem Musikstart,
  nicht erst nach dem Einblenden.
- **Spotify-Tokens** liegen verschlüsselt (Windows DPAPI) in `secrets/music-spotify.json` – nicht in Sicherungen.
  Ebenso ist der API-Schlüssel nicht in Sicherungen.
- **Sicherung ohne Intro-Medien:** Videos können GB groß sein, die Sicherung liegt komplett im Speicher.
  Der Standard-Medienordner (`addon-data/intro/media`), das Browser-Profil des Music-Hosts und der
  Cover-Cache werden deshalb nicht gesichert. Die Einstellungen (Dateinamen, Ordner) schon.
- **Events auf einem Log pro Addon:** Intro- und Musik-Seite zeigen jeweils die letzten 50 Einträge
  (`system.log`). Fehler der DONE-Aktionen (OBS, Musik, Webhooks) stehen im Intro-Log.
- **Now-Playing-Polling** (Fernsteuerung der Desktop-App) läuft nur, solange die Musik-/Intro-Seite oder
  das Overlay offen ist.

## WebSocket-Kanäle

| Kanal | Wer | Nachrichten |
|---|---|---|
| `intro` | Intro-Seite | `intro.state`, `intro.done`, `player.status`, `system.log` |
| `intro.player` | Intro-Player | → `intro.cmd`, `intro.config`, `intro.reload`; ← `ack`, `intro.state`, `intro.done`, `player.status` |
| `music` | Musik-Seite, Mini-Player | `music.state`, `music.nowPlaying`, `system.log` |
| `music.overlay` | Now-Playing-Overlay | `music.state`, `music.nowPlaying`, `music.overlay` |
| `music.host` | Music-Host | → `local.load`, `local.cmd`, `sdk.init`, `sdk.cmd`, `volume`, `engine`; ← `host.hello`, `local.status`, `sdk.ready`, `sdk.failed`, `sdk.state` |

Nachrichten von Seiten an die Suite werden nur angenommen, wenn die Seite von der Suite selbst kommt
(Origin-Prüfung) – fremde Webseiten im Browser können nichts auslösen.

## Getestet

- `npm test`: State Machine (Quantisierung, vorgemerkte Trigger, cancel-pending, abort aus jedem Zustand,
  reset), Tag-Leser, Spotify-Client (Refresh, 429/Retry-After, Fehlertexte, Geräteauswahl).
- Lückenlosigkeit: Die komplette Sequenz aus den echten WAVs offline mit der Planungslogik des Players
  gerendert – bitgenau identisch mit den aneinandergehängten Dateien (0 Abweichung an allen Übergängen).
- Live in der Testinstanz: Ablauf über die API, 401 ohne Token, 409 ohne Player, DONE-Kette (OBS-Fehler
  geloggt, Musik startet trotzdem mit Fade-in), lokale Wiedergabe mit Crossfade, Overlay-Updates.

## Offen / nicht live getestet

- **Spotify** (SDK und Fernsteuerung) ist gegen eine nachgebaute API getestet, aber nicht mit einem echten
  Account – dafür braucht es deine Client-ID und Premium. Bitte einmal durchklicken:
  Gerät „Stream Suite“ erscheint in der Spotify-App, Auto-Start-Playlist spielt, Fallback auf die Desktop-App.
- Erster Start des Music-Hosts mit neuem Profil: Chrome lädt Widevine eventuell erst nach – dann greift
  beim ersten Mal der 10-s-Fallback. Nach einem Neustart des Hosts geht es normalerweise.
