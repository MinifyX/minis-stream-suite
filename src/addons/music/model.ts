import { HttpError } from '../../core/server';
import { parseSpotifySource } from './spotify';

// ------------------------------------------------------------------ Typen

export const PROVIDERS = ['spotify-sdk', 'spotify-connect', 'local'] as const;
export type ProviderId = (typeof PROVIDERS)[number];

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  'spotify-sdk': 'Spotify (in der Suite)',
  'spotify-connect': 'Spotify (Desktop-App fernsteuern)',
  local: 'Lokale Dateien',
};

/** Was gerade läuft – gleich für alle Provider */
export interface NowPlaying {
  title: string;
  artists: string[];
  album?: string;
  coverUrl?: string;
  durationMs: number;
  positionMs: number;
  isPlaying: boolean;
  provider: ProviderId;
  /** Zum Erkennen von Titelwechseln */
  trackId: string;
}

/** Quelle: Spotify-URI („spotify:playlist:…“) oder lokale Playlist („local:<Ordner>“) */
export type SourceRef = string;

/**
 * Gemeinsames Interface aller Musik-Quellen. Der MusicManager (index.ts) wählt den aktiven
 * Provider, hält den Zustand und verteilt Events.
 */
export interface MusicProvider {
  id: ProviderId;
  /** null = verfügbar, sonst der Grund auf Deutsch */
  unavailableReason(): string | null;
  play(source?: SourceRef): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  /** 0..100 */
  setVolume(volume: number): Promise<void>;
  fadeTo(volume: number, durationMs: number): Promise<void>;
  getNowPlaying(): Promise<NowPlaying | null>;
}

export interface Settings {
  /** Gewählter Provider (gilt auch nach einem Neustart) */
  provider: ProviderId;
  /** Läuft nach dem Intro (Spotify-URI/Link oder local:<Ordner>) */
  autoStartSource: string;
  /** Ziel-Lautstärke 0..100 (auch fürs Einblenden nach dem Intro) */
  volume: number;
  shuffle: boolean;
  repeat: boolean;
  spotify: {
    /** Client-ID der eigenen Spotify-App (developer.spotify.com). SPOTIFY_CLIENT_ID hat Vorrang, wenn leer. */
    clientId: string;
    /** Name, unter dem die Suite als Spotify-Connect-Gerät erscheint */
    deviceName: string;
    /** Fernsteuerung: Gerät mit diesem Namen (leer = ein „Computer“, das aktive bevorzugt) */
    connectDeviceName: string;
  };
  local: {
    rootDir: string;
    crossfadeMs: number;
  };
  overlay: {
    /** So lange bleibt die Anzeige nach einem Titelwechsel sichtbar (0 = immer, solange Musik läuft) */
    showSeconds: number;
    corner: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  };
}

export const DEFAULTS: Settings = {
  provider: 'spotify-sdk',
  autoStartSource: '',
  volume: 60,
  shuffle: false,
  repeat: true,
  spotify: { clientId: '', deviceName: 'Stream Suite', connectDeviceName: '' },
  local: { rootDir: '', crossfadeMs: 4000 },
  overlay: { showSeconds: 10, corner: 'bottom-left' },
};

// ------------------------------------------------------------------ Eingaben prüfen

const str = (value: unknown, max = 256) => String(value ?? '').trim().slice(0, max);
export const clampVolume = (value: unknown) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)));

export function isProvider(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/** Quelle prüfen: Spotify-URI/Link → URI, „local:…“ bleibt, leer bleibt leer */
export function cleanSource(value: unknown): string {
  const text = str(value, 500);
  if (!text) return '';
  if (text.startsWith('local:')) return text;
  const uri = parseSpotifySource(text);
  if (!uri) throw new HttpError(400, 'Das ist keine gültige Quelle. Erwartet: Spotify-Link oder -URI (Playlist, Album, Titel) oder eine lokale Playlist.');
  return uri;
}

export function mergeSettings(current: Settings, input: unknown): Settings {
  const patch = (input ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const next = structuredClone(current);
  if (patch.provider !== undefined) {
    if (!isProvider(patch.provider)) throw new HttpError(400, 'Unbekannter Provider.');
    next.provider = patch.provider;
  }
  if (patch.autoStartSource !== undefined) next.autoStartSource = cleanSource(patch.autoStartSource);
  if (patch.volume !== undefined) next.volume = clampVolume(patch.volume);
  if (typeof patch.shuffle === 'boolean') next.shuffle = patch.shuffle;
  if (typeof patch.repeat === 'boolean') next.repeat = patch.repeat;
  if (patch.spotify && typeof patch.spotify === 'object') {
    if (patch.spotify.clientId !== undefined) {
      const id = str(patch.spotify.clientId, 64);
      if (id && !/^[a-f0-9]{32}$/i.test(id)) throw new HttpError(400, 'Die Spotify Client-ID besteht aus 32 Zeichen (0-9, a-f).');
      next.spotify.clientId = id;
    }
    if (patch.spotify.deviceName !== undefined) next.spotify.deviceName = str(patch.spotify.deviceName, 60) || DEFAULTS.spotify.deviceName;
    if (patch.spotify.connectDeviceName !== undefined) next.spotify.connectDeviceName = str(patch.spotify.connectDeviceName, 60);
  }
  if (patch.local && typeof patch.local === 'object') {
    if (patch.local.rootDir !== undefined) next.local.rootDir = str(patch.local.rootDir, 500);
    if (patch.local.crossfadeMs !== undefined) next.local.crossfadeMs = Math.max(0, Math.min(15_000, Math.round(Number(patch.local.crossfadeMs) || 0)));
  }
  if (patch.overlay && typeof patch.overlay === 'object') {
    if (patch.overlay.showSeconds !== undefined) next.overlay.showSeconds = Math.max(0, Math.min(600, Math.round(Number(patch.overlay.showSeconds) || 0)));
    if (['bottom-left', 'bottom-right', 'top-left', 'top-right'].includes(patch.overlay.corner)) next.overlay.corner = patch.overlay.corner;
  }
  return next;
}

/** Schritte für einen groben Fade über die Web API (wenig Anfragen → kein Rate-Limit) */
export function fadeSteps(from: number, to: number, durationMs: number, steps = 6): Array<{ atMs: number; volume: number }> {
  if (durationMs <= 0 || from === to) return [{ atMs: 0, volume: to }];
  return Array.from({ length: steps }, (_, i) => ({
    atMs: Math.round((durationMs * (i + 1)) / steps),
    volume: Math.round(from + ((to - from) * (i + 1)) / steps),
  }));
}
