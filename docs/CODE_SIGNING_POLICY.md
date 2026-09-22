# Code signing policy

*Draft – becomes active once the project is accepted by the SignPath Foundation.*

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

## Team roles

- **Committers and reviewers:** [MinifyX](https://github.com/MinifyX)
- **Approvers:** [MinifyX](https://github.com/MinifyX)

Only binaries built by the public GitHub Actions workflow (`.github/workflows/release.yml`) from this repository's source code are signed. Every signing request is approved manually by an approver.

## Privacy policy

This program will not transfer any information to other networked systems unless specifically requested by the user or the person installing or operating it.

What the app talks to, and why:

- **Twitch** (`api.twitch.tv`, `id.twitch.tv`, `eventsub.wss.twitch.tv`, `static-cdn.jtvnw.net`): login, receiving stream events, sending chat messages and loading badges/emotes – only after the user connects their Twitch account.
- **Emote services** (7TV, BetterTTV, FrankerFaceZ): loading public emotes for the user's channel, if enabled in the chat overlay settings.
- **Google Fonts** (`fonts.googleapis.com`): only when the user picks a web font for an alert or the chat overlay.
- **GitHub** (`github.com`): checking for and downloading updates of the app.

The optional browser extension (`browser-extension/`) additionally connects to Twitch chat (`irc-ws.chat.twitch.tv`, read-only, anonymous) and `api.ivr.fi` for channel badges.

Tokens are stored encrypted on the user's PC (Windows DPAPI). There is no telemetry and no analytics. All settings stay in `%APPDATA%\Mini's Stream Suite\`. The app can be removed via Windows "Apps & features"; the settings folder can then be deleted by hand.
