import { safeStorage, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Addon, AddonContext } from '../../core/addons';
import { ROLE_LEVEL, roleLevel } from '../../core/chat';
import { ConfigStore } from '../../core/config';
import { HttpError } from '../../core/server';
import { launchHost } from './hostBrowser';
import { localTrackId, scanLibrary, type LocalPlaylist, type LocalTrack } from './library';
import {
  DEFAULTS,
  PROVIDERS,
  PROVIDER_LABELS,
  clampVolume,
  cleanSource,
  fadeSteps,
  isProvider,
  mergeSettings,
  type MusicProvider,
  type NowPlaying,
  type ProviderId,
  type Settings,
} from './model';
import { PlaybackQueue, type Entry } from './playback';
import {
  REQUEST_DEFAULTS,
  checkLimits,
  fillTemplate,
  mergeRequestSettings,
  parseRequestCommand,
  requestMode,
  searchLocal,
  type RequestMessages,
  type SongRequest,
} from './requests';
import { MUSIC_SERVICE, type MusicService } from './service';
import { MAX_SETS, claimGames, cleanSet, setForGame, spotifyTrackId, type Game, type MusicSet, type QueueItem } from './sets';
import {
  SpotifyClient,
  SpotifyError,
  authorizeUrl,
  pickConnectDevice,
  parseSpotifySource,
  pkcePair,
  playBody,
  type SpotifyDevice,
  type SpotifyTokens,
} from './spotify';

/**
 * Musik-Player der Suite. Drei Provider hinter einem Interface (model.ts):
 *  - spotify-sdk:     Spotify Web Playback SDK im Music-Host → die Suite ist ein eigenes Connect-Gerät
 *  - spotify-connect: die normale Spotify-Desktop-App wird über die Web API ferngesteuert (Fallback)
 *  - local:           eigene Dateien aus einem Ordner, Wiedergabe im Music-Host mit Crossfade
 *
 * Der Music-Host (public/addons/music/host.html) läuft in einem eigenen Chrome/Edge-Fenster
 * (Widevine, siehe hostBrowser.ts) und ist über den WebSocket-Kanal music.host verbunden.
 * Seiten der Suite (Steuerseite, Overlay) hören auf den Kanal music bzw. music.overlay.
 */

type LogLevel = 'info' | 'warn' | 'error';
type SdkState = 'off' | 'connecting' | 'ready' | 'failed';

interface LogEntry {
  level: LogLevel;
  message: string;
  ts: number;
}

/** Was der Host über die lokale Wiedergabe meldet */
interface LocalStatus {
  isPlaying: boolean;
  trackId: string | null;
  positionMs: number;
  durationMs: number;
}

const MAX_LOG = 50;
/** So lange darf player.connect() im Host brauchen (Berichte über hängendes connect() seit Feb. 2026) */
const SDK_TIMEOUT_MS = 10_000;
const POLL_MS = 3000;
const LOGIN_TTL_MS = 10 * 60_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wird beim Deaktivieren aufgerufen (deactivate bekommt keinen ctx) */
let shutdown: (() => void) | null = null;

export const musicAddon: Addon = {
  id: 'music',
  name: 'Musik',
  icon: '🎵',
  version: '0.1.0',
  author: 'Mini',
  description: 'Musik-Player: Spotify (als eigenes Connect-Gerät oder Fernsteuerung der Desktop-App) und eigene Dateien mit Crossfade. Now-Playing-Overlay, Streamdeck-Steuerung, startet automatisch nach dem Intro.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);
    const log: LogEntry[] = [];

    const addLog = (level: LogLevel, message: string) => {
      const entry = { level, message, ts: Date.now() };
      log.push(entry);
      if (log.length > MAX_LOG) log.shift();
      ctx.log[level](message);
      ctx.overlay.broadcast({ type: 'system.log', ...entry });
    };

    // -------------------------------------------------------- Spotify-Login (Tokens verschlüsselt, nicht in Sicherungen)

    // Eigene Datei unter secrets/ – die Sicherung nimmt nur addons/*.json mit
    const secrets = new ConfigStore<{ tokens: string | null }>('secrets/music-spotify', { tokens: null });
    const tokenStore = {
      get(): SpotifyTokens | null {
        const stored = secrets.get('tokens');
        if (!stored) return null;
        try {
          if (stored.startsWith('enc:')) return JSON.parse(safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')));
          return JSON.parse(stored);
        } catch {
          return null;
        }
      },
      set(tokens: SpotifyTokens | null) {
        if (!tokens) return secrets.set('tokens', null);
        const json = JSON.stringify(tokens);
        secrets.set('tokens', safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(json).toString('base64')}` : json);
      },
    };

    const port = new URL(ctx.overlay.baseUrl).port;
    const redirectUri = () => `http://127.0.0.1:${port}/addons/music/callback.html`;
    const clientId = () => settings.get('spotify').clientId || process.env.SPOTIFY_CLIENT_ID || '';
    const spotify = new SpotifyClient({ clientId, redirectUri, store: tokenStore, log: ctx.log });
    /** Laufende Logins: state → PKCE-Verifier */
    const logins = new Map<string, { verifier: string; at: number }>();

    // -------------------------------------------------------- Zustand

    let hostClients = 0;
    let hostInfo: { audioUnlocked: boolean; browser: string } = { audioUnlocked: false, browser: '' };
    let sdkState: SdkState = 'off';
    let sdkDeviceId: string | null = null;
    let sdkError: string | null = null;
    let sdkTimer: NodeJS.Timeout | null = null;
    /** Aktuelle (ggf. gerade eingeblendete) Lautstärke – settings.volume ist das Ziel */
    let volume = settings.get('volume');
    /** Läuft ein Fade (Lautstärke-Rampe) – ein neuer bricht den alten ab */
    let fadeRun = 0;
    let fade: { from: number; to: number; start: number; ms: number } | null = null;
    /** Lautstärke jetzt gerade – während eines Fades geschätzt, damit „delta“ vom hörbaren Wert ausgeht */
    const currentVolume = () => {
      if (!fade) return volume;
      const k = Math.min(1, (Date.now() - fade.start) / fade.ms);
      return Math.round(fade.from + (fade.to - fade.from) * k);
    };
    let nowPlaying: NowPlaying | null = null;
    /** Wann nowPlaying gemeldet wurde (für die Restzeit) */
    let nowPlayingAt = 0;
    let lastBroadcastKey = '';

    // Lokale Bibliothek
    const coverDir = path.join(ctx.dataDir, 'covers');
    const coverUrl = `${ctx.dataUrl}/covers`;
    let libraryUrl = '';
    let library: LocalPlaylist[] = [];
    let localPlaylist: LocalPlaylist | null = null;
    let localStatus: LocalStatus = { isPlaying: false, trackId: null, positionMs: 0, durationMs: 0 };
    let trackIndex = new Map<string, LocalTrack>();

    const rescan = () => {
      const root = settings.get('local').rootDir;
      library = root ? scanLibrary(root, coverDir) : [];
      trackIndex = new Map(library.flatMap((p) => p.tracks).map((t) => [t.id, t]));
      libraryUrl = root && fs.existsSync(root) ? ctx.serveFolder('library', root) : '';
      return library;
    };
    try {
      rescan();
    } catch (err) {
      addLog('warn', `Musik-Ordner konnte nicht gelesen werden: ${errorText(err)}`);
    }

    // -------------------------------------------------------- Music-Host (WebSocket music.host)

    const toHost = (message: object) => ctx.overlay.broadcast(message, 'host');
    const hostConnected = () => hostClients > 0;

    /**
     * Vorübergehender Provider, ohne die Auswahl zu ändern – z.B. spielt eine eigene Liste gerade einen
     * lokalen Titel, obwohl Spotify ausgewählt ist. Wählt man selbst einen Provider, gilt wieder die Auswahl.
     */
    let override: ProviderId | null = null;

    /** Welcher Provider spielt wirklich? (SDK ausgefallen → Fernsteuerung der Desktop-App) */
    const effectiveProvider = (): ProviderId => {
      const chosen = override ?? settings.get('provider');
      if (chosen === 'spotify-sdk' && sdkState === 'failed') return 'spotify-connect';
      return chosen;
    };

    const startSdk = () => {
      if (!hostConnected() || !spotify.loggedIn || (override ?? settings.get('provider')) !== 'spotify-sdk') return;
      if (sdkState === 'connecting' || sdkState === 'ready') return;
      sdkState = 'connecting';
      sdkError = null;
      toHost({ type: 'sdk.init', deviceName: settings.get('spotify').deviceName, volume });
      if (sdkTimer) clearTimeout(sdkTimer);
      // Eigener Timeout zusätzlich zu dem im Host – falls der Host selbst hängt
      sdkTimer = setTimeout(() => {
        if (sdkState === 'connecting') sdkFailed(`Keine Antwort vom Web Playback SDK nach ${SDK_TIMEOUT_MS / 1000} s.`);
      }, SDK_TIMEOUT_MS + 2000);
      sendState();
    };

    const sdkFailed = (reason: string) => {
      if (sdkTimer) clearTimeout(sdkTimer);
      sdkTimer = null;
      sdkState = 'failed';
      sdkDeviceId = null;
      sdkError = reason;
      addLog('warn', `Spotify in der Suite geht gerade nicht (${reason}) – steuere stattdessen die Spotify-App fern.`);
      sendState();
      ensurePolling();
    };

    ctx.overlay.listen('host', (event) => {
      if (event.type !== 'message') {
        hostClients = ctx.overlay.clients('host');
        if (event.type === 'open') {
          addLog('info', hostClients > 1 ? `Music-Host verbunden – Achtung: ${hostClients} Fenster offen, bitte nur eins.` : 'Music-Host verbunden.');
        } else if (!hostClients) {
          addLog('warn', 'Music-Host getrennt.');
          if (sdkState !== 'off') {
            sdkState = 'off';
            sdkDeviceId = null;
          }
          localStatus = { ...localStatus, isPlaying: false };
          updateNowPlaying();
        }
        sendState();
        return;
      }
      const msg = (event.data ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      switch (msg.type) {
        case 'host.hello':
          hostInfo = { audioUnlocked: msg.audioUnlocked === true, browser: String(msg.browser ?? '') };
          // Lautstärke und (falls nötig) SDK einrichten
          toHost({ type: 'volume', engine: 'local', volume, fadeMs: 0 });
          if (settings.get('provider') === 'spotify-sdk') {
            sdkState = 'off';
            startSdk();
          }
          sendState();
          return;
        case 'host.audio':
          hostInfo.audioUnlocked = msg.unlocked === true;
          sendState();
          return;
        case 'sdk.ready':
          if (sdkTimer) clearTimeout(sdkTimer);
          sdkTimer = null;
          sdkState = 'ready';
          sdkDeviceId = String(msg.deviceId);
          sdkError = null;
          addLog('info', `Spotify-Gerät „${settings.get('spotify').deviceName}“ ist bereit.`);
          void takeOverIfIdle();
          sendState();
          return;
        case 'sdk.failed':
          sdkFailed(String(msg.error || 'unbekannter Fehler'));
          return;
        case 'sdk.state':
          if (effectiveProvider() !== 'spotify-sdk') return;
          nowPlaying = msg.track ? {
            title: String(msg.track.title),
            artists: Array.isArray(msg.track.artists) ? msg.track.artists.map(String) : [],
            album: msg.track.album ? String(msg.track.album) : undefined,
            coverUrl: msg.track.coverUrl ? String(msg.track.coverUrl) : undefined,
            durationMs: Number(msg.durationMs) || 0,
            positionMs: Number(msg.positionMs) || 0,
            isPlaying: msg.isPlaying === true,
            provider: 'spotify-sdk',
            trackId: String(msg.track.id ?? msg.track.title),
          } : null;
          nowPlayingAt = Date.now();
          broadcastNowPlaying(true);
          return;
        case 'local.status':
          localStatus = {
            isPlaying: msg.isPlaying === true,
            trackId: msg.trackId ? String(msg.trackId) : null,
            positionMs: Number(msg.positionMs) || 0,
            durationMs: Number(msg.durationMs) || 0,
          };
          if (effectiveProvider() === 'local') updateNowPlaying();
          return;
        case 'host.error':
          addLog('error', `Music-Host: ${String(msg.message)}`);
          return;
      }
    });

    /** Nach „ready“: Wiedergabe auf die Suite übertragen – aber nur, wenn nirgends etwas läuft */
    // ANNAHME: Der Plan verlangt die Übertragung direkt nach „ready“. Damit Musik auf dem Handy
    // nicht plötzlich umzieht, übertragen wir nur, wenn gerade nichts abgespielt wird.
    const takeOverIfIdle = async () => {
      try {
        const player = await spotify.request<{ is_playing?: boolean }>('GET', '/me/player');
        if (player?.is_playing) return;
        await spotify.request('PUT', '/me/player', { body: { device_ids: [sdkDeviceId], play: false } });
      } catch (err) {
        addLog('warn', `Wiedergabe konnte nicht auf die Suite übertragen werden: ${errorText(err)}`);
      }
    };

    // -------------------------------------------------------- Now Playing & Events

    const localTrack = (id: string | null): LocalTrack | null => (id ? trackIndex.get(id) ?? null : null);

    const updateNowPlaying = () => {
      const track = localTrack(localStatus.trackId);
      nowPlaying = track ? {
        title: track.title,
        artists: track.artists,
        album: track.album ?? undefined,
        coverUrl: track.cover ? `${coverUrl}/${track.cover}` : undefined,
        durationMs: localStatus.durationMs,
        positionMs: localStatus.positionMs,
        isPlaying: localStatus.isPlaying,
        provider: 'local',
        trackId: track.id,
      } : null;
      nowPlayingAt = Date.now();
      broadcastNowPlaying(true);
    };

    const publicNowPlaying = () => (nowPlaying ? { ...nowPlaying, requestedBy: requestedByNow(), at: Date.now() } : null);

    /** force = auch ohne Titelwechsel schicken (Position aktualisieren) */
    const broadcastNowPlaying = (force = false) => {
      const key = nowPlaying ? `${nowPlaying.trackId}|${nowPlaying.isPlaying}` : '';
      if (!force && key === lastBroadcastKey) return;
      lastBroadcastKey = key;
      const data = { type: 'music.nowPlaying', nowPlaying: publicNowPlaying() };
      ctx.overlay.broadcast(data);
      ctx.overlay.broadcast(data, 'overlay');
    };

    const providerList = () => PROVIDERS.map((id) => ({ id, label: PROVIDER_LABELS[id], reason: providers[id].unavailableReason() }));

    const publicState = () => ({
      provider: effectiveProvider(),
      chosenProvider: settings.get('provider'),
      fallback: settings.get('provider') === 'spotify-sdk' && sdkState === 'failed',
      isPlaying: !!nowPlaying?.isPlaying,
      volume: currentVolume(),
      targetVolume: settings.get('volume'),
    });

    const sendState = () => {
      ctx.overlay.broadcast({ type: 'music.state', ...publicState() });
      ctx.overlay.broadcast({ type: 'music.state', ...publicState() }, 'overlay');
    };

    // -------------------------------------------------------- Polling (nur Fernsteuerung der Desktop-App)

    let pollTimer: NodeJS.Timeout | null = null;
    /**
     * Nur solange jemand zuschaut (Steuerseite oder Overlay) – oder die Queue Bescheid wissen muss,
     * wann ein Titel endet (Songwünsche, eigene Liste)
     */
    const anyoneWatching = () => ctx.overlay.clients() + ctx.overlay.clients('overlay') > 0
      || queue.requests.length > 0 || !!queue.list || !!queue.committed;

    /** Addon ist aus – verzögerte Abfragen dürfen nichts mehr tun */
    let stopped = false;

    const pollConnect = async () => {
      if (stopped) return;
      try {
        const res = await spotify.request<any>('GET', '/me/player/currently-playing', { query: { additional_types: 'episode' } }); // eslint-disable-line @typescript-eslint/no-explicit-any
        const item = res?.item;
        nowPlaying = item ? {
          title: String(item.name),
          artists: (item.artists ?? []).map((a: { name: string }) => a.name),
          album: item.album?.name,
          coverUrl: item.album?.images?.[0]?.url ?? item.images?.[0]?.url,
          durationMs: Number(item.duration_ms) || 0,
          positionMs: Number(res.progress_ms) || 0,
          isPlaying: res.is_playing === true,
          provider: 'spotify-connect',
          trackId: String(item.id ?? item.uri ?? item.name),
        } : null;
        nowPlayingAt = Date.now();
        broadcastNowPlaying(true);
      } catch (err) {
        if (err instanceof SpotifyError && err.status === 401) return;
        ctx.log.warn('Now Playing (Spotify):', err);
      }
    };

    const ensurePolling = () => {
      const wanted = effectiveProvider() === 'spotify-connect' && spotify.loggedIn && anyoneWatching();
      if (wanted && !pollTimer) {
        pollTimer = setInterval(() => {
          if (effectiveProvider() !== 'spotify-connect' || !anyoneWatching()) return ensurePolling();
          void pollConnect();
        }, POLL_MS);
        void pollConnect();
      } else if (!wanted && pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    // Seiten verbinden sich → evtl. Polling starten
    const onViewer = (event: { type: string }) => {
      if (event.type !== 'message') ensurePolling();
    };
    ctx.overlay.listen(undefined, onViewer);
    ctx.overlay.listen('overlay', onViewer);

    // -------------------------------------------------------- Provider

    const needSpotify = (): string | null => {
      if (!clientId()) return 'Keine Spotify Client-ID eingetragen.';
      if (!spotify.loggedIn) return 'Nicht mit Spotify verbunden.';
      return null;
    };

    const fail = (status: number, message: string): never => {
      throw new HttpError(status, message);
    };

    /** Spotify-Fehler als HTTP-Fehler weitergeben */
    const spotifyCall = async <T>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (err) {
        if (err instanceof HttpError) throw err;
        if (err instanceof SpotifyError) throw new HttpError(err.status === 429 || err.status >= 500 ? 503 : 409, err.message);
        throw new HttpError(503, `Spotify nicht erreichbar: ${errorText(err)}`);
      }
    };

    const local: MusicProvider = {
      id: 'local',
      unavailableReason() {
        const root = settings.get('local').rootDir;
        if (!root) return 'Kein Musik-Ordner eingestellt.';
        if (!fs.existsSync(root)) return `Den Musik-Ordner „${root}“ gibt es nicht.`;
        if (!hostConnected()) return 'Der Music-Host ist nicht offen.';
        return null;
      },
      async play(source) {
        const reason = this.unavailableReason();
        if (reason) fail(503, reason);
        if (!source) return this.resume();
        const id = source.replace(/^local:/, '');
        const playlist = library.find((p) => p.id === id) ?? rescan().find((p) => p.id === id);
        if (!playlist) fail(404, `Die lokale Playlist „${id || 'Hauptordner'}“ gibt es nicht (mehr).`);
        localPlaylist = playlist!;
        toHost({
          type: 'local.load',
          tracks: playlist!.tracks.map((t) => ({ id: t.id, url: `${libraryUrl}/${t.file.split('/').map(encodeURIComponent).join('/')}` })),
          shuffle: settings.get('shuffle'),
          repeat: settings.get('repeat'),
          crossfadeMs: settings.get('local').crossfadeMs,
        });
      },
      async pause() {
        toHost({ type: 'local.cmd', action: 'pause' });
      },
      async resume() {
        if (!localPlaylist) {
          const first = settings.get('autoStartSource').startsWith('local:') ? settings.get('autoStartSource') : library[0] ? `local:${library[0].id}` : '';
          if (!first) fail(409, 'Im Musik-Ordner ist keine Musik.');
          return this.play(first);
        }
        toHost({ type: 'local.cmd', action: 'resume' });
      },
      async next() {
        toHost({ type: 'local.cmd', action: 'next' });
      },
      async previous() {
        toHost({ type: 'local.cmd', action: 'previous' });
      },
      async setVolume(v) {
        toHost({ type: 'volume', engine: 'local', volume: v, fadeMs: 0 });
      },
      async fadeTo(v, ms) {
        toHost({ type: 'volume', engine: 'local', volume: v, fadeMs: ms });
        await sleep(ms);
      },
      async getNowPlaying() {
        return nowPlaying?.provider === 'local' ? nowPlaying : null;
      },
    };

    /** Wirft 503 mit Grund, wenn das SDK-Gerät gerade nicht bedienbar ist */
    const sdkReady = () => {
      const reason = sdk.unavailableReason();
      if (reason) fail(503, reason);
    };

    const sdk: MusicProvider = {
      id: 'spotify-sdk',
      unavailableReason() {
        const s = needSpotify();
        if (s) return s;
        if (!hostConnected()) return 'Der Music-Host ist nicht offen.';
        if (sdkState === 'failed') return `Web Playback SDK geht nicht: ${sdkError ?? 'unbekannt'}`;
        if (sdkState !== 'ready') return 'Das Spotify-Gerät der Suite startet noch.';
        return null;
      },
      async play(source) {
        const reason = this.unavailableReason();
        if (reason) fail(503, reason);
        if (!source) return this.resume();
        await spotifyCall(async () => {
          await applySpotifyModes(sdkDeviceId!);
          await spotify.request('PUT', '/me/player/play', { query: { device_id: sdkDeviceId! }, body: playBody(source) });
        });
      },
      async pause() {
        sdkReady();
        toHost({ type: 'sdk.cmd', action: 'pause' });
      },
      async resume() {
        sdkReady();
        // Ist die Suite gerade nicht das aktive Gerät, holt „play“ mit device_id die Wiedergabe her
        await spotifyCall(() => spotify.request('PUT', '/me/player/play', { query: { device_id: sdkDeviceId! } }));
      },
      async next() {
        sdkReady();
        toHost({ type: 'sdk.cmd', action: 'next' });
      },
      async previous() {
        sdkReady();
        toHost({ type: 'sdk.cmd', action: 'previous' });
      },
      async setVolume(v) {
        toHost({ type: 'volume', engine: 'sdk', volume: v, fadeMs: 0 });
      },
      async fadeTo(v, ms) {
        toHost({ type: 'volume', engine: 'sdk', volume: v, fadeMs: ms });
        await sleep(ms);
      },
      async getNowPlaying() {
        return nowPlaying?.provider === 'spotify-sdk' ? nowPlaying : null;
      },
    };

    /** Gerät der Desktop-App suchen – mit verständlicher Meldung, wenn es fehlt */
    const connectDevice = async (): Promise<SpotifyDevice> => {
      const res = await spotifyCall(() => spotify.request<{ devices: SpotifyDevice[] }>('GET', '/me/player/devices'));
      const { connectDeviceName, deviceName } = settings.get('spotify');
      const found = pickConnectDevice(res?.devices ?? [], connectDeviceName, deviceName);
      if (!found) {
        fail(503, connectDeviceName
          ? `Spotify-Gerät „${connectDeviceName}“ nicht gefunden. Spotify-App öffnen (und einmal kurz etwas abspielen).`
          : 'Keine Spotify-App gefunden. Spotify-App öffnen (und einmal kurz etwas abspielen).');
      }
      return found!;
    };

    const applySpotifyModes = async (deviceId: string) => {
      await spotify.request('PUT', '/me/player/shuffle', { query: { state: String(settings.get('shuffle')), device_id: deviceId } }).catch(() => undefined);
      await spotify.request('PUT', '/me/player/repeat', { query: { state: settings.get('repeat') ? 'context' : 'off', device_id: deviceId } }).catch(() => undefined);
    };

    const connect: MusicProvider = {
      id: 'spotify-connect',
      unavailableReason: () => needSpotify(),
      async play(source) {
        const reason = this.unavailableReason();
        if (reason) fail(503, reason);
        const device = await connectDevice();
        await spotifyCall(async () => {
          if (source) await applySpotifyModes(device.id!);
          await spotify.request('PUT', '/me/player/play', { query: { device_id: device.id! }, body: source ? playBody(source) : undefined });
        });
        setTimeout(() => void pollConnect(), 800);
      },
      async pause() {
        await spotifyCall(() => spotify.request('PUT', '/me/player/pause'));
        setTimeout(() => void pollConnect(), 500);
      },
      async resume() {
        return this.play();
      },
      async next() {
        await spotifyCall(() => spotify.request('POST', '/me/player/next'));
        setTimeout(() => void pollConnect(), 800);
      },
      async previous() {
        await spotifyCall(() => spotify.request('POST', '/me/player/previous'));
        setTimeout(() => void pollConnect(), 800);
      },
      async setVolume(v) {
        const device = await connectDevice();
        await spotifyCall(() => spotify.request('PUT', '/me/player/volume', { query: { volume_percent: String(v), device_id: device.id! } }));
      },
      async fadeTo(v, ms) {
        // Grob in 6 Stufen, damit Spotify uns nicht bremst (429 → Retry-After im Client)
        const device = await connectDevice();
        const run = fadeRun;
        let last = 0;
        for (const step of fadeSteps(volume, v, ms)) {
          await sleep(step.atMs - last);
          last = step.atMs;
          if (run !== fadeRun) return;
          await spotifyCall(() => spotify.request('PUT', '/me/player/volume', { query: { volume_percent: String(step.volume), device_id: device.id! } }));
        }
      },
      async getNowPlaying() {
        await pollConnect();
        return nowPlaying?.provider === 'spotify-connect' ? nowPlaying : null;
      },
    };

    const providers: Record<ProviderId, MusicProvider> = { 'spotify-sdk': sdk, 'spotify-connect': connect, local };
    const active = () => providers[effectiveProvider()];

    // -------------------------------------------------------- MusicManager-Aktionen

    /** Welcher Provider spielt eine Quelle? local:… → lokal, Spotify → der gewählte Spotify-Weg */
    const providerFor = (source: string | undefined): MusicProvider => {
      if (!source) return active();
      if (source.startsWith('local:')) return local;
      const current = effectiveProvider();
      if (current !== 'local') return providers[current];
      return sdkState === 'ready' ? sdk : connect;
    };

    /** Provider wechseln: der alte hört auf zu spielen */
    const switchTo = async (id: ProviderId, persist: boolean) => {
      const before = effectiveProvider();
      if (persist) {
        settings.set('provider', id);
        override = null;
      } else {
        override = id === settings.get('provider') ? null : id;
      }
      if (id === 'spotify-sdk' && sdkState === 'failed') {
        // Neuer Versuch, wenn man ausdrücklich wieder „in der Suite“ wählt
        sdkState = 'off';
      }
      const after = id === 'spotify-sdk' && sdkState === 'failed' ? 'spotify-connect' : id;
      if (before !== after) {
        await providers[before].pause().catch(() => undefined);
        toHost({ type: 'engine', engine: after === 'local' ? 'local' : after === 'spotify-sdk' ? 'sdk' : null });
        nowPlaying = null;
        broadcastNowPlaying(true);
        // Der neue Provider soll gleich laut sein wie der alte
        await providers[after].setVolume(currentVolume()).catch(() => undefined);
      }
      if (id === 'spotify-sdk') startSdk();
      ensurePolling();
      sendState();
    };

    const play = async (rawSource?: string) => {
      const source = rawSource ? cleanSource(rawSource) : undefined;
      if (source?.startsWith('set:') || source === 'game') return playSet(resolveSet(source));
      // Eine normale Quelle ersetzt eine laufende eigene Liste (Wünsche bleiben)
      if (source) {
        queue.clearList();
        activeSetId = '';
      }
      const provider = providerFor(source);
      if (provider.id !== effectiveProvider()) await switchTo(provider.id, provider.id !== 'spotify-connect' || settings.get('provider') !== 'spotify-sdk');
      fadeRun++;
      await provider.play(source);
      if (source) addLog('info', `Spiele ${describeSource(source)}.`);
    };

    const describeSource = (source: string) => {
      if (source.startsWith('local:')) return `lokale Playlist „${source.slice(6) || 'Hauptordner'}“`;
      if (source === 'game') return 'Set passend zum Spiel';
      if (source.startsWith('set:')) return `Musik-Set „${findSet(source.slice(4))?.name ?? source.slice(4)}“`;
      return source;
    };

    const setVolume = async (v: number, remember = true) => {
      fadeRun++;
      fade = null;
      volume = clampVolume(v);
      if (remember) settings.set('volume', volume);
      await active().setVolume(volume);
      sendState();
    };

    const fadeTo = async (v: number, ms: number) => {
      const run = ++fadeRun;
      const target = clampVolume(v);
      fade = ms > 0 ? { from: volume, to: target, start: Date.now(), ms } : null;
      await active().fadeTo(target, ms);
      // Abgelöst (z.B. Lautstärke während des Einblendens von Hand geändert) → nichts überschreiben
      if (run !== fadeRun) return;
      fade = null;
      volume = target;
      sendState();
    };

    const command = async (action: string) => {
      const provider = active();
      switch (action) {
        case 'play':
          return play();
        case 'pause':
          return provider.pause();
        case 'toggle':
          return nowPlaying?.isPlaying ? provider.pause() : (provider === local && !localPlaylist ? local.resume() : provider.resume());
        case 'next': {
          // Wünsche/eigene Liste: die Queue weiß, was als Nächstes kommt
          const result = await queue.skip();
          if (result !== 'queue') await provider.next();
          return;
        }
        case 'previous':
          return provider.previous();
        default:
          throw new HttpError(400, 'Unbekannter Befehl.');
      }
    };

    // -------------------------------------------------------- Wiedergabe-Queue (Wünsche, eigene Listen)

    const itemTrackId = (item: QueueItem) => (item.kind === 'spotify' ? (spotifyTrackId(item.ref) ?? item.ref) : localTrackId(item.ref));
    const localUrl = (file: string) => `${libraryUrl}/${file.split('/').map(encodeURIComponent).join('/')}`;

    /** Spotify-Weg für einzelne Titel: SDK, wenn bereit, sonst die Desktop-App */
    const spotifyProvider = (): MusicProvider => (sdkState === 'ready' && settings.get('provider') === 'spotify-sdk' ? sdk : connect);

    /** Gerät, auf dem Spotify gerade spielen soll */
    const spotifyDeviceId = async (): Promise<string> => {
      if (spotifyProvider() === sdk) return sdkDeviceId!;
      return (await connectDevice()).id!;
    };

    /** Einen einzelnen Titel sofort starten (Listen der Suite, Wünsche bei Provider-Wechsel) */
    const playItemNow = async (item: QueueItem) => {
      if (item.kind === 'local') {
        const reason = local.unavailableReason();
        if (reason) fail(503, reason);
        if (effectiveProvider() !== 'local') await switchTo('local', false);
        toHost({ type: 'local.load', tracks: [{ id: localTrackId(item.ref), url: localUrl(item.ref) }], shuffle: false, repeat: false, crossfadeMs: settings.get('local').crossfadeMs });
        return;
      }
      const provider = spotifyProvider();
      const reason = provider.unavailableReason();
      if (reason) fail(503, reason);
      if (effectiveProvider() !== provider.id) await switchTo(provider.id, false);
      const deviceId = await spotifyDeviceId();
      await spotifyCall(async () => {
        // Einzelner Titel: nicht wiederholen, sonst läuft er endlos
        await spotify.request('PUT', '/me/player/repeat', { query: { state: 'off', device_id: deviceId } }).catch(() => undefined);
        await spotify.request('PUT', '/me/player/play', { query: { device_id: deviceId }, body: { uris: [item.ref] } });
      });
      if (provider === connect) setTimeout(() => void pollConnect(), 800);
    };

    /** Titel beim gerade spielenden Provider als nächsten einreihen (false = anderer Provider) */
    const enqueueItem = async (item: QueueItem): Promise<boolean> => {
      const current = effectiveProvider();
      if (item.kind === 'local') {
        if (current !== 'local' || !hostConnected()) return false;
        toHost({ type: 'local.next', track: { id: localTrackId(item.ref), url: localUrl(item.ref) } });
        return true;
      }
      if (current === 'local') return false;
      const deviceId = await spotifyDeviceId();
      await spotifyCall(() => spotify.request('POST', '/me/player/queue', { query: { uri: item.ref, device_id: deviceId } }));
      return true;
    };

    const queue = new PlaybackQueue({
      now: () => Date.now(),
      state: () => (nowPlaying ? { ...nowPlaying, at: nowPlayingAt } : null),
      // Lokal muss der nächste Titel nur vor dem Crossfade feststehen; Spotify braucht etwas Vorlauf
      prequeueMs: () => (effectiveProvider() === 'local' ? settings.get('local').crossfadeMs + 3000 : 15_000),
      trackId: itemTrackId,
      playNow: playItemNow,
      enqueueNext: enqueueItem,
      started: (entry) => onEntryStarted(entry),
      changed: () => syncRequests(),
      error: (message) => addLog('warn', message),
    });
    const queueTimer = setInterval(() => void queue.tick(), 500);

    // -------------------------------------------------------- Musik-Sets & Spielwechsel

    let currentGame: Game | null = null;
    let activeSetId = '';

    const loadGame = async () => {
      const user = ctx.getUser();
      if (!user) return;
      const res = await ctx.twitch.request<{ data: { game_id: string; game_name: string }[] }>('GET', '/channels', { query: { broadcaster_id: user.id } });
      const info = res.data[0];
      currentGame = info?.game_id ? { id: info.game_id, name: info.game_name } : null;
    };
    loadGame().catch(() => undefined);

    const findSet = (idOrName: string): MusicSet | null => {
      const sets = settings.get('sets');
      const key = idOrName.trim().toLowerCase();
      return sets.find((s) => s.id === idOrName) ?? sets.find((s) => s.name.toLowerCase() === key) ?? null;
    };

    /** Ein Set abspielen: verknüpft → Provider spielt die Quelle, eigene Liste → die Queue spielt Titel für Titel */
    const playSet = async (set: MusicSet) => {
      if (set.type === 'custom') {
        await queue.startList(set.name, set.tracks, { shuffle: settings.get('shuffle'), repeat: settings.get('repeat') });
      } else {
        await play(set.source);
      }
      activeSetId = set.id;
      addLog('info', `Musik-Set „${set.name}“.`);
      sendSets();
    };

    /** Weich auf ein anderes Set wechseln: aus- und wieder einblenden */
    const crossToSet = async (set: MusicSet, reason: string) => {
      const target = settings.get('volume');
      await fadeTo(0, 1500).catch(() => undefined);
      try {
        await playSet(set);
        addLog('info', `${reason} → Musik-Set „${set.name}“.`);
      } finally {
        await fadeTo(target, 2500).catch(() => undefined);
      }
    };

    ctx.events.on('channelupdate', async (event) => {
      const game = event.categoryId ? { id: event.categoryId, name: event.categoryName } : null;
      const changed = game?.id !== currentGame?.id;
      currentGame = game;
      sendSets();
      if (!changed || !settings.get('switchOnGameChange') || !nowPlaying?.isPlaying) return;
      const set = setForGame({ sets: settings.get('sets'), defaultSetId: settings.get('defaultSetId'), switchOnGameChange: true }, game);
      if (!set || set.id === activeSetId) return;
      await crossToSet(set, `${event.test ? '[Test] ' : ''}Spiel: ${game?.name ?? 'keine Kategorie'}`)
        .catch((err) => addLog('error', `Set-Wechsel fehlgeschlagen: ${errorText(err)}`));
    });

    /** set:<id> oder „game“ → Set (oder Fehler) */
    const resolveSet = (source: string): MusicSet => {
      if (source === 'game') {
        const set = setForGame({ sets: settings.get('sets'), defaultSetId: settings.get('defaultSetId'), switchOnGameChange: true }, currentGame);
        if (!set) throw new HttpError(409, `Für ${currentGame ? `„${currentGame.name}“` : 'die aktuelle Kategorie'} gibt es kein Set und kein Standard-Set.`);
        return set;
      }
      const set = findSet(source.slice(4));
      if (!set) throw new HttpError(404, 'Dieses Musik-Set gibt es nicht (mehr).');
      return set;
    };

    const setsState = () => ({
      sets: settings.get('sets'),
      defaultSetId: settings.get('defaultSetId'),
      switchOnGameChange: settings.get('switchOnGameChange'),
      currentGame,
      activeSetId,
      gameSet: setForGame({ sets: settings.get('sets'), defaultSetId: settings.get('defaultSetId'), switchOnGameChange: true }, currentGame)?.id ?? null,
    });
    const sendSets = () => ctx.overlay.broadcast({ type: 'music.sets', ...setsState() });

    // -------------------------------------------------------- Songwünsche

    /** Offene Wünsche (Vorschlag, Queue, läuft gerade) */
    let openRequests: SongRequest[] = [];
    const history: SongRequest[] = [];
    const lastRequestAt = new Map<string, number>();

    const requestSettings = () => settings.get('requests');
    const message = (key: keyof RequestMessages) => requestSettings().messages[key] ?? REQUEST_DEFAULTS.messages[key];

    const reply = (key: keyof RequestMessages, values: Record<string, string | number>, replyTo?: string, test = false) => {
      if (!requestSettings().reply) return;
      const text = fillTemplate(message(key), values);
      if (test) {
        addLog('info', `[Test] Chat-Antwort: ${text}`);
        return;
      }
      ctx.chat.send(text, replyTo).catch((err) => addLog('warn', `Chat-Antwort ging nicht raus: ${errorText(err)}`));
    };

    const toHistory = (request: SongRequest, status: SongRequest['status']) => {
      request.status = status;
      openRequests = openRequests.filter((r) => r !== request);
      history.unshift(request);
      if (history.length > 50) history.pop();
    };

    /** Kanalpunkte: Einlösung erledigen oder Punkte zurückgeben (geht nur bei der Belohnung der Suite) */
    const setRedemption = async (request: SongRequest, status: 'FULFILLED' | 'CANCELED') => {
      const red = request.redemption;
      const user = ctx.getUser();
      if (!red || !user || red.id.startsWith('test-')) return;
      try {
        await ctx.twitch.request('PATCH', '/channel_points/custom_rewards/redemptions', {
          query: { broadcaster_id: user.id, reward_id: red.rewardId, id: red.id },
          body: { status },
        });
      } catch (err) {
        if (!/404/.test(errorText(err))) addLog('warn', `Kanalpunkte (${status === 'CANCELED' ? 'zurückgeben' : 'erledigen'}): ${errorText(err)}`);
      }
    };

    const itemValues = (request: SongRequest) => ({
      user: request.user.name,
      title: request.item.title,
      artist: request.item.artists.join(', ') || 'unbekannt',
    });

    const requestsState = () => ({
      open: openRequests.map((r) => ({ ...r, position: r.status === 'queued' ? queue.position(r.id) : 0, locked: queue.committed?.entry.request?.id === r.id && queue.committed.mode === 'enqueued' })),
      history,
      upcoming: queue.upcoming().map((e) => ({ item: e.item, requestId: e.request?.id ?? null, user: e.request?.user.name ?? null })),
      list: queue.list ? { name: queue.list.name, count: queue.list.items.length, pos: queue.list.pos } : null,
      settings: requestSettings(),
    });
    const sendRequests = () => ctx.overlay.broadcast({ type: 'music.requests', ...requestsState() });

    /** Laufender Wunsch fertig → Verlauf; Now Playing bekommt „gewünscht von“ */
    const syncRequests = () => {
      ensurePolling();
      for (const r of [...openRequests]) {
        if (r.status === 'playing' && queue.current?.request?.id !== r.id) toHistory(r, 'played');
      }
      broadcastNowPlaying(true);
      sendRequests();
    };

    const onEntryStarted = (entry: Entry) => {
      if (entry.request) {
        entry.request.status = 'playing';
        void setRedemption(entry.request, 'FULFILLED');
        addLog('info', `Songwunsch von ${entry.request.user.name}: „${entry.item.title}“.`);
      }
      syncRequests();
    };

    /** Was als Nächstes kommt, als kurze Liste für den Chat */
    const upcomingText = () => queue.upcoming().slice(0, 3)
      .map((e, i) => `${i + 1}. ${e.item.title}${e.item.artists.length ? ` – ${e.item.artists[0]}` : ''}${e.request ? ` (@${e.request.user.name})` : ''}`)
      .join(' | ');

    type SpotifyTrack = { uri: string; name: string; duration_ms: number; explicit?: boolean; artists: { name: string }[]; album?: { images?: { url: string }[] } };
    const fromSpotify = (t: SpotifyTrack): QueueItem & { explicit: boolean } => ({
      kind: 'spotify',
      ref: t.uri,
      title: t.name,
      artists: t.artists.map((a) => a.name),
      durationMs: t.duration_ms,
      image: t.album?.images?.at(-1)?.url ?? t.album?.images?.[0]?.url ?? null,
      explicit: t.explicit === true,
    });
    const fromLocal = (t: LocalTrack): QueueItem => ({
      kind: 'local', ref: t.file, title: t.title, artists: t.artists, durationMs: 0, image: t.cover ? `${coverUrl}/${t.cover}` : null,
    });

    /** Wo wird gesucht? auto = passend zur gerade laufenden Quelle */
    const searchSpotifyFirst = () => {
      const source = requestSettings().source;
      if (source !== 'auto') return source === 'spotify';
      return effectiveProvider() !== 'local' && spotify.loggedIn;
    };

    /** Songs suchen (Set-Editor und Wünsche) */
    const searchItems = async (query: string, where: 'spotify' | 'local', limit = 5): Promise<Array<QueueItem & { explicit?: boolean }>> => {
      if (where === 'local') return searchLocal(library.flatMap((p) => p.tracks), query, limit).map(fromLocal);
      const link = parseSpotifySource(query);
      if (link) {
        const id = spotifyTrackId(link);
        if (!id) throw new Error('Bitte einen Link zu einem einzelnen Song schicken.');
        const track = await spotify.request<SpotifyTrack>('GET', `/tracks/${id}`);
        return track ? [fromSpotify(track)] : [];
      }
      // Seit Feb. 2026: höchstens 10 Treffer pro Suche
      const res = await spotify.request<{ tracks?: { items: SpotifyTrack[] } }>('GET', '/search', { query: { q: query, type: 'track', limit: String(Math.min(10, limit)) } });
      return (res?.tracks?.items ?? []).filter(Boolean).map(fromSpotify);
    };

    interface RequestInput {
      query: string;
      user: { id: string; name: string };
      level: number;
      source: SongRequest['source'];
      redemption: SongRequest['redemption'];
      replyTo?: string;
      test?: boolean;
    }

    const handleRequest = async (input: RequestInput): Promise<SongRequest | null> => {
      const rs = requestSettings();
      const say = (key: keyof RequestMessages, values: Record<string, string | number>) => reply(key, { user: input.user.name, ...values }, input.replyTo, input.test);
      const refund = (request?: SongRequest) => {
        if (input.redemption) void setRedemption(request ?? ({ redemption: input.redemption } as SongRequest), 'CANCELED');
      };
      const mode = input.source === 'panel' ? 'direct' : requestMode(input.level, input.source, rs);
      if (mode === 'denied') {
        say('denied', { reason: 'Songwünsche sind gerade nur für bestimmte Rollen offen.' });
        return null;
      }
      const query = input.query.trim();
      if (!query) {
        say('denied', { reason: `So geht's: ${rs.command} Songname oder Spotify-Link` });
        refund();
        return null;
      }
      let item: (QueueItem & { explicit?: boolean }) | undefined;
      try {
        [item] = await searchItems(query, searchSpotifyFirst() ? 'spotify' : 'local', 1);
      } catch (err) {
        say('denied', { reason: errorText(err) });
        refund();
        return null;
      }
      if (!item) {
        say('notFound', {});
        refund();
        return null;
      }
      const now = Date.now();
      const reason = checkLimits({
        item,
        userId: input.user.id,
        privileged: input.level >= ROLE_LEVEL.moderator || input.source === 'panel',
        open: openRequests.filter((r) => r.status !== 'playing'),
        // Kanalpunkte sind bezahlt → keine Wartezeit
        lastAt: input.source === 'reward' ? 0 : lastRequestAt.get(input.user.id) ?? 0,
        now,
        settings: rs,
      });
      if (reason) {
        say('denied', { reason });
        refund();
        return null;
      }
      lastRequestAt.set(input.user.id, now);
      const { explicit: _explicit, ...clean } = item;
      const request: SongRequest = {
        id: `${input.test ? 'test-' : ''}${randomUUID()}`, query, item: clean, user: input.user, source: input.source, redemption: input.redemption,
        status: mode === 'direct' ? 'queued' : 'pending', at: now,
      };
      openRequests.push(request);
      if (mode === 'direct') {
        const pos = queue.addRequest(request);
        say('queued', { ...itemValues(request), pos });
        addLog('info', `${input.test ? '[Test] ' : ''}Songwunsch von ${input.user.name} in der Queue: „${clean.title}“.`);
      } else {
        say('suggested', itemValues(request));
        addLog('info', `${input.test ? '[Test] ' : ''}Songvorschlag von ${input.user.name}: „${clean.title}“.`);
      }
      sendRequests();
      return request;
    };

    const approveRequest = (id: string) => {
      const r = openRequests.find((x) => x.id === id && x.status === 'pending');
      if (!r) throw new HttpError(404, 'Diesen Vorschlag gibt es nicht (mehr).');
      r.status = 'queued';
      const pos = queue.addRequest(r);
      reply('approved', { ...itemValues(r), pos }, undefined, r.id.startsWith('test-'));
      sendRequests();
    };

    /** Vorschlag ablehnen oder Wunsch aus der Queue nehmen (Kanalpunkte gibt es zurück) */
    const dropRequest = (id: string, announce: boolean) => {
      const r = openRequests.find((x) => x.id === id);
      if (!r) throw new HttpError(404, 'Diesen Wunsch gibt es nicht (mehr).');
      if (r.status === 'playing') throw new HttpError(409, 'Der Song läuft gerade – einfach „Weiter“ drücken.');
      if (r.status === 'queued' && !queue.removeRequest(r.id)) {
        throw new HttpError(409, 'Der Song ist schon an Spotify übergeben und kommt als Nächstes – entfernen geht nicht mehr, nur überspringen.');
      }
      toHistory(r, r.status === 'pending' ? 'rejected' : 'removed');
      void setRedemption(r, 'CANCELED');
      if (announce) reply('rejected', itemValues(r));
      sendRequests();
      return r;
    };

    const roleOf = (badges: string[], userId: string) => roleLevel(badges, userId === ctx.getUser()?.id);

    ctx.events.on('chat', async (event) => {
      const rs = requestSettings();
      if (!rs.enabled || ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(event.user.id)) return;
      const parsed = parseRequestCommand(event.message, rs);
      if (!parsed) return;
      const level = roleOf(event.badges, event.user.id);
      const user = { id: event.user.id, name: event.user.name };
      const replyTo = event.messageId;
      try {
        switch (parsed.command) {
          case 'request':
            await handleRequest({ query: parsed.arg, user, level, source: 'chat', redemption: null, replyTo, test: event.test });
            return;
          case 'song': {
            if (!nowPlaying) return reply('nothing', {}, replyTo, event.test);
            const by = requestedByNow();
            return reply('song', {
              title: nowPlaying.title,
              artist: nowPlaying.artists.join(', ') || 'unbekannt',
              requested: by ? ` – gewünscht von @${by}` : '',
            }, replyTo, event.test);
          }
          case 'wrongsong': {
            const own = [...openRequests].reverse().find((r) => r.user.id === user.id && (r.status === 'pending' || r.status === 'queued')
              && !(queue.committed?.entry.request?.id === r.id && queue.committed.mode === 'enqueued'));
            if (!own) return reply('denied', { user: user.name, reason: 'Du hast keinen Wunsch, den man noch zurückziehen kann.' }, replyTo, event.test);
            dropRequest(own.id, false);
            return reply('removed', { ...itemValues(own) }, replyTo, event.test);
          }
          case 'queue': {
            const text = upcomingText();
            return text ? reply('queueList', { list: text }, replyTo, event.test) : reply('queueEmpty', {}, replyTo, event.test);
          }
          case 'skip':
            if (level < ROLE_LEVEL.moderator) return;
            await command('next');
            addLog('info', `${user.name} hat den Song übersprungen.`);
            return;
        }
      } catch (err) {
        addLog('warn', `Songwunsch-Befehl von ${user.name}: ${errorText(err)}`);
      }
    });

    ctx.events.on('redemption', async (event) => {
      const rs = requestSettings();
      if (!rs.rewardId || event.reward.id !== rs.rewardId) return;
      const red = { id: event.test ? `test-${event.redemptionId}` : event.redemptionId, rewardId: event.reward.id };
      if (!rs.enabled) {
        void setRedemption({ redemption: red } as SongRequest, 'CANCELED');
        return;
      }
      await handleRequest({ query: event.input, user: { id: event.user.id, name: event.user.name }, level: 0, source: 'reward', redemption: red, test: event.test })
        .catch((err) => addLog('warn', `Songwunsch per Kanalpunkte: ${errorText(err)}`));
    });

    /** Name des Zuschauers, der den laufenden Song gewünscht hat */
    const requestedByNow = (): string | undefined => {
      const cur = queue.current;
      if (!cur?.request || !nowPlaying || nowPlaying.trackId !== itemTrackId(cur.item)) return undefined;
      return cur.request.user.name;
    };

    // Schnittstelle fürs Intro: nach dem Outro die Auto-Start-Playlist einblenden
    const service: MusicService = {
      async startAutoplay(fadeInMs) {
        const source = settings.get('autoStartSource');
        if (!source) throw new Error('Keine Auto-Start-Playlist eingestellt (Musik-Seite).');
        const target = settings.get('volume');
        if (source.startsWith('set:') || source === 'game') {
          const set = resolveSet(source);
          fadeRun++;
          // Alle Wege stumm schalten – welcher Provider startet, entscheidet das Set
          await local.setVolume(0).catch(() => undefined);
          if (sdkState === 'ready') await sdk.setVolume(0).catch(() => undefined);
          volume = 0;
          await playSet(set);
          addLog('info', `Auto-Start: Musik-Set „${set.name}“, einblenden über ${(fadeInMs / 1000).toFixed(1)} s.`);
          fadeTo(target, fadeInMs).catch((err) => addLog('warn', `Einblenden: ${errorText(err)}`));
          return;
        }
        const provider = providerFor(source);
        if (provider.id !== effectiveProvider()) await switchTo(provider.id, false);
        const reason = provider.unavailableReason();
        if (reason) throw new Error(reason);
        fadeRun++;
        // Fernsteuerung: Gerät zuerst aktivieren, sonst geht die Lautstärke nicht
        if (provider === connect) {
          const device = await connectDevice();
          if (!device.is_active) await spotify.request('PUT', '/me/player', { body: { device_ids: [device.id], play: false } }).catch(() => undefined);
        }
        await provider.setVolume(0).catch(() => undefined);
        volume = 0;
        await provider.play(source);
        addLog('info', `Auto-Start: ${describeSource(source)}, einblenden über ${(fadeInMs / 1000).toFixed(1)} s.`);
        // Einblenden läuft im Hintergrund weiter – das Intro macht sofort mit den Webhooks weiter
        fadeTo(target, fadeInMs).catch((err) => addLog('warn', `Einblenden: ${errorText(err)}`));
      },
    };
    ctx.provide(MUSIC_SERVICE, service);

    // -------------------------------------------------------- Aufräumen

    // Addon wurde (wieder) eingeschaltet, während der Music-Host schon offen ist → er soll sich neu melden
    hostClients = ctx.overlay.clients('host');
    if (hostClients) toHost({ type: 'host.ping' });

    shutdown = () => {
      // Laufende Fades (Fernsteuerung) und verzögerte Abfragen beenden
      fadeRun++;
      stopped = true;
      clearInterval(queueTimer);
      if (sdkTimer) clearTimeout(sdkTimer);
      if (pollTimer) clearInterval(pollTimer);
      toHost({ type: 'local.cmd', action: 'pause' });
      toHost({ type: 'sdk.cmd', action: 'disconnect' });
    };

    // Beim Start: Benutzer laden (Token wird dabei bei Bedarf erneuert)
    if (spotify.loggedIn) {
      spotify.loadUser().then(() => sendState()).catch((err) => addLog('warn', `Spotify: ${errorText(err)}`));
    }

    // -------------------------------------------------------- API für die Oberfläche

    const playlistsOf = async () => {
      const localLists = library.map((p) => {
        // Bild der Playlist = erstes Cover darin
        const cover = p.tracks.find((t) => t.cover)?.cover;
        return { id: `local:${p.id}`, name: p.id ? p.name : 'Hauptordner', count: p.tracks.length, image: cover ? `${coverUrl}/${cover}` : null, provider: 'local' };
      });
      let spotifyLists: Array<{ id: string; name: string; count: number; image: string | null; provider: string }> = [];
      let spotifyError: string | null = null;
      if (spotify.loggedIn) {
        try {
          for (let offset = 0; offset < 200; offset += 50) {
            type Page = { items: Array<{ uri: string; name: string; images?: { url: string }[] | null; items?: { total: number }; tracks?: { total: number } }>; next: string | null };
            const page = await spotify.request<Page>('GET', '/me/playlists', { query: { limit: '50', offset: String(offset) } });
            for (const p of page?.items ?? []) {
              if (!p) continue;
              // Seit Feb. 2026 heißt das Feld „items“ (vorher „tracks“)
              spotifyLists.push({ id: p.uri, name: p.name, count: p.items?.total ?? p.tracks?.total ?? 0, image: p.images?.[0]?.url ?? null, provider: 'spotify' });
            }
            if (!page?.next) break;
          }
        } catch (err) {
          spotifyError = errorText(err);
          spotifyLists = [];
        }
      }
      return { local: localLists, spotify: spotifyLists, spotifyError };
    };

    const fullState = () => ({
      ...publicState(),
      providers: providerList(),
      nowPlaying: publicNowPlaying(),
      settings: settings.all(),
      clientIdFromEnv: !settings.get('spotify').clientId && !!process.env.SPOTIFY_CLIENT_ID,
      spotify: { loggedIn: spotify.loggedIn, user: spotify.user, redirectUri: redirectUri(), sdkState, sdkError },
      host: { connected: hostClients, ...hostInfo, url: `${ctx.overlay.baseUrl}/host.html` },
      overlayUrl: `${ctx.overlay.baseUrl}/now-playing.html`,
      library: library.map((p) => ({ id: p.id, name: p.id ? p.name : 'Hauptordner', count: p.tracks.length })),
      log: [...log].reverse(),
      sets: setsState(),
      requests: requestsState(),
    });

    ctx.api.get('/state', () => fullState());

    ctx.api.post('/cmd', async ({ body }) => {
      await command(String(body?.action));
      return fullState();
    });

    ctx.api.post('/play', async ({ body }) => {
      await play(body?.source ? String(body.source) : undefined);
      return fullState();
    });

    ctx.api.post('/volume', async ({ body }) => {
      const v = body?.delta !== undefined ? currentVolume() + Number(body.delta) : Number(body?.volume);
      if (!Number.isFinite(v)) throw new HttpError(400, 'Bitte volume (0–100) oder delta angeben.');
      await setVolume(v);
      return fullState();
    });

    ctx.api.post('/provider', async ({ body }) => {
      if (!isProvider(body?.provider)) throw new HttpError(400, 'Unbekannter Provider.');
      await switchTo(body.provider, true);
      return fullState();
    });

    ctx.api.post('/settings', ({ body }) => {
      const before = settings.all();
      const next = mergeSettings(before, body);
      if (next.local.rootDir && !fs.existsSync(next.local.rootDir)) throw new HttpError(400, `Den Ordner „${next.local.rootDir}“ gibt es nicht.`);
      settings.update(next);
      if (next.local.rootDir !== before.local.rootDir) rescan();
      if (next.spotify.deviceName !== before.spotify.deviceName && sdkState !== 'off') {
        // Neuer Gerätename → SDK neu verbinden
        sdkState = 'off';
        startSdk();
      }
      if (next.overlay.showSeconds !== before.overlay.showSeconds || next.overlay.corner !== before.overlay.corner) {
        ctx.overlay.broadcast({ type: 'music.overlay', ...next.overlay }, 'overlay');
      }
      return fullState();
    });

    ctx.api.get('/playlists', () => playlistsOf());

    ctx.api.post('/library/rescan', () => {
      rescan();
      return fullState();
    });

    ctx.api.post('/open-host', () => {
      const url = `${ctx.overlay.baseUrl}/host.html`;
      try {
        const browser = launchHost(url, path.join(ctx.dataDir, 'host-browser'), (err) => addLog('error', `Music-Host konnte nicht gestartet werden: ${errorText(err)}`));
        addLog('info', `Music-Host in ${browser} geöffnet.`);
        return { ok: true, browser };
      } catch (err) {
        // Kein Chrome/Edge gefunden → im Standardbrowser öffnen
        void shell.openExternal(url);
        addLog('warn', `${errorText(err)} Music-Host im Standardbrowser geöffnet – Spotify in der Suite braucht Chrome oder Edge.`);
        return { ok: true, browser: 'Standardbrowser' };
      }
    });

    ctx.api.get('/overlay-state', () => ({ nowPlaying: publicNowPlaying(), overlay: settings.get('overlay'), ...publicState() }));

    // ---- Spotify-Login

    ctx.api.post('/spotify/login', () => {
      if (!clientId()) throw new HttpError(400, 'Bitte zuerst die Client-ID deiner Spotify-App eintragen.');
      const { verifier, challenge } = pkcePair();
      const state = randomBytes(16).toString('base64url');
      for (const [key, value] of logins) if (Date.now() - value.at > LOGIN_TTL_MS) logins.delete(key);
      logins.set(state, { verifier, at: Date.now() });
      const url = authorizeUrl({ clientId: clientId(), redirectUri: redirectUri(), challenge, state });
      void shell.openExternal(url);
      return { url };
    });

    /** Von callback.html: { code, state } oder { error } */
    ctx.api.post('/spotify/callback', async ({ body }) => {
      if (body?.error) throw new HttpError(400, `Spotify hat den Login abgelehnt: ${String(body.error)}`);
      const login = logins.get(String(body?.state));
      if (!login) throw new HttpError(400, 'Dieser Login ist abgelaufen. Bitte in der Suite nochmal auf „Mit Spotify verbinden“ klicken.');
      logins.delete(String(body.state));
      try {
        await spotify.exchangeCode(String(body?.code), login.verifier);
      } catch (err) {
        throw new HttpError(400, errorText(err));
      }
      addLog('info', `Mit Spotify verbunden${spotify.user ? ` als ${spotify.user.name}` : ''}.`);
      sdkState = 'off';
      startSdk();
      ensurePolling();
      sendState();
      return { ok: true, user: spotify.user };
    });

    ctx.api.post('/spotify/logout', () => {
      spotify.logout();
      toHost({ type: 'sdk.cmd', action: 'disconnect' });
      sdkState = 'off';
      sdkDeviceId = null;
      addLog('info', 'Von Spotify abgemeldet.');
      ensurePolling();
      return fullState();
    });

    /** Access-Token für das SDK im Music-Host (POST, damit fremde Webseiten ihn nicht abholen können) */
    ctx.api.post('/spotify/token', async () => {
      try {
        return { accessToken: await spotify.accessToken() };
      } catch (err) {
        throw new HttpError(401, errorText(err));
      }
    });

    // ---- Musik-Sets

    ctx.api.get('/sets', () => setsState());

    ctx.api.post('/sets/save', ({ body }) => {
      const set = cleanSet(body?.set);
      if (set.type === 'linked' && set.source.startsWith('local:') && !library.some((p) => `local:${p.id}` === set.source)) {
        throw new HttpError(400, 'Diesen Musik-Ordner gibt es nicht (mehr).');
      }
      let sets = settings.get('sets');
      const exists = sets.some((s) => s.id === set.id);
      if (!exists && sets.length >= MAX_SETS) throw new HttpError(400, `Höchstens ${MAX_SETS} Sets.`);
      sets = exists ? sets.map((s) => (s.id === set.id ? set : s)) : [...sets, set];
      settings.set('sets', claimGames(sets, set));
      sendSets();
      return { ...setsState(), saved: set };
    });

    ctx.api.post('/sets/delete', ({ body }) => {
      const id = String(body?.id ?? '');
      settings.set('sets', settings.get('sets').filter((s) => s.id !== id));
      if (settings.get('defaultSetId') === id) settings.set('defaultSetId', '');
      if (settings.get('autoStartSource') === `set:${id}`) settings.set('autoStartSource', '');
      if (activeSetId === id) activeSetId = '';
      sendSets();
      return setsState();
    });

    ctx.api.post('/sets/play', async ({ body }) => {
      const set = findSet(String(body?.id ?? ''));
      if (!set) throw new HttpError(404, 'Dieses Musik-Set gibt es nicht (mehr).');
      await playSet(set);
      return setsState();
    });

    /** { defaultSetId?, switchOnGameChange? } */
    ctx.api.post('/sets/settings', ({ body }) => {
      settings.update(mergeSettings(settings.all(), {
        defaultSetId: body?.defaultSetId,
        switchOnGameChange: body?.switchOnGameChange,
      }));
      sendSets();
      return setsState();
    });

    /** Twitch-Kategorien suchen (für die Spiel-Zuordnung) */
    ctx.api.get('/games/search', async ({ query }) => {
      const q = String(query.get('q') ?? '').trim();
      if (!q) return [];
      if (!ctx.getUser()) throw new HttpError(401, 'Bitte zuerst in der Übersicht mit Twitch verbinden.');
      const res = await ctx.twitch.request<{ data: { id: string; name: string; box_art_url: string }[] }>('GET', '/search/categories', { query: { query: q, first: '12' } });
      return res.data.map((g) => ({ id: g.id, name: g.name, image: g.box_art_url.replace('{width}', '52').replace('{height}', '72') }));
    });

    /** Songs suchen: ?q=…&where=spotify|local */
    ctx.api.get('/search', async ({ query }) => {
      const q = String(query.get('q') ?? '').trim();
      const where = query.get('where') === 'local' ? 'local' : 'spotify';
      if (!q) return [];
      if (where === 'spotify' && !spotify.loggedIn) throw new HttpError(409, 'Für die Spotify-Suche erst mit Spotify verbinden.');
      try {
        return await searchItems(q, where, 10);
      } catch (err) {
        throw new HttpError(err instanceof SpotifyError ? 502 : 400, errorText(err));
      }
    });

    // ---- Songwünsche

    ctx.api.get('/requests', () => requestsState());

    ctx.api.post('/requests/settings', ({ body }) => {
      settings.set('requests', mergeRequestSettings(requestSettings(), body));
      sendRequests();
      return requestsState();
    });

    ctx.api.post('/requests/approve', ({ body }) => {
      approveRequest(String(body?.id));
      return requestsState();
    });

    ctx.api.post('/requests/reject', ({ body }) => {
      dropRequest(String(body?.id), body?.announce !== false);
      return requestsState();
    });

    ctx.api.post('/requests/move', ({ body }) => {
      queue.moveRequest(String(body?.id), Number(body?.delta) < 0 ? -1 : 1);
      return requestsState();
    });

    /** Selbst einen Song in die Queue packen: { query } */
    ctx.api.post('/requests/add', async ({ body }) => {
      const user = ctx.getUser();
      const request = await handleRequest({
        query: String(body?.query ?? ''),
        user: { id: user?.id ?? 'streamer', name: user?.displayName ?? 'Streamer' },
        level: ROLE_LEVEL.broadcaster,
        source: 'panel',
        redemption: null,
        test: true,
      });
      if (!request) throw new HttpError(404, 'Nichts gefunden (oder abgelehnt – siehe Ereignisse).');
      return requestsState();
    });

    /** Zum Ausprobieren: Wunsch eines Test-Zuschauers (schreibt nichts in den Chat) */
    ctx.api.post('/requests/test', async ({ body }) => {
      const role = String(body?.role ?? 'everyone') as keyof typeof ROLE_LEVEL;
      const level = ROLE_LEVEL[role] ?? 0;
      const n = Math.floor(Math.random() * 900) + 100;
      await handleRequest({
        query: String(body?.query ?? ''),
        user: { id: `test-${role}-${n}`, name: `Test${role === 'everyone' ? 'Zuschauer' : role[0].toUpperCase() + role.slice(1)}${n}` },
        level,
        source: body?.reward ? 'reward' : 'chat',
        redemption: body?.reward ? { id: `test-${n}`, rewardId: requestSettings().rewardId || 'test' } : null,
        test: true,
      });
      return requestsState();
    });

    /** Kanalpunkte-Belohnung anlegen oder ändern: { title, cost } */
    ctx.api.post('/requests/reward', async ({ body }) => {
      const user = ctx.getUser();
      if (!user) throw new HttpError(401, 'Bitte zuerst in der Übersicht mit Twitch verbinden.');
      const title = String(body?.title ?? '').trim().slice(0, 45) || 'Song wünschen';
      const cost = Math.max(1, Math.round(Number(body?.cost) || 500));
      const data = { title, cost, prompt: 'Songname oder Spotify-Link', is_user_input_required: true };
      const current = requestSettings().rewardId;
      try {
        if (current) {
          await ctx.twitch.request('PATCH', '/channel_points/custom_rewards', { query: { broadcaster_id: user.id, id: current }, body: data });
        } else {
          const res = await ctx.twitch.request<{ data: { id: string }[] }>('POST', '/channel_points/custom_rewards', { query: { broadcaster_id: user.id }, body: data });
          settings.set('requests', { ...requestSettings(), rewardId: res.data[0].id });
        }
      } catch (err) {
        const text = errorText(err);
        if (/403/.test(text)) throw new HttpError(403, 'Kanalpunkte gibt es nur für Affiliates und Partner.');
        if (/404/.test(text) && current) {
          // In Twitch gelöscht → beim nächsten Klick neu anlegen
          settings.set('requests', { ...requestSettings(), rewardId: '' });
          throw new HttpError(404, 'Die Belohnung gibt es bei Twitch nicht mehr. Bitte nochmal klicken, dann wird sie neu angelegt.');
        }
        if (/400/.test(text) && /DUPLICATE/i.test(text)) throw new HttpError(400, 'Es gibt schon eine Belohnung mit diesem Namen.');
        throw new HttpError(502, `Twitch: ${text}`);
      }
      settings.set('requests', { ...requestSettings(), rewardTitle: title, rewardCost: cost });
      addLog('info', `Kanalpunkte-Belohnung „${title}“ (${cost} Punkte) ist bereit.`);
      return requestsState();
    });

    ctx.api.post('/requests/reward/delete', async () => {
      const user = ctx.getUser();
      const id = requestSettings().rewardId;
      if (id && user) {
        await ctx.twitch.request('DELETE', '/channel_points/custom_rewards', { query: { broadcaster_id: user.id, id } })
          .catch((err) => {
            if (!/404/.test(errorText(err))) throw new HttpError(502, `Twitch: ${errorText(err)}`);
          });
      }
      settings.set('requests', { ...requestSettings(), rewardId: '' });
      return requestsState();
    });

    ctx.api.post('/log/clear', () => {
      log.length = 0;
      return fullState();
    });

    // -------------------------------------------------------- Fernsteuerung (Streamdeck): /api/music/…

    const remote = (fn: (body: any) => Promise<unknown>) => async ({ body }: { body: any }) => { // eslint-disable-line @typescript-eslint/no-explicit-any
      await fn(body ?? {});
      return { ok: true, ...publicState(), nowPlaying: publicNowPlaying() };
    };
    ctx.api.remote.post('/play', remote((b) => play(b.source ? String(b.source) : undefined)));
    ctx.api.remote.post('/pause', remote(() => command('pause')));
    ctx.api.remote.post('/toggle', remote(() => command('toggle')));
    ctx.api.remote.post('/next', remote(() => command('next')));
    ctx.api.remote.post('/previous', remote(() => command('previous')));
    ctx.api.remote.post('/volume', remote((b) => {
      const v = b.delta !== undefined ? currentVolume() + Number(b.delta) : Number(b.volume);
      if (!Number.isFinite(v)) throw new HttpError(400, 'Bitte { "volume": 0–100 } oder { "delta": ±n } schicken.');
      return setVolume(v);
    }));
    ctx.api.remote.post('/provider', remote((b) => {
      if (!isProvider(b.provider)) throw new HttpError(400, `Unbekannter Provider. Möglich: ${PROVIDERS.join(', ')}`);
      return switchTo(b.provider, true);
    }));
    ctx.api.remote.post('/set', remote((b) => {
      const name = String(b.set ?? b.id ?? '');
      const set = findSet(name);
      if (!set) throw new HttpError(404, `Kein Musik-Set „${name}“. Name oder ID schicken, z.B. { "set": "Chill" }`);
      return b.fade === false ? playSet(set) : crossToSet(set, 'Streamdeck');
    }));
    ctx.api.remote.get('/now-playing', () => publicNowPlaying() ?? { nowPlaying: null });
    ctx.api.remote.get('/state', () => ({ ...publicState(), nowPlaying: publicNowPlaying() }));
  },

  deactivate() {
    const fn = shutdown;
    shutdown = null;
    fn?.();
  },
};
