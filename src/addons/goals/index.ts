import { randomUUID } from 'node:crypto';
import type { Addon, AddonContext } from '../../core/addons';
import { HttpError } from '../../core/server';
import { makeTestEvent, type StreamEvent, type StreamEventType } from '../../core/twitch/events';

/**
 * Ziele & Events:
 *  - Ziele (Follower, Abos, Bits, Kanalpunkte, eigener Zähler) mit Fortschrittsbalken fürs OBS-Overlay.
 *    Gesamtwerte kommen beim Start/Aktualisieren von Twitch und werden danach live mit den Events hochgezählt.
 *  - „Letzte Events“-Leiste: letzter Follower, Abo, Cheer, Raid, Geschenk-Abo und Top-Cheerer des Streams.
 *
 * Test-Events (Test-Buttons) bewegen die Overlays kurz mit, werden aber NIE gespeichert:
 * Nach ein paar Sekunden springt alles wieder auf den echten Stand.
 */

// ------------------------------------------------------------------ Datenmodell

type GoalType = 'followers' | 'followersSince' | 'subs' | 'subsSince' | 'bits' | 'redemptions' | 'custom';
const GOAL_TYPES: GoalType[] = ['followers', 'followersSince', 'subs', 'subsSince', 'bits', 'redemptions', 'custom'];
/** Diese Arten holen ihren Stand von Twitch */
const TWITCH_TYPES: GoalType[] = ['followers', 'followersSince', 'subs'];

type GoalLayout = 'bar' | 'slim' | 'ring';

interface GoalStyle {
  layout: GoalLayout;
  font: string;
  fontSize: number;
  /** Breite in px (beim Kreis: Durchmesser) */
  width: number;
  textColor: string;
  /** Füllung: Verlauf von barColor nach barColor2 (gleich = einfarbig) */
  barColor: string;
  barColor2: string;
  /** Hintergrund des Balkens */
  trackColor: string;
  trackOpacity: number;
  rounded: boolean;
  textShadow: boolean;
  showTitle: boolean;
  showNumbers: boolean;
  showPercent: boolean;
  /** Animation + Konfetti, wenn das Ziel erreicht ist */
  celebrate: boolean;
  celebrateText: string;
}

interface Goal {
  id: string;
  title: string;
  type: GoalType;
  /** Nur bei "redemptions" */
  rewardId: string;
  rewardTitle: string;
  /** Aktuelles Ziel (steigt mit „automatisch nächstes Ziel“) … */
  target: number;
  /** … und das Ziel, das du eingestellt hast (gilt wieder nach dem Zurücksetzen) */
  startTarget: number;
  autoNext: boolean;
  step: number;
  /** "subsSince": Abo-Verlängerungen (Resubs) mitzählen */
  countResubs: boolean;
  /** Beim Stream-Start automatisch zurücksetzen */
  resetOnStream: boolean;
  /** Von der Suite gezählt (bei Twitch-Arten: Stand von Twitch + Events seitdem) */
  count: number;
  /** Manuelle Korrektur, kommt zum gezählten Wert dazu */
  offset: number;
  /** "followersSince": Twitch-Gesamtzahl beim Zurücksetzen (null = noch unbekannt) */
  baseline: number | null;
  resetAt: number;
  style: GoalStyle;
}

const RECENT_KINDS = ['follow', 'sub', 'cheer', 'raid', 'giftsub', 'topcheer'] as const;
type RecentKind = (typeof RECENT_KINDS)[number];

interface RecentEntry {
  name: string;
  /** Bits, Zuschauer, Anzahl Abos … (0 = keine Zahl) */
  amount: number;
  /** Nur bei Abos: Monate (0 = neues Abo) */
  months: number;
  at: number;
}

type RecentLayout = 'bar' | 'list' | 'ticker';

interface RecentStyle {
  layout: RecentLayout;
  items: Record<RecentKind, boolean>;
  labels: Record<RecentKind, string>;
  font: string;
  fontSize: number;
  textColor: string;
  /** Farbe der Überschriften („Letzter Follow“) */
  labelColor: string;
  background: string;
  backgroundOpacity: number;
  rounded: boolean;
  textShadow: boolean;
  showIcons: boolean;
  /** Laufband: so lange bleibt ein Eintrag stehen */
  tickerSeconds: number;
  /** Breite in px (0 = automatisch) */
  width: number;
}

interface Settings {
  goals: Goal[];
  recent: Record<Exclude<RecentKind, 'topcheer'>, RecentEntry | null>;
  /** Für den Top-Cheerer: Bits pro Zuschauer im aktuellen Stream */
  stream: { startedAt: string | null; cheerers: Record<string, { name: string; bits: number }> };
  recentStyle: RecentStyle;
}

/** Schriften, die die Overlays kennen (Google Fonts bzw. Windows) – gleiche Liste wie render.js */
const FONTS = ['Segoe UI', 'Arial', 'Verdana', 'Nunito', 'Roboto', 'Montserrat', 'Poppins', 'Fredoka', 'Inter', 'Oswald', 'Bangers', 'Press Start 2P', 'Comic Neue'];

const DEFAULT_STYLE: GoalStyle = {
  layout: 'bar',
  font: 'Montserrat',
  fontSize: 22,
  width: 600,
  textColor: '#FFFFFF',
  barColor: '#9147FF',
  barColor2: '#FF6BD6',
  trackColor: '#18181B',
  trackOpacity: 80,
  rounded: true,
  textShadow: true,
  showTitle: true,
  showNumbers: true,
  showPercent: true,
  celebrate: true,
  celebrateText: 'Ziel erreicht! 🎉',
};

const DEFAULT_TITLES: Record<GoalType, string> = {
  followers: 'Follower-Ziel',
  followersSince: 'Neue Follower',
  subs: 'Abo-Ziel',
  subsSince: 'Neue Abos',
  bits: 'Bits-Ziel',
  redemptions: 'Kanalpunkte-Ziel',
  custom: 'Mein Ziel',
};

const DEFAULT_RECENT_STYLE: RecentStyle = {
  layout: 'bar',
  items: { follow: true, sub: true, cheer: true, raid: true, giftsub: true, topcheer: false },
  labels: {
    follow: 'Letzter Follow',
    sub: 'Letztes Abo',
    cheer: 'Letzter Cheer',
    raid: 'Letzter Raid',
    giftsub: 'Letztes Geschenk',
    topcheer: 'Top-Cheerer',
  },
  font: 'Montserrat',
  fontSize: 20,
  textColor: '#FFFFFF',
  labelColor: '#BF94FF',
  background: '#18181B',
  backgroundOpacity: 80,
  rounded: true,
  textShadow: true,
  showIcons: true,
  tickerSeconds: 6,
  width: 0,
};

const DEFAULTS: Settings = {
  goals: [],
  recent: { follow: null, sub: null, cheer: null, raid: null, giftsub: null },
  stream: { startedAt: null, cheerers: {} },
  recentStyle: DEFAULT_RECENT_STYLE,
};

const MAX_GOALS = 20;
const MAX_VALUE = 1_000_000_000;
/** So lange zeigen die Overlays einen Test, danach wieder den echten Stand */
const TEST_SHOW_MS = 8000;
/** Gesamtwerte regelmäßig bei Twitch nachschauen (z.B. wegen Entfolgungen) */
const REFRESH_EVERY_MS = 5 * 60_000;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// ------------------------------------------------------------------ Helfer

const int = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, max);
const color = (v: unknown, fallback: string) => (typeof v === 'string' && COLOR_RE.test(v) ? v.toUpperCase() : fallback);
const bool = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback);
const font = (v: unknown, fallback: string) => (typeof v === 'string' && FONTS.includes(v) ? v : fallback);
const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

/** Wert, den das Ziel gerade anzeigt */
const valueOf = (g: Goal) => Math.max(0, g.count + g.offset);

function cleanStyle(s: Partial<GoalStyle> | undefined, base: GoalStyle = DEFAULT_STYLE): GoalStyle {
  const o = s ?? {};
  return {
    layout: pick(o.layout, ['bar', 'slim', 'ring'] as const, base.layout),
    font: font(o.font, base.font),
    fontSize: int(o.fontSize ?? base.fontSize, 10, 120),
    width: int(o.width ?? base.width, 80, 1920),
    textColor: color(o.textColor, base.textColor),
    barColor: color(o.barColor, base.barColor),
    barColor2: color(o.barColor2, base.barColor2),
    trackColor: color(o.trackColor, base.trackColor),
    trackOpacity: int(o.trackOpacity ?? base.trackOpacity, 0, 100),
    rounded: bool(o.rounded, base.rounded),
    textShadow: bool(o.textShadow, base.textShadow),
    showTitle: bool(o.showTitle, base.showTitle),
    showNumbers: bool(o.showNumbers, base.showNumbers),
    showPercent: bool(o.showPercent, base.showPercent),
    celebrate: bool(o.celebrate, base.celebrate),
    celebrateText: o.celebrateText === undefined ? base.celebrateText : oneLine(o.celebrateText, 80),
  };
}

function cleanRecentStyle(s: Partial<RecentStyle> | undefined, base: RecentStyle = DEFAULT_RECENT_STYLE): RecentStyle {
  const o = s ?? {};
  const items = { ...base.items };
  const labels = { ...base.labels };
  for (const k of RECENT_KINDS) {
    if (typeof o.items?.[k] === 'boolean') items[k] = o.items[k];
    if (typeof o.labels?.[k] === 'string') labels[k] = oneLine(o.labels[k], 40);
  }
  return {
    layout: pick(o.layout, ['bar', 'list', 'ticker'] as const, base.layout),
    items,
    labels,
    font: font(o.font, base.font),
    fontSize: int(o.fontSize ?? base.fontSize, 10, 80),
    textColor: color(o.textColor, base.textColor),
    labelColor: color(o.labelColor, base.labelColor),
    background: color(o.background, base.background),
    backgroundOpacity: int(o.backgroundOpacity ?? base.backgroundOpacity, 0, 100),
    rounded: bool(o.rounded, base.rounded),
    textShadow: bool(o.textShadow, base.textShadow),
    showIcons: bool(o.showIcons, base.showIcons),
    tickerSeconds: int(o.tickerSeconds ?? base.tickerSeconds, 2, 60),
    width: int(o.width ?? base.width, 0, 1920),
  };
}

/** Gespeichertes Ziel auffüllen (ältere Dateien, fehlende Felder) */
function normalizeGoal(g: Partial<Goal>): Goal {
  const type = pick(g.type, GOAL_TYPES, 'custom');
  const target = int(g.target ?? 100, 1, MAX_VALUE);
  return {
    id: typeof g.id === 'string' && g.id ? g.id : randomUUID(),
    title: typeof g.title === 'string' ? oneLine(g.title, 80) : DEFAULT_TITLES[type],
    type,
    rewardId: String(g.rewardId ?? ''),
    rewardTitle: oneLine(g.rewardTitle, 100),
    target,
    startTarget: int(g.startTarget ?? target, 1, MAX_VALUE),
    autoNext: g.autoNext === true,
    step: int(g.step ?? 10, 1, MAX_VALUE),
    countResubs: g.countResubs !== false,
    resetOnStream: g.resetOnStream === true,
    count: Math.round(Number(g.count) || 0),
    offset: Math.round(Number(g.offset) || 0),
    baseline: typeof g.baseline === 'number' ? g.baseline : null,
    resetAt: Number(g.resetAt) || Date.now(),
    style: cleanStyle(g.style),
  };
}

/**
 * Ist das Ziel gerade erreicht worden? Gibt das erreichte Ziel zurück (für die Feier im Overlay).
 * Mit „automatisch nächstes Ziel“ wird das Ziel danach um die Schrittweite erhöht.
 */
function checkReached(g: Goal, before: number): number | null {
  const after = valueOf(g);
  if (before >= g.target || after < g.target) return null;
  const reached = g.target;
  if (g.autoNext && g.step > 0) g.target += (Math.floor((after - g.target) / g.step) + 1) * g.step;
  return reached;
}

/** Nächste „schöne“ Zahl über dem Stand, z.B. 123 → 150, 1234 → 1500 (für neue Gesamt-Ziele) */
function niceTarget(value: number): number {
  const unit = value < 50 ? 10 : value < 500 ? 50 : value < 5000 ? 500 : 10 ** Math.floor(Math.log10(value));
  return (Math.floor(value / unit) + 1) * unit;
}

/** Um wie viel ändert ein Event dieses Ziel? */
function deltaFor(g: Goal, event: StreamEvent): number {
  const followers = g.type === 'followers' || g.type === 'followersSince';
  const subs = g.type === 'subs' || g.type === 'subsSince';
  switch (event.type) {
    case 'follow':
      return followers ? 1 : 0;
    case 'sub':
      // Verschenkte Abos kommen pro Empfänger UND einmal als "giftsub" → nur "giftsub" zählen
      return subs && !event.isGift ? 1 : 0;
    case 'resub':
      // Die Twitch-Gesamtzahl ändert sich durch eine Verlängerung nicht
      return g.type === 'subsSince' && g.countResubs ? 1 : 0;
    case 'giftsub':
      return subs ? Math.max(1, event.count) : 0;
    case 'cheer':
      return g.type === 'bits' ? Math.max(0, event.bits) : 0;
    case 'redemption':
      return g.type === 'redemptions' && !!g.rewardId && event.reward.id === g.rewardId ? 1 : 0;
    default:
      return 0;
  }
}

// ------------------------------------------------------------------ Addon

export const goalsAddon: Addon = {
  id: 'goals',
  name: 'Ziele & Events',
  icon: '🎯',
  version: '0.1.0',
  author: 'Mini',
  description: 'Follower-, Abo-, Bits- und Kanalpunkte-Ziele als Fortschrittsbalken für OBS, dazu eine Leiste mit den letzten Events (Follow, Abo, Cheer, Raid).',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);
    // Gespeicherte Daten auffüllen – ConfigStore ergänzt nur die oberste Ebene
    settings.update({
      goals: (Array.isArray(settings.get('goals')) ? settings.get('goals') : []).map(normalizeGoal),
      recent: { ...DEFAULTS.recent, ...settings.get('recent') },
      stream: { startedAt: settings.get('stream')?.startedAt ?? null, cheerers: settings.get('stream')?.cheerers ?? {} },
      recentStyle: cleanRecentStyle(settings.get('recentStyle')),
    });

    let lastRefresh: number | null = null;
    let refreshError: string | null = null;
    /** Einlösung → Ziele, bei denen sie mitgezählt wurde (für Rückerstattungen) */
    const countedRedemptions = new Map<string, string[]>();

    const goals = () => settings.get('goals');
    const saveGoals = () => settings.set('goals', goals());
    const findGoal = (id: unknown) => {
      const goal = goals().find((g) => g.id === id);
      if (!goal) throw new HttpError(404, 'Ziel nicht gefunden.');
      return goal;
    };

    // -------------------------------------------------------- Ans Overlay schicken

    const publicGoal = (g: Goal) => ({
      id: g.id,
      title: g.title,
      type: g.type,
      value: valueOf(g),
      target: g.target,
      rewardTitle: g.rewardTitle,
      style: g.style,
    });

    /** Top-Cheerer des aktuellen Streams (anonyme Cheers zählen nicht) */
    const topCheer = (cheerers = settings.get('stream').cheerers): RecentEntry | null => {
      let best: RecentEntry | null = null;
      for (const c of Object.values(cheerers)) {
        if (!best || c.bits > best.amount) best = { name: c.name, amount: c.bits, months: 0, at: 0 };
      }
      return best;
    };

    const publicRecent = () => ({ ...settings.get('recent'), topcheer: topCheer() });

    /** Test-Stand (wird nie gespeichert) – null = echter Stand */
    let testGoals: Goal[] | null = null;
    let testRecent: ReturnType<typeof publicRecent> | null = null;
    let testGoalsTimer: NodeJS.Timeout | null = null;
    let testRecentTimer: NodeJS.Timeout | null = null;

    const broadcastGoals = (celebrate: { id: string; target: number }[] = []) => {
      ctx.overlay.broadcast({ kind: 'goals', goals: (testGoals ?? goals()).map(publicGoal), celebrate, test: !!testGoals });
    };
    const broadcastRecent = (changed: RecentKind[] = []) => {
      ctx.overlay.broadcast({ kind: 'recent', recent: testRecent ?? publicRecent(), style: settings.get('recentStyle'), changed, test: !!testRecent });
    };

    /** Echter Wert hat sich geändert → laufenden Test beenden, damit nichts Falsches stehen bleibt */
    const endGoalTest = () => {
      if (testGoalsTimer) clearTimeout(testGoalsTimer);
      testGoalsTimer = null;
      testGoals = null;
    };
    const endRecentTest = () => {
      if (testRecentTimer) clearTimeout(testRecentTimer);
      testRecentTimer = null;
      testRecent = null;
    };
    ctx.onDispose(() => {
      endGoalTest();
      endRecentTest();
    });

    // -------------------------------------------------------- Twitch-Gesamtwerte

    const fetchTotals = async (needFollowers: boolean, needSubs: boolean) => {
      const me = ctx.getUser();
      if (!me) throw new HttpError(401, 'Nicht mit Twitch verbunden.');
      const [followers, subs] = await Promise.all([
        needFollowers
          ? ctx.twitch.request<{ total: number }>('GET', '/channels/followers', { query: { broadcaster_id: me.id, first: '1' } }).then((r) => r.total)
          : null,
        needSubs
          ? ctx.twitch.request<{ total: number }>('GET', '/subscriptions', { query: { broadcaster_id: me.id, first: '1' } })
            .then((r) => r.total)
            // Ohne Affiliate/Partner gibt es keine Abos → 0 statt Fehler
            .catch((err: Error) => (/\b(400|403|404)\b/.test(err.message) ? 0 : Promise.reject(err)))
          : null,
      ]);
      return { followers, subs };
    };

    /** Gesamtwerte von Twitch holen und in die Ziele übernehmen. Ohne Feier (z.B. beim Start). */
    const refresh = async () => {
      const list = goals();
      const needFollowers = list.some((g) => g.type === 'followers' || g.type === 'followersSince');
      const needSubs = list.some((g) => g.type === 'subs');
      if (!needFollowers && !needSubs) return;
      try {
        const totals = await fetchTotals(needFollowers, needSubs);
        for (const g of goals()) {
          const before = valueOf(g);
          if (g.type === 'followers' && totals.followers !== null) g.count = totals.followers;
          else if (g.type === 'subs' && totals.subs !== null) g.count = totals.subs;
          else if (g.type === 'followersSince' && totals.followers !== null) {
            // Beim Zurücksetzen war Twitch nicht erreichbar → Startwert jetzt nachtragen
            if (g.baseline === null) g.baseline = totals.followers - g.count;
            g.count = totals.followers - g.baseline;
          } else continue;
          checkReached(g, before);
        }
        saveGoals();
        lastRefresh = Date.now();
        refreshError = null;
        endGoalTest();
        broadcastGoals();
      } catch (err) {
        refreshError = (err as Error).message;
        ctx.log.warn('Gesamtwerte konnten nicht von Twitch geladen werden:', refreshError);
        throw err;
      }
    };
    const refreshQuietly = () => {
      if (ctx.getUser()) refresh().catch(() => {});
    };

    // -------------------------------------------------------- Zählen

    /** Ziel zurücksetzen (Zähler auf 0, Ziel auf den eingestellten Wert) */
    const resetGoal = async (g: Goal) => {
      g.count = 0;
      g.offset = 0;
      g.baseline = null;
      g.resetAt = Date.now();
      if (g.autoNext) g.target = g.startTarget;
      if (g.type === 'followersSince' && ctx.getUser()) {
        try {
          const { followers } = await fetchTotals(true, false);
          if (followers !== null) g.baseline = followers;
        } catch (err) {
          ctx.log.warn('Follower-Zahl für den Startwert nicht verfügbar:', (err as Error).message);
        }
      }
    };

    /** Stream-Start (per Event oder beim Start der Suite erkannt) */
    const newStream = async (startedAt: string) => {
      const stream = settings.get('stream');
      if (stream.startedAt === startedAt) return;
      settings.set('stream', { startedAt, cheerers: {} });
      const toReset = goals().filter((g) => g.resetOnStream);
      for (const g of toReset) await resetGoal(g);
      if (toReset.length) {
        saveGoals();
        ctx.log.info(`Stream gestartet: ${toReset.length} Ziel(e) zurückgesetzt`);
      }
      endGoalTest();
      broadcastGoals();
      broadcastRecent();
    };

    const countEvent = (event: StreamEvent) => {
      const celebrate: { id: string; target: number }[] = [];
      let changed = false;

      if (event.type === 'redemptionupdate') {
        // Zurückerstattete Einlösungen zählen nicht mehr
        const ids = countedRedemptions.get(event.redemptionId);
        if (event.status !== 'canceled' || !ids) return;
        countedRedemptions.delete(event.redemptionId);
        for (const g of goals()) {
          if (ids.includes(g.id)) {
            g.count -= 1;
            changed = true;
          }
        }
      } else {
        const counted: string[] = [];
        for (const g of goals()) {
          const delta = deltaFor(g, event);
          if (!delta) continue;
          const before = valueOf(g);
          g.count += delta;
          counted.push(g.id);
          changed = true;
          const reached = checkReached(g, before);
          if (reached !== null) {
            celebrate.push({ id: g.id, target: reached });
            ctx.log.info(`🎯 Ziel erreicht: „${g.title}“ (${reached})`);
          }
        }
        if (event.type === 'redemption' && counted.length) {
          countedRedemptions.set(event.redemptionId, counted);
          if (countedRedemptions.size > 1000) countedRedemptions.delete(countedRedemptions.keys().next().value!);
        }
      }

      if (!changed) return;
      saveGoals();
      endGoalTest();
      broadcastGoals(celebrate);
    };

    /** Welche Einträge der „Letzte Events“-Leiste ändert das Event? */
    const recentFromEvent = (event: StreamEvent, recent: Settings['recent'], cheerers: Settings['stream']['cheerers']): RecentKind[] => {
      const now = Date.now();
      switch (event.type) {
        case 'follow':
          recent.follow = { name: event.user.name, amount: 0, months: 0, at: now };
          return ['follow'];
        case 'sub':
          if (event.isGift) return [];
          recent.sub = { name: event.user.name, amount: 0, months: 0, at: now };
          return ['sub'];
        case 'resub':
          recent.sub = { name: event.user.name, amount: 0, months: event.months, at: now };
          return ['sub'];
        case 'giftsub':
          recent.giftsub = { name: event.user?.name ?? 'Anonym', amount: event.count, months: 0, at: now };
          return ['giftsub'];
        case 'raid':
          recent.raid = { name: event.user.name, amount: event.viewers, months: 0, at: now };
          return ['raid'];
        case 'cheer': {
          recent.cheer = { name: event.user?.name ?? 'Anonym', amount: event.bits, months: 0, at: now };
          if (!event.user) return ['cheer'];
          const topBefore = topCheer(cheerers)?.name;
          const c = cheerers[event.user.id] ?? { name: event.user.name, bits: 0 };
          cheerers[event.user.id] = { name: event.user.name, bits: c.bits + event.bits };
          return topCheer(cheerers)?.name !== topBefore || topBefore === event.user.name ? ['cheer', 'topcheer'] : ['cheer'];
        }
        default:
          return [];
      }
    };

    const onEvent = (event: StreamEvent) => {
      if (event.test) {
        testEvent(event);
        return;
      }
      if (event.type === 'streamonline') {
        void newStream(event.startedAt);
        return;
      }
      countEvent(event);
      const recent = settings.get('recent');
      const stream = settings.get('stream');
      const changed = recentFromEvent(event, recent, stream.cheerers);
      if (changed.length) {
        settings.update({ recent, stream });
        endRecentTest();
        broadcastRecent(changed);
      }
    };

    // -------------------------------------------------------- Tests (nie gespeichert)

    /** Test-Event: Overlays zeigen es kurz, danach wieder den echten Stand */
    const testEvent = (event: StreamEvent) => {
      // Ziele
      testGoals ??= structuredClone(goals());
      const celebrate: { id: string; target: number }[] = [];
      let goalsChanged = false;
      for (const g of testGoals) {
        const delta = deltaFor(g, event);
        if (!delta) continue;
        const before = valueOf(g);
        g.count += delta;
        goalsChanged = true;
        const reached = checkReached(g, before);
        if (reached !== null) celebrate.push({ id: g.id, target: reached });
      }
      if (goalsChanged) {
        broadcastGoals(celebrate);
        if (testGoalsTimer) clearTimeout(testGoalsTimer);
        testGoalsTimer = setTimeout(() => {
          endGoalTest();
          broadcastGoals();
        }, TEST_SHOW_MS);
      } else if (!testGoalsTimer) testGoals = null;

      // Letzte Events
      testRecent ??= structuredClone(publicRecent());
      const { topcheer: _top, ...recent } = testRecent;
      const cheerers = structuredClone(settings.get('stream').cheerers);
      const changed = recentFromEvent(event, recent, cheerers);
      if (!changed.length) {
        if (!testRecentTimer) testRecent = null;
        return;
      }
      // Beim Test den Test-Cheerer direkt als Top-Cheerer zeigen, damit man etwas sieht
      testRecent = { ...recent, topcheer: event.type === 'cheer' ? { name: event.user?.name ?? 'Anonym', amount: event.bits, months: 0, at: Date.now() } : testRecent.topcheer };
      if (event.type === 'cheer' && !changed.includes('topcheer')) changed.push('topcheer');
      broadcastRecent(changed);
      if (testRecentTimer) clearTimeout(testRecentTimer);
      testRecentTimer = setTimeout(() => {
        endRecentTest();
        broadcastRecent();
      }, TEST_SHOW_MS);
    };

    for (const type of ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'redemption', 'redemptionupdate', 'streamonline'] as StreamEventType[]) {
      ctx.events.on(type, onEvent);
    }

    // -------------------------------------------------------- API: Zustand

    const uiGoal = (g: Goal) => ({ ...g, value: valueOf(g) });

    ctx.api.get('/state', () => ({
      goals: goals().map(uiGoal),
      recent: publicRecent(),
      recentStyle: settings.get('recentStyle'),
      streamStartedAt: settings.get('stream').startedAt,
      loggedIn: !!ctx.getUser(),
      lastRefresh,
      refreshError,
      fonts: FONTS,
      defaults: { style: DEFAULT_STYLE, recentStyle: DEFAULT_RECENT_STYLE },
    }));

    ctx.api.get('/overlay-state', () => ({
      kind: 'state',
      goals: (testGoals ?? goals()).map(publicGoal),
      recent: testRecent ?? publicRecent(),
      recentStyle: settings.get('recentStyle'),
    }));

    ctx.api.post('/refresh', async () => {
      try {
        await refresh();
      } catch (err) {
        if (err instanceof HttpError) throw err;
        throw new HttpError(502, `Twitch: ${(err as Error).message}`);
      }
      return { goals: goals().map(uiGoal), lastRefresh };
    });

    /** Belohnungen des Kanals für die Auswahl bei „Kanalpunkte-Einlösungen“ */
    ctx.api.get('/rewards', async () => {
      const me = ctx.getUser();
      if (!me) throw new HttpError(401, 'Bitte zuerst in der Übersicht mit Twitch verbinden.');
      const res = await ctx.twitch
        .request<{ data: { id: string; title: string; cost: number }[] }>('GET', '/channel_points/custom_rewards', { query: { broadcaster_id: me.id } })
        .catch((err: Error) => {
          // Ohne Affiliate/Partner gibt es keine Kanalpunkte
          throw new HttpError(502, `Belohnungen nicht verfügbar: ${err.message}`);
        });
      return res.data.map((r) => ({ id: r.id, title: r.title, cost: r.cost })).sort((a, b) => a.cost - b.cost);
    });

    // -------------------------------------------------------- API: Ziele bearbeiten

    ctx.api.post('/goals/create', async ({ body }) => {
      if (goals().length >= MAX_GOALS) throw new HttpError(400, `Höchstens ${MAX_GOALS} Ziele.`);
      const type = pick(body?.type, GOAL_TYPES, 'followersSince');
      // Neues Ziel übernimmt das Aussehen des letzten, damit alles zusammenpasst
      const last = goals()[goals().length - 1];
      const goal = normalizeGoal({ type, title: DEFAULT_TITLES[type], target: type === 'bits' ? 1000 : type === 'followers' || type === 'subs' ? 100 : 10, style: last?.style });
      await resetGoal(goal);
      settings.set('goals', [...goals(), goal]);
      if (TWITCH_TYPES.includes(type) && ctx.getUser()) await refresh().catch(() => {});
      // Gesamt-Ziel schon überschritten (z.B. 123 Follower, Ziel 100) → nächstes sinnvolles Ziel vorschlagen
      if (valueOf(goal) >= goal.target) {
        goal.target = goal.startTarget = niceTarget(valueOf(goal));
        saveGoals();
      }
      endGoalTest();
      broadcastGoals();
      return uiGoal(goal);
    });

    ctx.api.post('/goals/save', async ({ body }) => {
      const input = body?.goal ?? {};
      const g = findGoal(input.id);
      const type = pick(input.type, GOAL_TYPES, g.type);
      const typeChanged = type !== g.type;
      const rewardChanged = type === 'redemptions' && String(input.rewardId ?? '') !== g.rewardId;
      g.title = oneLine(input.title ?? g.title, 80);
      g.type = type;
      g.rewardId = String(input.rewardId ?? g.rewardId).slice(0, 100);
      g.rewardTitle = oneLine(input.rewardTitle ?? g.rewardTitle, 100);
      const startTarget = int(input.startTarget ?? g.startTarget, 1, MAX_VALUE);
      if (startTarget !== g.startTarget) {
        // Ziel von Hand geändert → gilt ab sofort
        g.startTarget = startTarget;
        g.target = startTarget;
      }
      g.autoNext = bool(input.autoNext, g.autoNext);
      g.step = int(input.step ?? g.step, 1, MAX_VALUE);
      g.countResubs = bool(input.countResubs, g.countResubs);
      g.resetOnStream = bool(input.resetOnStream, g.resetOnStream);
      g.style = cleanStyle(input.style, g.style);
      // Andere Art oder andere Belohnung → neu anfangen zu zählen
      if (typeChanged || rewardChanged) await resetGoal(g);
      // Ziel liegt schon unter dem Stand → gleich das nächste nehmen (ohne Feier)
      if (g.autoNext && valueOf(g) >= g.target) checkReached(g, g.target - 1);
      saveGoals();
      if (typeChanged && TWITCH_TYPES.includes(type) && ctx.getUser()) await refresh().catch(() => {});
      endGoalTest();
      broadcastGoals();
      return uiGoal(g);
    });

    ctx.api.post('/goals/delete', ({ body }) => {
      settings.set('goals', goals().filter((g) => g.id !== body?.id));
      broadcastGoals();
    });

    ctx.api.post('/goals/move', ({ body }) => {
      const list = goals();
      const i = list.findIndex((g) => g.id === body?.id);
      const j = i + (body?.direction === 'up' ? -1 : 1);
      if (i < 0 || j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      saveGoals();
    });

    /** Aussehen eines Ziels auf alle anderen übertragen */
    ctx.api.post('/goals/copy-style', ({ body }) => {
      const source = findGoal(body?.id);
      for (const g of goals()) g.style = structuredClone(source.style);
      saveGoals();
      broadcastGoals();
      return goals().map(uiGoal);
    });

    /** Stand von Hand ändern: +/- (delta) oder fester Wert (value) */
    ctx.api.post('/goals/adjust', ({ body }) => {
      const g = findGoal(body?.id);
      const before = valueOf(g);
      if (body?.value !== undefined) g.offset = int(body.value, 0, MAX_VALUE) - g.count;
      else g.offset += int(body?.delta, -MAX_VALUE, MAX_VALUE);
      const reached = checkReached(g, before);
      saveGoals();
      endGoalTest();
      broadcastGoals(reached !== null ? [{ id: g.id, target: reached }] : []);
      return uiGoal(g);
    });

    ctx.api.post('/goals/reset', async ({ body }) => {
      const g = findGoal(body?.id);
      await resetGoal(g);
      saveGoals();
      if (g.type === 'followers' || g.type === 'subs') await refresh().catch(() => {});
      endGoalTest();
      broadcastGoals();
      return uiGoal(g);
    });

    /** Overlay testen: ein Schritt dazu oder direkt bis zum Ziel (Feier). Wird nicht gespeichert. */
    ctx.api.post('/goals/test', ({ body }) => {
      const g = findGoal(body?.id);
      let t = testGoals?.find((x) => x.id === g.id);
      if (!t) {
        testGoals = structuredClone(goals());
        t = testGoals.find((x) => x.id === g.id)!;
      }
      const before = valueOf(t);
      t.count += body?.celebrate === true ? Math.max(1, t.target - before) : g.type === 'bits' ? 100 : 1;
      const reached = checkReached(t, before);
      broadcastGoals(reached !== null ? [{ id: t.id, target: reached }] : []);
      if (testGoalsTimer) clearTimeout(testGoalsTimer);
      testGoalsTimer = setTimeout(() => {
        endGoalTest();
        broadcastGoals();
      }, TEST_SHOW_MS);
    });

    // -------------------------------------------------------- API: Letzte Events

    ctx.api.post('/recent/style', ({ body }) => {
      settings.set('recentStyle', cleanRecentStyle(body?.style, settings.get('recentStyle')));
      broadcastRecent();
      return settings.get('recentStyle');
    });

    /** Einträge leeren: einer (kind) oder alle; "topcheer" setzt die Bits des Streams zurück */
    ctx.api.post('/recent/clear', ({ body }) => {
      const kind = body?.kind as RecentKind | undefined;
      const recent = settings.get('recent');
      if (!kind || kind === 'topcheer') settings.set('stream', { ...settings.get('stream'), cheerers: {} });
      for (const k of Object.keys(recent) as (keyof Settings['recent'])[]) {
        if (!kind || k === kind) recent[k] = null;
      }
      settings.set('recent', recent);
      endRecentTest();
      broadcastRecent();
      return publicRecent();
    });

    /** Beispiel-Events für die Leiste (nicht gespeichert) */
    ctx.api.post('/recent/test', ({ body }) => {
      const types: StreamEventType[] = RECENT_KINDS.includes(body?.kind) ? [body.kind === 'topcheer' ? 'cheer' : body.kind] : ['follow', 'sub', 'cheer', 'raid', 'giftsub'];
      for (const type of types) {
        const event = makeTestEvent(type);
        // Nur die Leiste, die Ziele bleiben unberührt
        testRecent ??= structuredClone(publicRecent());
        const { topcheer: _top, ...recent } = testRecent;
        const changed = recentFromEvent(event, recent, {});
        testRecent = { ...recent, topcheer: type === 'cheer' ? { name: 'TestUser', amount: 500, months: 0, at: Date.now() } : testRecent.topcheer };
        if (type === 'cheer') changed.push('topcheer');
        broadcastRecent(changed);
      }
      if (testRecentTimer) clearTimeout(testRecentTimer);
      testRecentTimer = setTimeout(() => {
        endRecentTest();
        broadcastRecent();
      }, TEST_SHOW_MS);
    });

    // -------------------------------------------------------- Start: Gesamtwerte laden, Stream-Start erkennen

    let tries = 0;
    let startup: NodeJS.Timeout | null = null;
    const init = async () => {
      if (!ctx.getUser()) {
        // Noch nicht eingeloggt → eine Weile immer wieder schauen
        if (++tries < 60) startup = setTimeout(init, 2000);
        return;
      }
      refreshQuietly();
      // Läuft der Stream schon (Suite erst danach gestartet)? → Stream-Start nachholen
      try {
        const me = ctx.getUser()!;
        const res = await ctx.twitch.request<{ data: { started_at: string }[] }>('GET', '/streams', { query: { user_id: me.id } });
        if (res.data[0]?.started_at) await newStream(res.data[0].started_at);
      } catch {
        // egal – dann eben beim nächsten streamonline-Event
      }
    };
    startup = setTimeout(init, 1500);
    const interval = setInterval(refreshQuietly, REFRESH_EVERY_MS);
    ctx.onDispose(() => {
      if (startup) clearTimeout(startup);
      clearInterval(interval);
    });
  },
};
