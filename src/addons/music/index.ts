import { safeStorage, shell } from 'electron';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Addon, AddonContext } from '../../core/addons';
import { ConfigStore } from '../../core/config';
import { HttpError } from '../../core/server';
import { launchHost } from './hostBrowser';
import { scanLibrary, type LocalPlaylist, type LocalTrack } from './library';
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
import { MUSIC_SERVICE, type MusicService } from './service';
import {
  SpotifyClient,
  SpotifyError,
  authorizeUrl,
  pickConnectDevice,
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
    let nowPlaying: NowPlaying | null = null;
    let lastBroadcastKey = '';

    // Lokale Bibliothek
    const coverDir = path.join(ctx.dataDir, 'covers');
    const coverUrl = `${ctx.dataUrl}/covers`;
    let libraryUrl = '';
    let library: LocalPlaylist[] = [];
    let localPlaylist: LocalPlaylist | null = null;
    let localStatus: LocalStatus = { isPlaying: false, trackId: null, positionMs: 0, durationMs: 0 };

    const rescan = () => {
      const root = settings.get('local').rootDir;
      library = root ? scanLibrary(root, coverDir) : [];
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

    /** Welcher Provider spielt wirklich? (SDK ausgefallen → Fernsteuerung der Desktop-App) */
    const effectiveProvider = (): ProviderId => {
      const chosen = settings.get('provider');
      if (chosen === 'spotify-sdk' && sdkState === 'failed') return 'spotify-connect';
      return chosen;
    };

    const startSdk = () => {
      if (!hostConnected() || !spotify.loggedIn || settings.get('provider') !== 'spotify-sdk') return;
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

    const localTrack = (id: string | null): LocalTrack | null => localPlaylist?.tracks.find((t) => t.id === id) ?? null;

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
      broadcastNowPlaying(true);
    };

    const publicNowPlaying = () => (nowPlaying ? { ...nowPlaying, at: Date.now() } : null);

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
      volume,
      targetVolume: settings.get('volume'),
    });

    const sendState = () => {
      ctx.overlay.broadcast({ type: 'music.state', ...publicState() });
      ctx.overlay.broadcast({ type: 'music.state', ...publicState() }, 'overlay');
    };

    // -------------------------------------------------------- Polling (nur Fernsteuerung der Desktop-App)

    let pollTimer: NodeJS.Timeout | null = null;
    /** Nur solange jemand zuschaut (Steuerseite oder Overlay) */
    const anyoneWatching = () => ctx.overlay.clients() + ctx.overlay.clients('overlay') > 0;

    const pollConnect = async () => {
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

    /** Läuft ein Fade (Lautstärke-Rampe) – ein neuer bricht den alten ab */
    let fadeRun = 0;

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
        toHost({ type: 'sdk.cmd', action: 'pause' });
      },
      async resume() {
        // Ist die Suite gerade nicht das aktive Gerät, holt „play“ mit device_id die Wiedergabe her
        await spotifyCall(() => spotify.request('PUT', '/me/player/play', { query: { device_id: sdkDeviceId! } }));
      },
      async next() {
        toHost({ type: 'sdk.cmd', action: 'next' });
      },
      async previous() {
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
      if (persist) settings.set('provider', id);
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
      }
      if (id === 'spotify-sdk') startSdk();
      ensurePolling();
      sendState();
    };

    const play = async (rawSource?: string) => {
      const source = rawSource ? cleanSource(rawSource) : undefined;
      const provider = providerFor(source);
      if (provider.id !== effectiveProvider()) await switchTo(provider.id, provider.id !== 'spotify-connect' || settings.get('provider') !== 'spotify-sdk');
      fadeRun++;
      await provider.play(source);
      if (source) addLog('info', `Spiele ${describeSource(source)}.`);
    };

    const describeSource = (source: string) => {
      if (source.startsWith('local:')) return `lokale Playlist „${source.slice(6) || 'Hauptordner'}“`;
      return source;
    };

    const setVolume = async (v: number, remember = true) => {
      fadeRun++;
      volume = clampVolume(v);
      if (remember) settings.set('volume', volume);
      await active().setVolume(volume);
      sendState();
    };

    const fadeTo = async (v: number, ms: number) => {
      fadeRun++;
      const provider = active();
      const target = clampVolume(v);
      await provider.fadeTo(target, ms);
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
        case 'next':
          return provider.next();
        case 'previous':
          return provider.previous();
        default:
          throw new HttpError(400, 'Unbekannter Befehl.');
      }
    };

    // Schnittstelle fürs Intro: nach dem Outro die Auto-Start-Playlist einblenden
    const service: MusicService = {
      async startAutoplay(fadeInMs) {
        const source = settings.get('autoStartSource');
        if (!source) throw new Error('Keine Auto-Start-Playlist eingestellt (Musik-Seite).');
        const target = settings.get('volume');
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

    shutdown = () => {
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
      const v = body?.delta !== undefined ? volume + Number(body.delta) : Number(body?.volume);
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
        const browser = launchHost(url, path.join(ctx.dataDir, 'host-browser'));
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
      const v = b.delta !== undefined ? volume + Number(b.delta) : Number(b.volume);
      if (!Number.isFinite(v)) throw new HttpError(400, 'Bitte { "volume": 0–100 } oder { "delta": ±n } schicken.');
      return setVolume(v);
    }));
    ctx.api.remote.post('/provider', remote((b) => {
      if (!isProvider(b.provider)) throw new HttpError(400, `Unbekannter Provider. Möglich: ${PROVIDERS.join(', ')}`);
      return switchTo(b.provider, true);
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
