import type { Addon, AddonContext } from '../../core/addons';
import { HttpError } from '../../core/server';
import { makeTestEvent, type ChatFragment, type StreamEvent } from '../../core/twitch/events';

// ------------------------------------------------------------------ Datenmodell

const EVENT_KINDS = ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'redemption', 'stream'] as const;
type EventKind = (typeof EVENT_KINDS)[number];
const ROLES = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'] as const;
type Role = (typeof ROLES)[number];
const ROLE_LEVEL: Record<Role, number> = { everyone: 0, subscriber: 1, vip: 2, moderator: 3, broadcaster: 4 };

const allEvents = (on: boolean) => Object.fromEntries(EVENT_KINDS.map((k) => [k, on])) as Record<EventKind, boolean>;

interface Settings {
  /** Markdown (**fett**, *kursiv* …) ab welcher Rolle */
  markdown: { enabled: boolean; minRole: Role };
  /** Farben ([rot]Text[/]) ab welcher Rolle */
  colors: { enabled: boolean; minRole: Role };
  /** Emotes von Drittanbietern */
  emotes: { seventv: boolean; bttv: boolean; ffz: boolean };
  /** Kanalpunkte-Einlösungen, die im Alert-Filter stumm sind, im Overlay verstecken */
  respectAlertFilter: boolean;
  overlay: {
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
    showBadges: boolean;
    hideCommands: boolean;
    /** Logins, deren Nachrichten nicht angezeigt werden (z.B. Bots) */
    hiddenUsers: string[];
    events: Record<EventKind, boolean>;
  };
  window: {
    fontSize: number;
    timestamps: boolean;
    showBadges: boolean;
    alternateBackground: boolean;
    highlightMentions: boolean;
    highlightWords: string[];
    hideCommands: boolean;
    events: Record<EventKind, boolean>;
  };
}

const DEFAULTS: Settings = {
  markdown: { enabled: true, minRole: 'everyone' },
  colors: { enabled: true, minRole: 'subscriber' },
  emotes: { seventv: true, bttv: true, ffz: true },
  respectAlertFilter: true,
  overlay: {
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
    showBadges: true,
    hideCommands: true,
    hiddenUsers: ['nightbot', 'streamelements', 'streamlabs', 'moobot', 'fossabot', 'wizebot'],
    events: { ...allEvents(true), stream: false },
  },
  window: {
    fontSize: 14,
    timestamps: true,
    showBadges: true,
    alternateBackground: true,
    highlightMentions: true,
    highlightWords: [],
    hideCommands: false,
    events: allEvents(true),
  },
};

/** Ein Eintrag im Chat: Nachricht oder Event */
type ChatItem =
  | {
    kind: 'message';
    id: string;
    time: number;
    user: { id: string; login: string; name: string };
    color: string;
    badges: { set: string; id: string }[];
    level: number;
    fragments: ChatFragment[];
    rewardId: string | null;
    /** Gehört zu einer Belohnung, die im Alert-Filter stumm ist */
    hiddenReward: boolean;
    highlighted: boolean;
    replyTo: string | null;
    own: boolean;
    test: boolean;
  }
  | {
    kind: 'event';
    id: string;
    time: number;
    event: EventKind;
    icon: string;
    /** Text mit {user}-Platzhalter, damit der Name hervorgehoben werden kann */
    text: string;
    user: string;
    detail: string;
    hiddenReward: boolean;
    test: boolean;
  };

// ------------------------------------------------------------------ Einstellungen prüfen

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

function sanitize(input: unknown): Settings {
  const s = mergeTyped(DEFAULTS, input);
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));
  const hex = (v: string, fallback: string) => (/^#[0-9a-f]{6}$/i.test(v) ? v.toUpperCase() : fallback);
  const oneOf = <T extends string>(v: string, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback);

  s.markdown.minRole = oneOf(s.markdown.minRole, ROLES, 'everyone');
  s.colors.minRole = oneOf(s.colors.minRole, ROLES, 'subscriber');
  const o = s.overlay;
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
  o.hiddenUsers = [...new Set(o.hiddenUsers.map((u) => u.toLowerCase().replace(/^@/, '')))];
  o.font = o.font.slice(0, 60) || DEFAULTS.overlay.font;
  const w = s.window;
  w.fontSize = clamp(w.fontSize, 10, 30);
  w.highlightWords = [...new Set(w.highlightWords.map((x) => x.toLowerCase()).filter((x) => x.length <= 40))];
  return s;
}

// ------------------------------------------------------------------ Emotes & Abzeichen

interface Assets {
  badges: Record<string, Record<string, string>>;
  emotes: Record<string, string>;
  broadcaster: string;
  loadedAt: number;
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Emotes von 7TV, BTTV und FFZ (öffentliche Schnittstellen, kein Login nötig) */
async function loadThirdPartyEmotes(userId: string, enabled: Settings['emotes']): Promise<Record<string, string>> {
  const emotes: Record<string, string> = {};
  const jobs: Promise<void>[] = [];

  if (enabled.ffz) {
    type FfzSet = { emoticons: { name: string; urls: Record<string, string> }[] };
    const addFfz = (sets: Record<string, FfzSet> | undefined) => {
      for (const set of Object.values(sets ?? {})) {
        for (const e of set.emoticons ?? []) {
          const url = e.urls['2'] ?? e.urls['1'];
          if (url) emotes[e.name] = url.startsWith('//') ? `https:${url}` : url;
        }
      }
    };
    jobs.push(getJson<{ default_sets: number[]; sets: Record<string, FfzSet> }>('https://api.frankerfacez.com/v1/set/global').then((d) => {
      if (d) addFfz(Object.fromEntries(Object.entries(d.sets).filter(([id]) => d.default_sets.includes(Number(id)))));
    }));
    jobs.push(getJson<{ sets: Record<string, FfzSet> }>(`https://api.frankerfacez.com/v1/room/id/${userId}`).then((d) => addFfz(d?.sets)));
  }

  if (enabled.bttv) {
    type BttvEmote = { id: string; code: string };
    const addBttv = (list: BttvEmote[] | undefined) => {
      for (const e of list ?? []) emotes[e.code] = `https://cdn.betterttv.net/emote/${e.id}/2x`;
    };
    jobs.push(getJson<BttvEmote[]>('https://api.betterttv.net/3/cached/emotes/global').then((d) => addBttv(d ?? [])));
    jobs.push(getJson<{ channelEmotes: BttvEmote[]; sharedEmotes: BttvEmote[] }>(`https://api.betterttv.net/3/cached/users/twitch/${userId}`)
      .then((d) => addBttv([...(d?.channelEmotes ?? []), ...(d?.sharedEmotes ?? [])])));
  }

  if (enabled.seventv) {
    type SevenEmote = { name: string; data: { host: { url: string } } };
    const add7tv = (list: SevenEmote[] | undefined) => {
      for (const e of list ?? []) if (e.data?.host?.url) emotes[e.name] = `https:${e.data.host.url}/2x.webp`;
    };
    jobs.push(getJson<{ emotes: SevenEmote[] }>('https://7tv.io/v3/emote-sets/global').then((d) => add7tv(d?.emotes)));
    jobs.push(getJson<{ emote_set: { emotes: SevenEmote[] } | null }>(`https://7tv.io/v3/users/twitch/${userId}`).then((d) => add7tv(d?.emote_set?.emotes)));
  }

  await Promise.all(jobs);
  return emotes;
}

// ------------------------------------------------------------------ Addon

export const chatAddon: Addon = {
  id: 'chat',
  name: 'Chat-Overlay & Fenster',
  icon: '🗨️',
  version: '0.1.0',
  author: 'Mini',
  description: 'Chat für OBS mit Emotes, Markdown und Farben, dazu ein eigenes Chat-Fenster wie Chatterino mit Events.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const store = ctx.settings<Settings>(DEFAULTS);
    let settings = sanitize(store.all());
    const history: ChatItem[] = [];
    let assets: Assets | null = null;
    let assetsLoading: Promise<Assets> | null = null;

    const alertsService = () => ctx.use<{ rewardAllowed(id: string): boolean }>('alerts');
    const rewardHidden = (rewardId: string | null) =>
      !!rewardId && settings.respectAlertFilter && alertsService()?.rewardAllowed(rewardId) === false;

    const push = (item: ChatItem) => {
      history.push(item);
      if (history.length > 200) history.shift();
      ctx.overlay.broadcast({ kind: 'item', item });
    };

    const levelOf = (badges: string[], userId: string) => {
      if (userId === ctx.getUser()?.id || badges.includes('broadcaster')) return ROLE_LEVEL.broadcaster;
      if (badges.includes('moderator') || badges.includes('lead_moderator')) return ROLE_LEVEL.moderator;
      if (badges.includes('vip')) return ROLE_LEVEL.vip;
      if (badges.includes('subscriber') || badges.includes('founder')) return ROLE_LEVEL.subscriber;
      return ROLE_LEVEL.everyone;
    };

    const eventItem = (event: StreamEvent): ChatItem | null => {
      const base = { kind: 'event' as const, id: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, time: Date.now(), test: !!event.test, hiddenReward: false };
      const name = 'user' in event && event.user ? event.user.name : 'Anonym';
      const tier = (t: string) => ({ '1000': '1', '2000': '2', '3000': '3' }[t] ?? t);
      switch (event.type) {
        case 'follow':
          return { ...base, event: 'follow', icon: '💜', user: name, text: '{user} folgt jetzt!', detail: '' };
        case 'sub':
          if (event.isGift) return null;
          return { ...base, event: 'sub', icon: '⭐', user: name, text: `{user} hat abonniert (Tier ${tier(event.tier)})`, detail: '' };
        case 'resub':
          return { ...base, event: 'resub', icon: '⭐', user: name, text: `{user} ist seit ${event.months} Monaten dabei (Tier ${tier(event.tier)})`, detail: event.message };
        case 'giftsub':
          return { ...base, event: 'giftsub', icon: '🎁', user: name, text: `{user} verschenkt ${event.count} ${event.count === 1 ? 'Abo' : 'Abos'}!`, detail: '' };
        case 'cheer':
          return { ...base, event: 'cheer', icon: '💎', user: name, text: `{user} cheert ${event.bits} Bits`, detail: event.message };
        case 'raid':
          return { ...base, event: 'raid', icon: '🚀', user: name, text: `{user} raidet mit ${event.viewers} Leuten!`, detail: '' };
        case 'redemption':
          return {
            ...base,
            event: 'redemption',
            icon: '✨',
            user: name,
            text: `{user} löst „${event.reward.title}“ ein (${event.reward.cost.toLocaleString('de-DE')})`,
            detail: event.input,
            hiddenReward: rewardHidden(event.reward.id),
          };
        case 'streamonline':
          return { ...base, event: 'stream', icon: '🔴', user: '', text: 'Der Stream ist live!', detail: '' };
        case 'streamoffline':
          return { ...base, event: 'stream', icon: '⚫', user: '', text: 'Der Stream ist beendet.', detail: '' };
        default:
          return null;
      }
    };

    ctx.events.onAny((event) => {
      switch (event.type) {
        case 'chat':
          push({
            kind: 'message',
            id: event.messageId,
            time: Date.now(),
            user: { id: event.user.id, login: event.user.login, name: event.user.name },
            color: event.color,
            badges: event.badgeInfo,
            level: levelOf(event.badges, event.user.id),
            fragments: event.fragments.length ? event.fragments : [{ type: 'text', text: event.message }],
            rewardId: event.rewardId,
            hiddenReward: rewardHidden(event.rewardId),
            highlighted: event.messageType === 'channel_points_highlighted',
            replyTo: event.replyTo,
            own: ctx.chat.isOwnMessage(event.messageId),
            test: !!event.test,
          });
          return;
        case 'chatdelete':
          ctx.overlay.broadcast({ kind: 'delete', id: event.messageId });
          for (const item of history) if (item.id === event.messageId) (item as ChatItem & { deleted?: boolean }).deleted = true;
          return;
        case 'chatclear':
          ctx.overlay.broadcast({ kind: 'clear', userId: event.userId });
          for (const item of history) {
            if (item.kind === 'message' && (!event.userId || item.user.id === event.userId)) (item as ChatItem & { deleted?: boolean }).deleted = true;
          }
          return;
        default: {
          const item = eventItem(event);
          if (item) push(item);
        }
      }
    });

    const loadAssets = async (force = false): Promise<Assets> => {
      if (assets && !force && Date.now() - assets.loadedAt < 30 * 60_000) return assets;
      assetsLoading ??= (async () => {
        const user = ctx.getUser();
        const badges: Assets['badges'] = {};
        let emotes: Record<string, string> = {};
        if (user) {
          type BadgeRes = { data: { set_id: string; versions: { id: string; image_url_2x: string }[] }[] };
          const [global, channel] = await Promise.all([
            ctx.twitch.request<BadgeRes>('GET', '/chat/badges/global').catch(() => ({ data: [] })),
            ctx.twitch.request<BadgeRes>('GET', '/chat/badges', { query: { broadcaster_id: user.id } }).catch(() => ({ data: [] })),
          ]);
          // Kanal-Abzeichen (z.B. eigene Sub-Abzeichen) überschreiben die globalen
          for (const set of [...global.data, ...channel.data]) {
            badges[set.set_id] ??= {};
            for (const v of set.versions) badges[set.set_id][v.id] = v.image_url_2x;
          }
          emotes = await loadThirdPartyEmotes(user.id, settings.emotes);
        }
        assets = { badges, emotes, broadcaster: user?.login ?? '', loadedAt: Date.now() };
        ctx.log.info(`Abzeichen und ${Object.keys(emotes).length} Drittanbieter-Emotes geladen`);
        return assets;
      })().finally(() => {
        assetsLoading = null;
      });
      return assetsLoading;
    };

    // -------------------------------------------------------- API

    ctx.api.get('/settings', () => settings);

    ctx.api.post('/settings', ({ body }) => {
      const emotesBefore = JSON.stringify(settings.emotes);
      settings = sanitize(body?.settings);
      store.update(settings);
      ctx.overlay.broadcast({ kind: 'settings' });
      if (JSON.stringify(settings.emotes) !== emotesBefore) {
        void loadAssets(true).then(() => ctx.overlay.broadcast({ kind: 'assets' })).catch(() => {});
      }
      return settings;
    });

    ctx.api.get('/defaults', () => DEFAULTS);

    ctx.api.get('/assets', () => loadAssets());

    ctx.api.post('/assets/reload', async () => {
      const a = await loadAssets(true);
      ctx.overlay.broadcast({ kind: 'assets' });
      return { emotes: Object.keys(a.emotes).length };
    });

    ctx.api.get('/history', () => history);

    /** Nachricht aus dem Chat-Fenster senden */
    ctx.api.post('/send', async ({ body }) => {
      const message = String(body?.message ?? '').trim();
      if (!message) throw new HttpError(400, 'Leere Nachricht');
      if (!ctx.getUser()) throw new HttpError(401, 'Nicht bei Twitch eingeloggt');
      await ctx.chat.send(message, typeof body?.replyTo === 'string' ? body.replyTo : undefined);
    });

    /** Test-Nachricht bzw. Test-Event durch das ganze System schicken */
    ctx.api.post('/test', ({ body }) => {
      const type = body?.type === 'event' ? 'sub' : 'chat';
      ctx.events.emit(makeTestEvent(type));
    });

    // -------------------------------------------------------- Chat-Fenster

    ctx.api.post('/window/open', () => {
      ctx.windows.open('window', 'window.html', { title: 'Chat – Mini\'s Stream Suite', width: 420, height: 720 });
    });

    ctx.api.get('/window/state', () => ({ open: ctx.windows.isOpen('window'), onTop: ctx.windows.isAlwaysOnTop('window') }));

    ctx.api.post('/window/pin', ({ body }) => {
      ctx.windows.setAlwaysOnTop('window', body?.on === true);
      return { onTop: ctx.windows.isAlwaysOnTop('window') };
    });

    // Abzeichen & Emotes vorladen, sobald eingeloggt
    let tries = 0;
    let preload: NodeJS.Timeout | null = null;
    const tryPreload = () => {
      if (ctx.getUser()) {
        void loadAssets().then(() => ctx.overlay.broadcast({ kind: 'assets' })).catch(() => {});
        return;
      }
      if (++tries < 30) preload = setTimeout(tryPreload, 2000);
    };
    preload = setTimeout(tryPreload, 1500);
    ctx.onDispose(() => {
      if (preload) clearTimeout(preload);
    });
  },
};
