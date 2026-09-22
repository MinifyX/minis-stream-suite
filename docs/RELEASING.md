# Ein Release veröffentlichen

Releases baut GitHub automatisch (`.github/workflows/release.yml`). Installierte Suiten finden neue Versionen von selbst (`src/core/updater.ts`), sobald ein Release **veröffentlicht** ist.

## Ablauf

1. Version in `package.json` erhöhen (z.B. `0.4.0` → `0.5.0`) und committen.
2. Tag anlegen und hochladen:
   ```bash
   git tag v0.5.0
   git push origin main v0.5.0
   ```
3. GitHub baut den Installer (ca. 5–10 Minuten, Tab „Actions“) und legt unter **Releases** einen **Entwurf** an.
4. Entwurf öffnen, kurz beschreiben, was neu ist, dann **Publish release**. Erst jetzt bekommen alle das Update.

Der Workflow bricht ab, wenn Tag und Version in `package.json` nicht zusammenpassen.

> Automatische Updates funktionieren nur, wenn das Repo **öffentlich** ist (sonst kann die App die Releases nicht sehen).

## Private Addons

Der GitHub-Build enthält nur, was im Repo liegt. Private Addons (`src/addons/private/`) sind darin nicht enthalten. Wer sie braucht, baut sich den Installer lokal mit `npm run dist`. Achtung: Die lokal gebaute Version sucht ebenfalls auf GitHub nach Updates. Ein Update von dort enthält die privaten Addons nicht. Also nach jedem Update wieder lokal bauen, oder die Versionsnummer der eigenen Builds höher halten.

## Signieren (kostenlos über die SignPath Foundation)

Ohne Signatur warnt Windows SmartScreen beim ersten Start. Die [SignPath Foundation](https://signpath.org) signiert Open-Source-Projekte kostenlos. Voraussetzungen (Stand 2026, siehe [signpath.org/terms](https://signpath.org/terms)):

- OSI-Lizenz ✅ (GPL-3.0), öffentliches Repo, keine geschlossenen Teile
- Projekt ist schon veröffentlicht und wird gepflegt → **erst ein unsigniertes Release veröffentlichen**, dann beantragen
- Builds laufen automatisch und nachvollziehbar (GitHub Actions ✅)
- Produktname und Version stehen in den Dateien ✅ (macht electron-builder)
- **Zwei-Faktor-Anmeldung** bei GitHub und SignPath für alle im Team
- Eine **Code-Signing-Policy** auf der Projektseite → Vorlage: [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)

Schritte:

1. Repo öffentlich machen, erstes Release veröffentlichen.
2. Bei GitHub Zwei-Faktor-Anmeldung einschalten (falls noch nicht).
3. Auf [signpath.org](https://signpath.org) den Antrag stellen (Link „Apply“), Repo-URL und die Policy angeben.
4. Nach der Zusage bekommt man eine Organisation bei SignPath und einen API-Token. Token als GitHub-Secret `SIGNPATH_API_TOKEN` speichern.
5. Im Release-Workflow den Signier-Schritt ergänzen (`signpath/github-action-submit-signing-request`): Installer als Artefakt hochladen → SignPath signiert → signierte Datei ins Release. Die genaue Konfiguration gibt SignPath nach der Zusage vor.

Das kostet nichts, dauert aber je nach Warteschlange ein paar Wochen.
