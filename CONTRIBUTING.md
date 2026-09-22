# Mitmachen

Schön, dass du helfen willst! 💜 *(English below)*

## Fehler & Ideen

- **Fehler:** Bitte ein [Issue](https://github.com/MinifyX/minis-stream-suite/issues) mit Version (Übersicht → 🖥 App), was du gemacht hast, was passiert ist und was du erwartet hättest. Ein Auszug aus dem Log (Übersicht → Log) hilft sehr.
- **Ideen:** Auch gern als Issue. Kurz beschreiben, wofür du es im Stream brauchst.
- **Sicherheitslücken** bitte nicht öffentlich melden, sondern über „Report a vulnerability“ im Security-Tab des Repos.

## Code beitragen

1. Repo forken, Branch anlegen, `npm install`, `npm start`.
2. Zum Testen eine eigene Instanz nutzen, damit deine echte Suite unberührt bleibt:
   `SUITE_DATA_DIR=C:\temp\suite-test SUITE_PORT=7480 npm start`
3. Vor dem Pull Request: `npm run typecheck` muss durchlaufen.
4. Pull Request mit kurzer Beschreibung, was und warum.

**Stil:** Bitte so schreiben wie der vorhandene Code. Lesbar vor clever, Kommentare auf Deutsch, keine schweren neuen Abhängigkeiten. Oberflächen sind einfaches HTML/CSS/JS ohne Framework (`public/app/ui.js` hat die Helfer). Neue Funktionen am besten als eigenes Addon (siehe README → „Ein neues Addon bauen“).

**Twitch-Rechte:** Neue Scopes in `src/core/twitch/auth.ts` zwingen alle Nutzer, sich neu anzumelden. Deshalb nur, wenn es wirklich nötig ist, und im Pull Request erwähnen.

Mit einem Pull Request stimmst du zu, dass dein Beitrag unter der GPL-3.0-or-later veröffentlicht wird.

---

## Contributing (English)

- **Bugs & ideas:** open an [issue](https://github.com/MinifyX/minis-stream-suite/issues) (English or German is fine). Include the version and a log excerpt if possible.
- **Security issues:** please report privately via "Report a vulnerability" in the repository's Security tab.
- **Code:** fork, `npm install`, `npm start`; use `SUITE_DATA_DIR` / `SUITE_PORT` for a separate test instance; make sure `npm run typecheck` passes. Match the existing style (readable, German comments, no framework in the UI). Adding Twitch scopes forces every user to log in again, so mention it in your PR.
- **Translations** are very welcome. The UI is German-only right now; an i18n approach should be discussed in an issue first.

By opening a pull request you agree that your contribution is licensed under GPL-3.0-or-later.
