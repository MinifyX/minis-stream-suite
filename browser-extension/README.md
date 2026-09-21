# Mini's Chat – Browser-Erweiterung

Ersetzt **im Kanal `minifyx`** die Nachrichtenliste von Twitch durch einen eigenen Chat:

- 7TV-, BTTV- und FFZ-Emotes, dazu Twitch-Emotes und Abzeichen
- Markdown (`**fett**`, `*kursiv*`, `~~durch~~`, `` `code` ``) und Farben (`[rot]Text[/]`, `[#ff00aa]Text[/]`, `[regenbogen]Text[/]`), mit denselben Regeln wie in der Stream Suite
- Events direkt im Chat: Subs, Resubs, verschenkte Abos, Raids, Bits, Ankündigungen
- Gelöschte Nachrichten und Timeouts werden entfernt, Erwähnungen hervorgehoben

Das **Eingabefeld von Twitch bleibt**, man schreibt ganz normal. Über „↺ Twitch-Chat“ kann man jederzeit zum Original zurück. In allen anderen Kanälen tut die Erweiterung nichts.

## Bauen

```bash
npm run build:extension
```

Das erzeugt `browser-extension/dist/minis-chat-chrome-1.0.0.zip` und `…-firefox-1.0.0.zip`. Das Skript übernimmt dabei die aktuellen Einstellungen aus der Stream Suite: Wer Markdown und Farben benutzen darf und welche Kanalpunkte-Belohnungen stumm sind. Nach Änderungen dort einfach neu bauen und neu verteilen.

## Installieren (als Datei, ohne Store)

**Chrome / Edge / Opera / Brave**

1. ZIP entpacken (z.B. nach `Dokumente\MinisChat`)
2. `chrome://extensions` öffnen (Edge: `edge://extensions`)
3. Oben rechts **Entwicklermodus** einschalten
4. **Entpackte Erweiterung laden** → den entpackten Ordner wählen

Der Ordner muss danach liegen bleiben. Chrome erinnert beim Start gelegentlich daran, dass Entwickler-Erweiterungen aktiv sind, das ist normal.

**Firefox**

Firefox installiert dauerhaft nur **signierte** Erweiterungen. Zwei Wege:

- **Zum Ausprobieren:** `about:debugging#/runtime/this-firefox` → **Temporäres Add-on laden** → `manifest.json` im entpackten Firefox-Ordner wählen. Nach einem Neustart von Firefox ist sie wieder weg.
- **Dauerhaft (kostenlos):** Die ZIP bei [addons.mozilla.org](https://addons.mozilla.org/developers/) unter „Add-on einreichen“ als **„Auf eigene Faust“ (nicht gelistet)** hochladen. Mozilla signiert sie automatisch, meist in wenigen Minuten. Die signierte `.xpi` können Leute dann per Drag & Drop in Firefox installieren. Sie erscheint nicht öffentlich im Store.

Falls der Chat in Firefox nicht erscheint: In `about:addons` bei der Erweiterung unter **Berechtigungen** den Zugriff auf twitch.tv erlauben.

## Wie es funktioniert

- `content.js` läuft auf twitch.tv. Im Kanal `minifyx` versteckt es die Twitch-Nachrichtenliste und hängt einen eigenen Chat (in einem Shadow DOM) davor ein.
- Nachrichten kommen **anonym** direkt aus dem Twitch-Chat (IRC über WebSocket). Die Erweiterung braucht keinen Login und kann selbst nichts schreiben.
- Emotes und Abzeichen kommen von 7TV, BTTV, FFZ und api.ivr.fi (öffentliche Schnittstellen). `background.js` lädt nur von diesen Adressen.
- Die Darstellung (`render.js`) ist dieselbe wie im Chat-Overlay der Stream Suite. Alles aus dem Chat landet nur als Text im DOM, damit niemand über den Chat Code einschleusen kann.
- Wenn Twitch seine Seite umbaut, müssen evtl. die Selektoren in `findTwitchList()` angepasst werden.
