import { shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Addon, AddonContext } from '../../core/addons';
import { HttpError } from '../../core/server';
import { MUSIC_SERVICE, type MusicService } from '../music/service';
import { OBS_SERVICE, type ObsService } from '../obs';
import {
  DEFAULTS,
  SEGMENT_IDS,
  WEBHOOK_STATES,
  isCommand,
  mergeSettings,
  type IntroCommand,
  type IntroState,
  type Settings,
  type WebhookState,
} from './model';

/**
 * Intro-Sequenz: Video + Beat als OBS-Browserquelle (player.html), mit taktgenauen Loops.
 *
 * Die State Machine läuft im Player (nur dort gibt es die sample-genaue Audio-Uhr, siehe
 * public/addons/intro/sequencer.js). Dieses Addon
 *  - leitet Befehle (Oberfläche, Streamdeck) an den Player weiter (WebSocket-Kanal intro.player),
 *  - verteilt die Zustandsmeldungen des Players an alle Seiten (Kanal intro),
 *  - führt am Ende die DONE-Aktionen aus: OBS-Szene, Musik, Webhooks.
 */

type LogLevel = 'info' | 'warn' | 'error';

interface LogEntry {
  level: LogLevel;
  message: string;
  ts: number;
}

interface PlayerStatus {
  connected: number;
  ready: boolean;
  /** Vorladen: geladene / alle Dateien */
  loaded: number;
  total: number;
  error: string | null;
  /** Start wurde vor „ready“ gedrückt und wartet */
  startQueued: boolean;
}

interface StateReport {
  state: IntroState;
  pendingTrigger: 'go' | 'outro' | null;
  segment: string | null;
  nextBoundaryInMs: number | null;
  /** Wann der Bericht ankam (damit die Seiten den Countdown selbst weiterzählen können) */
  at: number;
}

interface Ack {
  resolve: (result: { ok: boolean; error?: string; queued?: boolean }) => void;
  timer: NodeJS.Timeout;
}

const MAX_LOG = 50;
const ACK_TIMEOUT = 2000;
const WEBHOOK_TIMEOUT = 3000;
/** Zweite DONE-Meldung (z.B. von einem zweiten Player) innerhalb dieser Zeit ignorieren */
const DONE_DEBOUNCE = 5000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const introAddon: Addon = {
  id: 'intro',
  name: 'Intro-Sequenz',
  icon: '🎞️',
  version: '0.1.0',
  author: 'Mini',
  description: 'Mehrteiliges Intro (Video + Beat) als OBS-Browserquelle mit taktgenauen Loops, Go/Outro per Klick oder Streamdeck. Danach automatisch Szenenwechsel und Musik.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);
    const log: LogEntry[] = [];
    const acks = new Map<number, Ack>();
    let nextAck = 1;
    let lastDone = 0;

    let player: PlayerStatus = { connected: 0, ready: false, loaded: 0, total: 0, error: null, startQueued: false };
    let report: StateReport = { state: 'IDLE', pendingTrigger: null, segment: null, nextBoundaryInMs: null, at: Date.now() };

    // -------------------------------------------------------- Medienordner

    const defaultMediaDir = path.join(ctx.dataDir, 'media');
    fs.mkdirSync(defaultMediaDir, { recursive: true });
    const mediaDir = () => settings.get('mediaDir') || defaultMediaDir;
    let mediaUrl = ctx.serveFolder('media', mediaDir());

    /** Welche Segment-Dateien fehlen im Medienordner? */
    const missingFiles = (): string[] => {
      const dir = mediaDir();
      const missing: string[] = [];
      for (const id of SEGMENT_IDS) {
        const seg = settings.get('segments')[id];
        for (const file of [seg.video, seg.audio]) if (file && !fs.existsSync(path.join(dir, file))) missing.push(file);
      }
      return missing;
    };

    // -------------------------------------------------------- Log & Senden an die Seiten

    const addLog = (level: LogLevel, message: string) => {
      const entry = { level, message, ts: Date.now() };
      log.push(entry);
      if (log.length > MAX_LOG) log.shift();
      ctx.log[level](message);
      ctx.overlay.broadcast({ type: 'system.log', ...entry });
    };

    const publicState = () => ({
      ...report,
      playerConnected: player.connected > 0,
      // Restzeit ab jetzt (die Seiten zählen mit `at` selbst weiter)
      nextBoundaryInMs: report.nextBoundaryInMs === null ? null : Math.max(0, report.nextBoundaryInMs - (Date.now() - report.at)),
    });

    const sendState = () => ctx.overlay.broadcast({ type: 'intro.state', ...publicState() });
    const sendPlayer = () => ctx.overlay.broadcast({ type: 'player.status', ...player });

    // -------------------------------------------------------- Webhooks

    const fireWebhooks = async (state: WebhookState): Promise<void> => {
      const urls = settings.get('webhooks')[state] ?? [];
      await Promise.all(urls.map(async (url) => {
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ state, ts: Date.now() }),
            signal: AbortSignal.timeout(WEBHOOK_TIMEOUT),
          });
          if (!res.ok) addLog('warn', `Webhook ${state} → ${url}: HTTP ${res.status}`);
        } catch (err) {
          const timeout = (err as Error).name === 'TimeoutError';
          addLog('warn', `Webhook ${state} → ${url}: ${timeout ? 'keine Antwort nach 3 s' : errorText(err)}`);
        }
      }));
    };

    // -------------------------------------------------------- DONE-Aktionen

    /** Reihenfolge: OBS-Szene → Musik → Webhooks. Fehler werden geloggt und blockieren nichts. */
    const runDoneActions = async (reason: 'completed' | 'aborted') => {
      const now = Date.now();
      if (now - lastDone < DONE_DEBOUNCE) return;
      lastDone = now;
      ctx.overlay.broadcast({ type: 'intro.done', reason });
      addLog('info', reason === 'aborted' ? 'Intro abgebrochen – führe die Abschluss-Aktionen aus.' : 'Intro fertig – führe die Abschluss-Aktionen aus.');
      const { onDone, obs } = settings.all();

      if (onDone.switchScene && obs.streamScene) {
        const service = ctx.use<ObsService>(OBS_SERVICE);
        try {
          if (!service) throw new Error('Das Addon „OBS-Steuerung“ ist aus. Bitte im Addon-Store einschalten und verbinden.');
          await service.setScene(obs.streamScene);
          addLog('info', `OBS: Szene „${obs.streamScene}“.`);
        } catch (err) {
          addLog('error', `OBS-Szenenwechsel fehlgeschlagen: ${errorText(err)}`);
        }
      }

      if (onDone.startMusic) {
        const music = ctx.use<MusicService>(MUSIC_SERVICE);
        try {
          if (!music) throw new Error('Das Addon „Musik“ ist aus.');
          await music.startAutoplay(onDone.musicFadeInMs);
          addLog('info', 'Musik gestartet.');
        } catch (err) {
          addLog('error', `Musik konnte nicht starten: ${errorText(err)}`);
        }
      }

      if (onDone.webhooks) await fireWebhooks('DONE');
    };

    // -------------------------------------------------------- Player (WebSocket intro.player)

    const playerConfig = () => {
      const segments = settings.get('segments');
      const url = (file: string) => `${mediaUrl}/${file.split('/').map(encodeURIComponent).join('/')}`;
      return {
        segments: Object.fromEntries(SEGMENT_IDS.map((id) => [id, {
          video: segments[id].video ? url(segments[id].video) : null,
          audio: url(segments[id].audio),
          overlayText: segments[id].overlayText,
        }])),
      };
    };

    ctx.overlay.listen('player', (event) => {
      if (event.type !== 'message') {
        player.connected = ctx.overlay.clients('player');
        if (!player.connected) {
          player.ready = false;
          player.startQueued = false;
          addLog('warn', 'Intro-Player getrennt.');
        } else if (event.type === 'open') {
          addLog('info', player.connected > 1
            ? `Intro-Player verbunden – Achtung: ${player.connected} Player offen, das Intro würde mehrfach laufen.`
            : 'Intro-Player verbunden.');
        }
        sendPlayer();
        sendState();
        return;
      }

      const msg = (event.data ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (msg.type) {
        case 'ack': {
          const ack = acks.get(Number(msg.id));
          if (!ack) return;
          acks.delete(Number(msg.id));
          clearTimeout(ack.timer);
          ack.resolve({ ok: msg.ok === true, error: msg.error ? String(msg.error) : undefined, queued: msg.queued === true });
          return;
        }
        case 'player.status': {
          const before = player.ready;
          player = {
            connected: ctx.overlay.clients('player'),
            ready: msg.ready === true,
            loaded: Number(msg.loaded) || 0,
            total: Number(msg.total) || 0,
            error: msg.error ? String(msg.error) : null,
            startQueued: msg.startQueued === true,
          };
          if (player.error) addLog('error', `Intro-Player: ${player.error}`);
          else if (player.ready && !before) addLog('info', 'Intro-Player ist bereit (alle Dateien geladen).');
          sendPlayer();
          return;
        }
        case 'intro.state': {
          const state = String(msg.state) as IntroState;
          const changed = state !== report.state;
          report = {
            state,
            pendingTrigger: msg.pendingTrigger === 'go' || msg.pendingTrigger === 'outro' ? msg.pendingTrigger : null,
            segment: msg.segment ? String(msg.segment) : null,
            nextBoundaryInMs: typeof msg.nextBoundaryInMs === 'number' ? msg.nextBoundaryInMs : null,
            at: Date.now(),
          };
          sendState();
          // DONE-Webhooks kommen erst als dritter Schritt der DONE-Aktionen
          if (changed && state !== 'DONE' && (WEBHOOK_STATES as readonly string[]).includes(state)) {
            void fireWebhooks(state as WebhookState);
          }
          return;
        }
        case 'intro.done':
          void runDoneActions(msg.reason === 'aborted' ? 'aborted' : 'completed');
          return;
        case 'config':
          ctx.overlay.broadcast({ type: 'intro.config', ...playerConfig() }, 'player');
          return;
      }
    });

    ctx.onDispose(() => {
      for (const ack of acks.values()) clearTimeout(ack.timer);
      acks.clear();
    });

    /** Befehl an den Player schicken und auf seine Antwort warten */
    const command = async (action: IntroCommand) => {
      if (!ctx.overlay.clients('player')) {
        throw new HttpError(409, 'Kein Intro-Player verbunden. Ist die Browserquelle in OBS aktiv (…/addons/intro/player.html)?');
      }
      const id = nextAck++;
      const result = await new Promise<{ ok: boolean; error?: string; queued?: boolean }>((resolve) => {
        const timer = setTimeout(() => {
          acks.delete(id);
          resolve({ ok: false, error: 'Der Intro-Player antwortet nicht.' });
        }, ACK_TIMEOUT);
        acks.set(id, { resolve, timer });
        ctx.overlay.broadcast({ type: 'intro.cmd', id, action }, 'player');
      });
      if (!result.ok) {
        const timeout = result.error === 'Der Intro-Player antwortet nicht.';
        throw new HttpError(timeout ? 504 : 409, result.error ?? 'Befehl abgelehnt.');
      }
      addLog('info', `Befehl „${action}“${result.queued ? ' (wartet, bis der Player alles geladen hat)' : ''}.`);

      // Beim Start optional auf die Intro-Szene schalten
      if (action === 'start' && settings.get('obs').introScene) {
        const scene = settings.get('obs').introScene;
        const service = ctx.use<ObsService>(OBS_SERVICE);
        if (!service) addLog('warn', 'Intro-Szene: Das Addon „OBS-Steuerung“ ist aus.');
        else service.setScene(scene).catch((err) => addLog('error', `OBS: Intro-Szene „${scene}“: ${errorText(err)}`));
      }
      // Nach einem Reset darf DONE sofort wieder auslösen
      if (action === 'reset') lastDone = 0;
      return { ok: true, queued: !!result.queued, state: publicState() };
    };

    // -------------------------------------------------------- API für die Oberfläche

    const fullState = () => ({
      intro: publicState(),
      player: { ...player },
      settings: settings.all(),
      defaultMediaDir,
      mediaDir: mediaDir(),
      missingFiles: missingFiles(),
      playerUrl: `${ctx.overlay.baseUrl}/player.html`,
      obsAvailable: !!ctx.use(OBS_SERVICE),
      musicAvailable: !!ctx.use(MUSIC_SERVICE),
      log: [...log].reverse(),
    });

    ctx.api.get('/state', () => fullState());

    ctx.api.post('/cmd', ({ body }) => {
      if (!isCommand(body?.action)) throw new HttpError(400, 'Unbekannter Befehl.');
      return command(body.action);
    });

    ctx.api.post('/settings', ({ body }) => {
      const before = mediaDir();
      const next = mergeSettings(settings.all(), body);
      if (next.mediaDir && !fs.existsSync(next.mediaDir)) throw new HttpError(400, `Den Ordner „${next.mediaDir}“ gibt es nicht.`);
      settings.update(next);
      if (mediaDir() !== before) mediaUrl = ctx.serveFolder('media', mediaDir());
      // Der Player lädt neu, wenn sich Dateien geändert haben (nur wenn gerade kein Intro läuft)
      ctx.overlay.broadcast({ type: 'intro.config', ...playerConfig() }, 'player');
      return fullState();
    });

    /** Player soll alle Dateien neu laden (z.B. nach dem Austauschen eines Videos) */
    ctx.api.post('/reload-player', () => {
      ctx.overlay.broadcast({ type: 'intro.reload' }, 'player');
      return fullState();
    });

    ctx.api.post('/open-media-folder', async () => {
      const error = await shell.openPath(mediaDir());
      if (error) throw new HttpError(500, error);
    });

    ctx.api.get('/player-config', () => playerConfig());

    ctx.api.get('/scenes', async () => {
      const service = ctx.use<ObsService>(OBS_SERVICE);
      if (!service || !service.isConnected()) return { connected: false, scenes: [] };
      return { connected: true, scenes: await service.listScenes() };
    });

    ctx.api.post('/test-webhook', async ({ body }) => {
      const state = String(body?.state) as WebhookState;
      if (!(WEBHOOK_STATES as readonly string[]).includes(state)) throw new HttpError(400, 'Unbekannter Zustand.');
      if (!settings.get('webhooks')[state].length) throw new HttpError(400, `Für ${state} ist kein Webhook eingetragen.`);
      await fireWebhooks(state);
      addLog('info', `Webhooks für ${state} getestet.`);
      return fullState();
    });

    ctx.api.post('/log/clear', () => {
      log.length = 0;
      return fullState();
    });

    // -------------------------------------------------------- Fernsteuerung (Streamdeck): /api/intro/…

    for (const action of ['start', 'go', 'outro', 'cancel-pending', 'abort', 'reset'] as const) {
      ctx.api.remote.post(`/${action}`, () => command(action));
    }
    ctx.api.remote.get('/state', () => publicState());
  },
};
