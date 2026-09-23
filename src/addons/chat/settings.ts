// Einstellungen des Chat-Addons: OBS-Overlay und Chat-Fenster sind komplett getrennt einstellbar.
// Reine Logik ohne Electron, damit sie in den Tests läuft (settings.test.ts).

export const EVENT_KINDS = ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'redemption', 'stream', 'hypetrain', 'prediction', 'shoutout', 'ads'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
export const ROLES = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LEVEL: Record<Role, number> = { everyone: 0, subscriber: 1, vip: 2, moderator: 3, broadcaster: 4 };

const allEvents = (on: boolean) => Object.fromEntries(EVENT_KINDS.map((k) => [k, on])) as Record<EventKind, boolean>;

/** Regeln, die Overlay und Chat-Fenster jeweils für sich haben */
export interface ChatRules {
  /** Markdown (**fett**, *kursiv* …) ab welcher Rolle */
  markdown: { enabled: boolean; minRole: Role };
  /** Farben ([rot]Text[/]) ab welcher Rolle */
  colors: { enabled: boolean; minRole: Role };
  /** Emotes von 7TV/BTTV/FFZ anzeigen */
  thirdPartyEmotes: boolean;
  showBadges: boolean;
  hideCommands: boolean;
  /** Logins, deren Nachrichten nicht angezeigt werden (z.B. Bots) */
  hiddenUsers: string[];
  events: Record<EventKind, boolean>;
}

export interface OverlaySettings extends ChatRules {
  /** Kanalpunkte-Einlösungen, die im Alert-Filter stumm sind, verstecken */
  respectAlertFilter: boolean;
  font: string;
  fontSize: number;
  fontWeight: number;
  textColor: string;
  nameColorMode: 'twitch' | 'fixed';
  nameColor: string;
  background: string;
  backgroundOpacity: number;
  rounded: boolean;
  textShadow: boolean;
  layout: 'inline' | 'stacked';
  animation: 'slide' | 'fade' | 'pop' | 'none';
  direction: 'bottom' | 'top';
  align: 'left' | 'right';
  /** 0 = nie ausblenden */
  fadeOutSeconds: number;
  maxMessages: number;
}

export interface WindowSettings extends ChatRules {
  font: string;
  fontSize: number;
  timestamps: boolean;
  timestampSeconds: boolean;
  alternateBackground: boolean;
  highlightMentions: boolean;
  highlightWords: string[];
  /** Einlösungen, die im Overlay versteckt sind: markiert anzeigen oder ganz weglassen */
  mutedRewards: 'mark' | 'hide';
  /** Gelöschte Nachrichten durchstreichen oder ganz entfernen */
  deletedMessages: 'strike' | 'hide';
}

export interface Settings {
  /** Welche Emote-Anbieter geladen werden (gilt für beide, anzeigen lässt sich getrennt) */
  emotes: { seventv: boolean; bttv: boolean; ffz: boolean };
  overlay: OverlaySettings;
  window: WindowSettings;
}

export const OVERLAY_FONTS = ['Segoe UI', 'Arial', 'Verdana', 'Nunito', 'Roboto', 'Montserrat', 'Poppins', 'Fredoka', 'Inter', 'Oswald', 'Bangers', 'Press Start 2P', 'Comic Neue'];
/** Im Chat-Fenster nur Schriften, die auf jedem Windows-PC da sind (kein Internet nötig) */
export const WINDOW_FONTS = ['Segoe UI', 'Arial', 'Verdana', 'Tahoma', 'Consolas'];

export const DEFAULTS: Settings = {
  emotes: { seventv: true, bttv: true, ffz: true },
  overlay: {
    markdown: { enabled: true, minRole: 'everyone' },
    colors: { enabled: true, minRole: 'subscriber' },
    thirdPartyEmotes: true,
    showBadges: true,
    hideCommands: true,
    hiddenUsers: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot'],
    events: { ...allEvents(true), stream: false, ads: false },
    respectAlertFilter: true,
    font: 'Nunito',
    fontSize: 22,
    fontWeight: 700,
    textColor: '#FFFFFF',
    nameColorMode: 'twitch',
    nameColor: '#9146FF',
    background: '#000000',
    backgroundOpacity: 45,
    rounded: true,
    textShadow: true,
    layout: 'inline',
    animation: 'slide',
    direction: 'bottom',
    align: 'left',
    fadeOutSeconds: 0,
    maxMessages: 15,
  },
  window: {
    markdown: { enabled: true, minRole: 'everyone' },
    colors: { enabled: true, minRole: 'subscriber' },
    thirdPartyEmotes: true,
    showBadges: true,
    hideCommands: false,
    hiddenUsers: [],
    events: allEvents(true),
    font: 'Segoe UI',
    fontSize: 14,
    timestamps: true,
    timestampSeconds: false,
    alternateBackground: true,
    highlightMentions: true,
    highlightWords: [],
    mutedRewards: 'mark',
    deletedMessages: 'strike',
  },
};

// ------------------------------------------------------------------ Prüfen

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Übernimmt nur Werte mit passendem Typ, fehlende kommen aus den Standardwerten */
function mergeTyped<T>(defaults: T, input: unknown): T {
  if (isObject(defaults)) {
    const out: Record<string, unknown> = {};
    const src = isObject(input) ? input : {};
    for (const [key, def] of Object.entries(defaults)) out[key] = mergeTyped(def, src[key]);
    return out as T;
  }
  if (Array.isArray(defaults)) {
    return (Array.isArray(input) ? input.map((x) => String(x).trim()).filter(Boolean).slice(0, 100) : defaults) as T;
  }
  return (typeof input === typeof defaults ? input : defaults) as T;
}

/**
 * Bis v0.5 lagen Markdown, Farben und der Alert-Filter oben und galten für beide.
 * Alte Werte gelten weiter, bis Overlay oder Fenster eigene haben.
 */
function withLegacy(raw: Record<string, unknown>, section: 'overlay' | 'window'): Record<string, unknown> {
  const own = isObject(raw[section]) ? raw[section] : {};
  const legacy: Record<string, unknown> = {};
  if (raw.markdown !== undefined) legacy.markdown = raw.markdown;
  if (raw.colors !== undefined) legacy.colors = raw.colors;
  if (section === 'overlay' && raw.respectAlertFilter !== undefined) legacy.respectAlertFilter = raw.respectAlertFilter;
  return { ...legacy, ...own };
}

const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));
const hex = (v: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : fallback);
const oneOf = <T extends string>(v: string, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);
const logins = (list: string[]) => [...new Set(list.map((u) => u.toLowerCase().replace(/^@/, '')).filter((u) => /^\w{1,25}$/.test(u)))];

function sanitizeRules(r: ChatRules, defaults: ChatRules): void {
  r.markdown.minRole = oneOf(r.markdown.minRole, ROLES, defaults.markdown.minRole);
  r.colors.minRole = oneOf(r.colors.minRole, ROLES, defaults.colors.minRole);
  r.hiddenUsers = logins(r.hiddenUsers);
}

export function sanitize(input: unknown): Settings {
  const raw = isObject(input) ? input : {};
  const s: Settings = {
    emotes: mergeTyped(DEFAULTS.emotes, raw.emotes),
    overlay: mergeTyped(DEFAULTS.overlay, withLegacy(raw, 'overlay')),
    window: mergeTyped(DEFAULTS.window, withLegacy(raw, 'window')),
  };

  const o = s.overlay;
  sanitizeRules(o, DEFAULTS.overlay);
  o.font = oneOf(o.font, OVERLAY_FONTS, DEFAULTS.overlay.font);
  o.fontSize = clamp(o.fontSize, 10, 80);
  o.fontWeight = clamp(o.fontWeight, 300, 900);
  o.textColor = hex(o.textColor, DEFAULTS.overlay.textColor);
  o.nameColor = hex(o.nameColor, DEFAULTS.overlay.nameColor);
  o.background = hex(o.background, DEFAULTS.overlay.background);
  o.backgroundOpacity = clamp(o.backgroundOpacity, 0, 100);
  o.nameColorMode = oneOf(o.nameColorMode, ['twitch', 'fixed'] as const, 'twitch');
  o.layout = oneOf(o.layout, ['inline', 'stacked'] as const, 'inline');
  o.animation = oneOf(o.animation, ['slide', 'fade', 'pop', 'none'] as const, 'slide');
  o.direction = oneOf(o.direction, ['bottom', 'top'] as const, 'bottom');
  o.align = oneOf(o.align, ['left', 'right'] as const, 'left');
  o.fadeOutSeconds = clamp(o.fadeOutSeconds, 0, 3600);
  o.maxMessages = clamp(o.maxMessages, 1, 100);

  const w = s.window;
  sanitizeRules(w, DEFAULTS.window);
  w.font = oneOf(w.font, WINDOW_FONTS, DEFAULTS.window.font);
  w.fontSize = clamp(w.fontSize, 10, 30);
  w.highlightWords = [...new Set(w.highlightWords.map((x) => x.toLowerCase()).filter((x) => x.length <= 40))];
  w.mutedRewards = oneOf(w.mutedRewards, ['mark', 'hide'] as const, 'mark');
  w.deletedMessages = oneOf(w.deletedMessages, ['strike', 'hide'] as const, 'strike');
  return s;
}

/**
 * Änderung in die Einstellungen einarbeiten. Die Seiten schicken nur, was sie geändert haben
 * (z.B. { window: { fontSize: 15 } }) – so überschreiben sich Einstellungsseite und Chat-Fenster
 * nicht gegenseitig mit veralteten Werten. Listen werden komplett ersetzt.
 */
export function applyPatch(current: Settings, patch: unknown): Settings {
  const merge = (base: unknown, change: unknown): unknown => {
    if (!isObject(base) || !isObject(change)) return change === undefined ? base : change;
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(change)) out[key] = merge(base[key], value);
    return out;
  };
  return sanitize(merge(structuredClone(current), patch));
}
