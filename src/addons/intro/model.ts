import { HttpError } from '../../core/server';

// ------------------------------------------------------------------ Datenmodell

export const SEGMENT_IDS = ['intro', 'loop1', 'main', 'loop2', 'outro'] as const;
export type SegmentId = (typeof SEGMENT_IDS)[number];

export const STATES = ['IDLE', 'INTRO', 'LOOP1', 'MAIN', 'LOOP2', 'OUTRO', 'DONE'] as const;
export type IntroState = (typeof STATES)[number];

/** Zustände, zu denen Webhooks verschickt werden können */
export const WEBHOOK_STATES = ['INTRO', 'LOOP1', 'MAIN', 'LOOP2', 'OUTRO', 'DONE'] as const;
export type WebhookState = (typeof WEBHOOK_STATES)[number];

export const COMMANDS = ['start', 'go', 'outro', 'cancel-pending', 'abort', 'reset'] as const;
export type IntroCommand = (typeof COMMANDS)[number];

export interface SegmentFiles {
  /** Dateiname im Medienordner – Video OHNE Tonspur (leer = schwarzes Bild) */
  video: string;
  /** Dateiname im Medienordner – WAV (48 kHz) */
  audio: string;
  /** Text über dem Video, solange das Segment läuft (leer = keiner) */
  overlayText: string;
}

export interface Settings {
  /** Ordner mit den Segment-Dateien. Leer = Datenordner der Suite (addon-data/intro/media) */
  mediaDir: string;
  segments: Record<SegmentId, SegmentFiles>;
  onDone: {
    switchScene: boolean;
    startMusic: boolean;
    musicFadeInMs: number;
    webhooks: boolean;
  };
  obs: {
    /** Szene nach dem Intro */
    streamScene: string;
    /** Szene beim Start des Intros (leer = nicht umschalten) */
    introScene: string;
  };
  /** Pro Zustand eine Liste von URLs, die beim Erreichen per POST { state, ts } benachrichtigt werden */
  webhooks: Record<WebhookState, string[]>;
}

export const DEFAULTS: Settings = {
  mediaDir: '',
  segments: {
    intro: { video: 'intro.webm', audio: 'intro.wav', overlayText: '' },
    loop1: { video: 'loop1.webm', audio: 'loop1.wav', overlayText: 'Stream startet gleich' },
    main: { video: 'main.webm', audio: 'main.wav', overlayText: '' },
    loop2: { video: 'loop2.webm', audio: 'loop2.wav', overlayText: '' },
    outro: { video: 'outro.webm', audio: 'outro.wav', overlayText: '' },
  },
  onDone: { switchScene: true, startMusic: true, musicFadeInMs: 3000, webhooks: true },
  obs: { streamScene: 'Live', introScene: '' },
  webhooks: { INTRO: [], LOOP1: [], MAIN: [], LOOP2: [], OUTRO: [], DONE: [] },
};

// ------------------------------------------------------------------ Eingaben prüfen

const str = (value: unknown, max = 256) => String(value ?? '').trim().slice(0, max);
const num = (value: unknown, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

/** Nur ein Dateiname (oder Unterordner/Datei) im Medienordner – nie aus dem Ordner heraus */
export function cleanFileName(value: unknown, what: string): string {
  const name = str(value, 200).replace(/\\/g, '/');
  if (!name) throw new HttpError(400, `${what}: Bitte einen Dateinamen eintragen.`);
  if (name.startsWith('/') || /^[a-z]:/i.test(name) || name.split('/').includes('..')) {
    throw new HttpError(400, `${what}: Nur Dateinamen im Medienordner, keine Pfade nach außerhalb.`);
  }
  return name;
}

export function cleanWebhookUrl(value: unknown): string {
  const text = str(value, 500);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new HttpError(400, `„${text}“ ist keine gültige Webhook-Adresse.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new HttpError(400, `Webhooks brauchen http:// oder https:// („${text}“).`);
  return url.toString();
}

/** Teil-Änderung der Einstellungen prüfen und mit den aktuellen zusammenführen */
export function mergeSettings(current: Settings, input: unknown): Settings {
  const patch = (input ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const next = structuredClone(current);

  if (patch.mediaDir !== undefined) next.mediaDir = str(patch.mediaDir, 500);

  if (patch.segments && typeof patch.segments === 'object') {
    for (const id of SEGMENT_IDS) {
      const seg = patch.segments[id];
      if (!seg || typeof seg !== 'object') continue;
      // Video ist optional: leer = schwarzes Bild (z.B. solange es nur den Beat gibt)
      if (seg.video !== undefined) next.segments[id].video = str(seg.video) ? cleanFileName(seg.video, `${id} (Video)`) : '';
      if (seg.audio !== undefined) next.segments[id].audio = cleanFileName(seg.audio, `${id} (Audio)`);
      if (seg.overlayText !== undefined) next.segments[id].overlayText = str(seg.overlayText, 120);
    }
  }

  if (patch.onDone && typeof patch.onDone === 'object') {
    const d = patch.onDone;
    if (typeof d.switchScene === 'boolean') next.onDone.switchScene = d.switchScene;
    if (typeof d.startMusic === 'boolean') next.onDone.startMusic = d.startMusic;
    if (typeof d.webhooks === 'boolean') next.onDone.webhooks = d.webhooks;
    if (d.musicFadeInMs !== undefined) next.onDone.musicFadeInMs = num(d.musicFadeInMs, 0, 30_000, 3000);
  }

  if (patch.obs && typeof patch.obs === 'object') {
    if (patch.obs.streamScene !== undefined) next.obs.streamScene = str(patch.obs.streamScene);
    if (patch.obs.introScene !== undefined) next.obs.introScene = str(patch.obs.introScene);
  }

  if (patch.webhooks && typeof patch.webhooks === 'object') {
    for (const state of WEBHOOK_STATES) {
      const list = patch.webhooks[state];
      if (list === undefined) continue;
      const urls = (Array.isArray(list) ? list : String(list).split(/\s+/)).map(String).map((u) => u.trim()).filter(Boolean);
      if (urls.length > 10) throw new HttpError(400, `Höchstens 10 Webhooks pro Zustand (${state}).`);
      next.webhooks[state] = urls.map(cleanWebhookUrl);
    }
  }

  return next;
}

export function isCommand(value: unknown): value is IntroCommand {
  return typeof value === 'string' && (COMMANDS as readonly string[]).includes(value);
}
