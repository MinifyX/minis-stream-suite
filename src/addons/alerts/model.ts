import { randomUUID } from 'node:crypto';
import type { EventOfType, StreamEvent } from '../../core/twitch/events';

/**
 * Datenmodell der Alerts:
 *   Kategorie (z.B. Follows) → mehrere Varianten → jede Variante hat Bedingungen + Design.
 * Bei einem Event gewinnt die erste passende aktive Variante (oder eine zufällige, wenn "randomize" an ist).
 */

export const CATEGORY_IDS = ['follow', 'sub', 'giftsub', 'cheer', 'raid', 'hypetrain', 'redemption'] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

/** Bild/Video/Sound: eingebaut (Bibliothek) oder hochgeladene Datei */
export interface MediaRef {
  source: 'builtin' | 'file';
  id: string;
  name: string;
  kind: 'image' | 'video' | 'audio';
}

export interface AlertDesign {
  durationMs: number;
  animationIn: 'fade' | 'pop' | 'slide-down' | 'slide-up' | 'zoom' | 'bounce' | 'none';
  animationOut: 'fade' | 'slide-up' | 'slide-down' | 'zoom' | 'none';

  layout: 'image-left' | 'image-right' | 'image-top' | 'image-bottom' | 'overlay';
  background: string;
  backgroundOpacity: number;
  padding: number;
  gap: number;
  rounded: boolean;
  shadow: boolean;

  message: string;
  showUserMessage: boolean;
  font: string;
  fontWeight: number;
  fontSize: number;
  align: 'left' | 'center' | 'right' | 'justify';
  textColor: string;
  accentColor: string;
  textShadow: boolean;

  tts: { enabled: boolean; voice: string; rate: number; volume: number; readUserMessage: boolean };

  image: MediaRef | null;
  /** Bildhöhe in % der Overlay-Höhe */
  imageSize: number;
  imageVolume: number;
  sound: MediaRef | null;
  soundVolume: number;

  celebration: {
    enabled: boolean;
    effect: 'confetti' | 'fireworks' | 'hearts' | 'stars';
    intensity: 'light' | 'medium' | 'heavy';
    area: 'full' | 'alert';
  };
}

export interface VariantConditions {
  subKind: 'any' | 'new' | 'resub';
  tier: 'any' | '1000' | '2000' | '3000';
  minMonths: number;
  minCount: number;
  minBits: number;
  minViewers: number;
  rewardMode: 'all' | 'some';
  rewardIds: string[];
  /** Hype Train: bei welchem Moment (Start, Level-Aufstieg, Ende) */
  trainPhase: 'any' | HypeTrainPhase;
  /** Hype Train: ab welchem Level (gilt für Level-Aufstieg und Ende) */
  minLevel: number;
  /** Hype Train: nur beim Golden Kappa Train */
  goldenOnly: boolean;
}

export interface Variant {
  id: string;
  name: string;
  enabled: boolean;
  conditions: VariantConditions;
  design: AlertDesign;
}

export interface Category {
  randomize: boolean;
  variants: Variant[];
}

export interface RewardSetting {
  alert: boolean;
  title: string;
}

export interface AlertSettings {
  /** Größe der Vorschau = empfohlene Größe der OBS-Browserquelle */
  canvas: { width: number; height: number };
  categories: Record<CategoryId, Category>;
  /** Belohnungs-Filter: Alert für Belohnungen ohne eigene Einstellung */
  newRewardDefault: boolean;
  /** Belohnungs-Filter: Reward-ID → an/aus */
  rewards: Record<string, RewardSetting>;
  /** Belohnungs-Filter: Kanalpunkte-Gruppen, die nie einen Alert auslösen */
  mutedGroups: string[];
}

/**
 * Darf eine Belohnung überhaupt einen Alert auslösen?
 * Reihenfolge: eigene Einstellung der Belohnung → stumme Gruppe → Standard.
 */
export function rewardAllowed(settings: AlertSettings, rewardId: string, groupIds: string[]): boolean {
  const own = settings.rewards[rewardId];
  if (own) return own.alert;
  if (groupIds.some((id) => settings.mutedGroups.includes(id))) return false;
  return settings.newRewardDefault;
}

// ------------------------------------------------------------------ Standardwerte

export const DEFAULT_DESIGN: AlertDesign = {
  durationMs: 6000,
  animationIn: 'pop',
  animationOut: 'fade',
  layout: 'image-top',
  background: '#000000',
  backgroundOpacity: 0,
  padding: 16,
  gap: 16,
  rounded: true,
  shadow: false,
  message: '{user} folgt jetzt!',
  showUserMessage: true,
  font: 'Roboto',
  fontWeight: 700,
  fontSize: 36,
  align: 'center',
  textColor: '#FFFFFF',
  accentColor: '#9146FF',
  textShadow: true,
  tts: { enabled: false, voice: '', rate: 0, volume: 80, readUserMessage: false },
  image: null,
  imageSize: 45,
  imageVolume: 50,
  sound: null,
  soundVolume: 50,
  celebration: { enabled: false, effect: 'confetti', intensity: 'medium', area: 'full' },
};

export const DEFAULT_CONDITIONS: VariantConditions = {
  subKind: 'any',
  tier: 'any',
  minMonths: 0,
  minCount: 1,
  minBits: 1,
  minViewers: 1,
  rewardMode: 'all',
  rewardIds: [],
  trainPhase: 'any',
  minLevel: 1,
  goldenOnly: false,
};

const builtinImage = (id: string, name: string): MediaRef => ({ source: 'builtin', id, name, kind: 'image' });
const builtinSound = (id: string, name: string): MediaRef => ({ source: 'builtin', id, name, kind: 'audio' });

function makeVariant(
  id: string,
  name: string,
  design: Partial<AlertDesign>,
  conditions: Partial<VariantConditions> = {},
): Variant {
  return {
    id,
    name,
    enabled: true,
    conditions: { ...DEFAULT_CONDITIONS, ...conditions },
    design: { ...structuredClone(DEFAULT_DESIGN), ...design },
  };
}

const confetti = { enabled: true, effect: 'confetti', intensity: 'medium', area: 'full' } as const;

export const DEFAULT_CATEGORIES: Record<CategoryId, Category> = {
  follow: {
    randomize: false,
    variants: [
      makeVariant('follow-default', 'Neuer Follow', {
        message: '{user} folgt jetzt!',
        image: builtinImage('heart', 'Herzen'),
        sound: builtinSound('chime', 'Glockenspiel'),
      }),
    ],
  },
  sub: {
    randomize: false,
    variants: [
      makeVariant(
        'sub-resub',
        'Abo-Verlängerung',
        {
          message: '{user} ist seit {months} Monaten dabei!',
          image: builtinImage('trophy', 'Pokal'),
          sound: builtinSound('fanfare', 'Fanfare'),
          celebration: { ...confetti },
        },
        { subKind: 'resub' },
      ),
      makeVariant('sub-new', 'Neues Abo', {
        message: '{user} hat abonniert!',
        image: builtinImage('star', 'Stern'),
        sound: builtinSound('fanfare', 'Fanfare'),
        celebration: { ...confetti },
      }),
    ],
  },
  giftsub: {
    randomize: false,
    variants: [
      makeVariant('giftsub-default', 'Verschenkte Abos', {
        message: '{user} verschenkt {count} Abos!',
        image: builtinImage('gift', 'Geschenk'),
        sound: builtinSound('levelup', 'Level-Up'),
        celebration: { ...confetti, intensity: 'heavy' },
      }),
    ],
  },
  cheer: {
    randomize: false,
    variants: [
      makeVariant('cheer-default', 'Bits', {
        message: '{user} cheert {bits} Bits!',
        image: builtinImage('diamond', 'Diamant'),
        sound: builtinSound('coin', 'Münze'),
      }),
    ],
  },
  raid: {
    randomize: false,
    variants: [
      makeVariant('raid-default', 'Raid', {
        message: '{user} raidet mit {viewers} Leuten!',
        image: builtinImage('rocket', 'Rakete'),
        sound: builtinSound('fanfare', 'Fanfare'),
        celebration: { enabled: true, effect: 'fireworks', intensity: 'medium', area: 'full' },
      }),
    ],
  },
  hypetrain: {
    randomize: false,
    variants: [
      makeVariant(
        'hypetrain-start',
        'Hype Train Start',
        {
          message: 'Der {type} fährt los! Alle einsteigen!',
          image: builtinImage('rocket', 'Rakete'),
          sound: builtinSound('whoosh', 'Whoosh'),
        },
        { trainPhase: 'start' },
      ),
      makeVariant(
        'hypetrain-levelup',
        'Level-Aufstieg',
        {
          message: 'Hype Train Level {level}!',
          image: builtinImage('star', 'Stern'),
          sound: builtinSound('levelup', 'Level-Up'),
          celebration: { ...confetti },
        },
        { trainPhase: 'levelup', minLevel: 2 },
      ),
      makeVariant(
        'hypetrain-end',
        'Hype Train Ende',
        {
          message: 'Hype Train vorbei: Level {level} geschafft! Danke an alle!',
          image: builtinImage('trophy', 'Pokal'),
          sound: builtinSound('tada', 'Tada'),
          celebration: { enabled: true, effect: 'fireworks', intensity: 'heavy', area: 'full' },
        },
        { trainPhase: 'end' },
      ),
    ],
  },
  redemption: {
    randomize: false,
    variants: [
      makeVariant('redemption-default', 'Kanalpunkte', {
        message: '{user} hat {reward} eingelöst!',
        image: builtinImage('sparkle', 'Funkeln'),
        sound: builtinSound('pop', 'Pop'),
      }),
    ],
  },
};

export const DEFAULT_SETTINGS: AlertSettings = {
  canvas: { width: 800, height: 600 },
  categories: DEFAULT_CATEGORIES,
  newRewardDefault: true,
  rewards: {},
  mutedGroups: [],
};

// ------------------------------------------------------------------ Aufräumen von Eingaben

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Übernimmt nur Werte mit dem richtigen Typ – alles andere bleibt beim Standard. */
function mergeTyped<T extends object>(defaults: T, input: unknown): T {
  const result = structuredClone(defaults) as Record<string, unknown>;
  if (!isObject(input)) return result as T;
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = input[key];
    if (value === undefined) continue;
    if (isObject(fallback)) result[key] = mergeTyped(fallback, value);
    else if (Array.isArray(fallback)) result[key] = Array.isArray(value) ? value.map(String) : fallback;
    else if (typeof value === typeof fallback) result[key] = value;
  }
  return result as T;
}

function sanitizeMedia(value: unknown, kinds: MediaRef['kind'][]): MediaRef | null {
  if (!isObject(value)) return null;
  const { source, id, name, kind } = value;
  if ((source !== 'builtin' && source !== 'file') || typeof id !== 'string' || !kinds.includes(kind as MediaRef['kind'])) {
    return null;
  }
  if (source === 'file' && !/^[\w-]+\.\w+$/.test(id)) return null;
  return { source, id, name: String(name ?? id), kind: kind as MediaRef['kind'] };
}

export function sanitizeVariant(input: unknown): Variant {
  const v = isObject(input) ? input : {};
  const design = mergeTyped(DEFAULT_DESIGN, v.design);
  const rawDesign = isObject(v.design) ? v.design : {};
  design.image = sanitizeMedia(rawDesign.image, ['image', 'video']);
  design.sound = sanitizeMedia(rawDesign.sound, ['audio']);
  return {
    id: typeof v.id === 'string' && v.id ? v.id : randomUUID(),
    name: typeof v.name === 'string' ? v.name.slice(0, 80) : 'Variante',
    enabled: v.enabled !== false,
    conditions: mergeTyped(DEFAULT_CONDITIONS, v.conditions),
    design,
  };
}

export function sanitizeCategories(input: unknown): Record<CategoryId, Category> {
  const result = {} as Record<CategoryId, Category>;
  for (const id of CATEGORY_IDS) {
    const raw = isObject(input) && isObject(input[id]) ? input[id] : null;
    result[id] = raw
      ? {
          randomize: raw.randomize === true,
          variants: Array.isArray(raw.variants) ? raw.variants.map(sanitizeVariant) : [],
        }
      : structuredClone(DEFAULT_CATEGORIES[id]);
  }
  return result;
}

// ------------------------------------------------------------------ Event → Kategorie, Variante, Werte

/** Die Momente eines Hype Trains, zu denen ein Alert kommen kann */
export type HypeTrainPhase = 'start' | 'levelup' | 'end';

/**
 * Welcher Moment ist dieses Hype-Train-Event?
 * Achtung: Jedes "progress"-Event gilt hier als Level-Aufstieg. Das Addon lässt deshalb nur
 * die Fortschritts-Events durch, bei denen das Level wirklich gestiegen ist (siehe index.ts).
 */
export function trainPhaseOf(event: EventOfType<'hypetrain'>): HypeTrainPhase {
  if (event.phase === 'begin') return 'start';
  if (event.phase === 'end') return 'end';
  return 'levelup';
}

/** Welche Alert-Art zu einem Event gehört – null bei Events ohne Alert (Chat, Umfragen …) */
export function categoryOf(event: StreamEvent): CategoryId | null {
  if (event.type === 'resub') return 'sub';
  return (CATEGORY_IDS as readonly string[]).includes(event.type) ? (event.type as CategoryId) : null;
}

export function matches(variant: Variant, event: StreamEvent): boolean {
  const c = variant.conditions;
  switch (event.type) {
    case 'follow':
      return true;
    case 'sub':
    case 'resub': {
      if (c.subKind === 'new' && event.type !== 'sub') return false;
      if (c.subKind === 'resub' && event.type !== 'resub') return false;
      if (c.tier !== 'any' && event.tier !== c.tier) return false;
      const months = event.type === 'resub' ? event.months : 1;
      return months >= c.minMonths;
    }
    case 'giftsub':
      return event.count >= c.minCount;
    case 'cheer':
      return event.bits >= c.minBits;
    case 'raid':
      return event.viewers >= c.minViewers;
    case 'hypetrain': {
      const phase = trainPhaseOf(event);
      if (c.trainPhase !== 'any' && c.trainPhase !== phase) return false;
      if (c.goldenOnly && event.trainType !== 'golden_kappa') return false;
      // Beim Start ist das Level immer 1 – da zählt "ab Level" nicht
      return phase === 'start' || event.level >= c.minLevel;
    }
    case 'redemption':
      return c.rewardMode === 'all' || c.rewardIds.includes(event.reward.id);
    default:
      return false;
  }
}

/** Wählt die Variante für ein Event – oder null, wenn kein Alert kommen soll. */
export function pickVariant(
  settings: AlertSettings,
  event: StreamEvent,
  groupsOf: (rewardId: string) => string[] = () => [],
): { category: CategoryId; variant: Variant } | null {
  const category = categoryOf(event);
  if (!category) return null;
  // Verschenkte Abos lösen pro Empfänger ein "sub" aus → das übernimmt der Gift-Alert
  if (event.type === 'sub' && event.isGift) return null;
  if (event.type === 'redemption' && !rewardAllowed(settings, event.reward.id, groupsOf(event.reward.id))) return null;
  const { randomize, variants } = settings.categories[category];
  const candidates = variants.filter((v) => v.enabled && matches(v, event));
  if (!candidates.length) return null;
  const variant = randomize ? candidates[Math.floor(Math.random() * candidates.length)] : candidates[0];
  return { category, variant };
}

function tierName(tier: string): string {
  return { '1000': '1', '2000': '2', '3000': '3' }[tier] ?? tier;
}

/** Lesbarer Name der Hype-Train-Art für {type} */
function trainTypeName(type: string): string {
  return { regular: 'Hype Train', golden_kappa: 'Golden Kappa Train', treasure: 'Treasure Train' }[type] ?? 'Hype Train';
}

/** Platzhalter-Werte ({user}, {bits}, …) und die Nachricht des Zuschauers */
export function describeEvent(event: StreamEvent): { values: Record<string, string | number>; userMessage: string } {
  const user = 'user' in event && event.user ? event.user.name : 'Anonym';
  switch (event.type) {
    case 'redemption':
      return { values: { user, reward: event.reward.title, cost: event.reward.cost }, userMessage: event.input };
    case 'sub':
      return { values: { user, tier: tierName(event.tier), months: 1 }, userMessage: '' };
    case 'resub':
      return { values: { user, tier: tierName(event.tier), months: event.months }, userMessage: event.message };
    case 'giftsub':
      return { values: { user, tier: tierName(event.tier), count: event.count }, userMessage: '' };
    case 'cheer':
      return { values: { user, bits: event.bits }, userMessage: event.message };
    case 'raid':
      return { values: { user, viewers: event.viewers }, userMessage: '' };
    case 'hypetrain': {
      // {top} = wer am meisten beigetragen hat
      const best = [...event.topContributions].sort((a, b) => b.total - a.total)[0];
      const top = best?.user.name || 'Anonym';
      return {
        values: { user: top, top, level: event.level, total: event.total, type: trainTypeName(event.trainType) },
        userMessage: '',
      };
    }
    default:
      return { values: { user }, userMessage: '' };
  }
}

export function fillPlain(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (Object.hasOwn(values, key) ? String(values[key]) : match));
}
