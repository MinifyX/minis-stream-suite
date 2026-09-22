# Mini's Stream Suite

🇩🇪 [Deutsche Version](README.md)

A Windows app for Twitch streamers with an add-on system for alerts, channel points, chat commands, polls and more. Everything runs locally on your PC; OBS picks up the overlays as browser sources.

> **Note:** The user interface is currently **German only**. Translations are welcome (see [CONTRIBUTING.md](CONTRIBUTING.md)).

## Features

- **Alerts** with an editor similar to Twitch's: variants with conditions (e.g. "1000+ bits"), layout, fonts, animations, images/videos, sounds, text-to-speech (Windows voices) and effects (confetti, fireworks, …). A **reward filter** keeps specific channel point rewards (e.g. jumpscares from other tools) from ever triggering an alert.
- **Channel points:** sort rewards into groups, pause/resume/hide whole groups with one click, mute groups for alerts, create and edit rewards, press keys on redemption (locally or on a second PC via **Satellite**), enable groups only for certain games.
- **Chat commands** with aliases, variables (`{user}`, `{touser}`, `{count}`, `{random:1-6}`, `{game}`, `{uptime}`, `{followage}` …), permissions, cooldowns and optional key presses.
- **Timed messages** that only fire when the stream is live and chat is active.
- **Polls:** chat polls (`!vote 2` or just `2`, up to 10 options) or native Twitch polls (affiliate/partner, optional channel points), a live OBS overlay, mod commands `!poll 90 Question | A | B` / `!endpoll`, and a history.
- **Lurk:** viewers type `!lurk`; as soon as they write again they are welcomed back automatically with their lurk time. Stats via `!lurkstats`, `!lurkstats @name`, `!toplurker`.
- **Bot account:** link a second Twitch account that writes all of the suite's chat messages (made mod with one click), with fallback to your own account.
- **Chat overlay & chat window** with 7TV/BTTV/FFZ emotes, badges, Markdown and colors, plus a Chatterino-like chat window (also usable as an OBS dock). A matching **browser extension** replaces the Twitch chat list in your channel.
- **Satellite:** run the suite on your streaming PC and press keys on your gaming PC over the local network.
- Runs in the **system tray**, optional **autostart** with Windows, **automatic updates** from GitHub Releases.

## Install

Download `Minis-Stream-Suite-Setup-<version>.exe` from [Releases](https://github.com/MinifyX/minis-stream-suite/releases) and run it. Settings live in `%APPDATA%\Mini's Stream Suite\` and survive updates and uninstalling.

As long as the installer is not code-signed, Windows SmartScreen shows a warning on first launch: "More info" → "Run anyway".

**First steps:** click "Mit Twitch verbinden" (connect with Twitch) on the overview page and confirm in your browser. No Twitch developer app is needed; the suite ships its own client ID (you can use your own under "Erweitert"). Then add `http://127.0.0.1:7474/addons/alerts/overlay.html` as a browser source in OBS and turn off Twitch's native alerts.

## Development

Requires [Node.js](https://nodejs.org) (LTS).

```bash
npm install
npm start          # run from source
npm run dist       # build the installer → release/
```

Set `SUITE_DATA_DIR` and `SUITE_PORT` to run a test instance next to your real one without touching its settings or logins.

The code is TypeScript (Electron main process) plus plain HTML/CSS/JS for the UI and overlays, with German comments. Each feature is an add-on in `src/addons/<id>/` with its UI in `public/addons/<id>/`; see "Ein neues Addon bauen" in the German README for the add-on API. **Plugins:** add-ons can also live outside the app in `%APPDATA%\Mini's Stream Suite\plugins\<name>\` (`index.js` exporting an add-on, optional `ui/` folder). They work with the official installed version and survive updates; they import core helpers from `@stream-suite/api`. Develop them in the git-ignored `src/addons/private/<name>/` and install with `npm run plugin:install -- <name>`. Plugins run with full app permissions, so only install trusted ones.

## License

Free software under the **GNU General Public License v3.0 or later** ([LICENSE](LICENSE)).

Not affiliated with or endorsed by Twitch.
