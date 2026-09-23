import type { Addon, AddonContext } from '../../core/addons';
import { HttpError } from '../../core/server';
import { makeTestEvent, type ChatFragment, type StreamEvent } from '../../core/twitch/events';
import { DEFAULTS, ROLE_LEVEL, applyPatch, sanitize, type EventKind, type Settings } from './settings';

// ------------------------------------------------------------------ Datenmodell

/** Schnittstelle des Alerts-Addons (siehe alerts/index.ts) */
interface AlertsService {
  rewardAllowed(id: string): boolean;
  replay(event: StreamEvent): Promise<{ shown: boolean; variant?: string }>;
  setPaused(paused: boolean): AlertsStatus;
  skip(): void;
  status(): AlertsStatus;
}
interface AlertsStatus {
  paused: boolean;
  /** So viele Alerts warten, bis die Pause vorbei ist */
  held: number;
}

/** Events, zu denen es Alerts gibt – die bekommen im Chat-Fenster ein ▶ */
const REPLAYABLE: StreamEvent['type'][] = ['follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'redemption', 'hypetrain'];

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
    /** Kann im Chat-Fenster als Alert nochmal abgespielt werden */
    replay?: boolean;
  };

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
  version: '0.2.0',
  author: 'Mini',
  description: 'Chat für OBS mit Emotes, Markdown und Farben, dazu ein eigenes Chat-Fenster wie Chatterino mit Events.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    // Ohne Standardwerte laden: sanitize() füllt auf und übernimmt dabei alte Einstellungen (bis v0.5)
    const store = ctx.settings<Partial<Settings>>({});
    let settings = sanitize(store.all());
    const history: ChatItem[] = [];
    let assets: Assets | null = null;
    let assetsLoading: Promise<Assets> | null = null;

    const alertsService = () => ctx.use<AlertsService>('alerts');
    /** Events zu den Einträgen im Chat, damit das Chat-Fenster sie als Alert nochmal abspielen kann */
    const eventsById = new Map<string, StreamEvent>();
    /** Belohnung ist im Alert-Filter stumm? Ob sie deshalb versteckt wird, entscheiden Overlay und Fenster selbst */
    const rewardHidden = (rewardId: string | null) => !!rewardId && alertsService()?.rewardAllowed(rewardId) === false;

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

    /** Letztes Level des laufenden Hype Trains – nur ein Level-Aufstieg kommt in den Chat, nicht jeder Zwischenstand */
    let hypeLevel = 0;

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
        case 'hypetrain': {
          const golden = event.trainType === 'golden_kappa' ? ' (Golden Kappa!)' : '';
          if (event.phase === 'begin') {
            hypeLevel = event.level;
            return { ...base, event: 'hypetrain', icon: '🚂', user: '', text: `Der Hype Train fährt los${golden}!`, detail: '' };
          }
          if (event.phase === 'end') {
            hypeLevel = 0;
            return { ...base, event: 'hypetrain', icon: '🚂', user: '', text: `Hype Train beendet: Level ${event.level} erreicht!`, detail: '' };
          }
          if (event.level <= hypeLevel) return null;
          hypeLevel = event.level;
          return { ...base, event: 'hypetrain', icon: '🚂', user: '', text: `Hype Train erreicht Level ${event.level}!`, detail: '' };
        }
        case 'prediction': {
          if (event.phase === 'progress') return null;
          const winner = event.outcomes.find((o) => o.id === event.winningOutcomeId);
          const text = {
            begin: `Vorhersage gestartet: „${event.title}“`,
            lock: `Vorhersage gesperrt: „${event.title}“`,
            end: event.status === 'resolved' && winner ? `Vorhersage aufgelöst: „${winner.title}“ gewinnt!` : `Vorhersage abgebrochen: „${event.title}“`,
          }[event.phase];
          return { ...base, event: 'prediction', icon: '🔮', user: '', text, detail: '' };
        }
        case 'shoutout':
          return { ...base, event: 'shoutout', icon: '📣', user: event.to.name, text: 'Shoutout an {user}!', detail: '' };
        case 'adbreak':
          return { ...base, event: 'ads', icon: '📺', user: '', text: `Werbung läuft (${event.durationSeconds} Sek.)`, detail: '' };
        case 'streamonline':
          return { ...base, event: 'stream', icon: '🔴', user: '', text: 'Der Stream ist live!', detail: '' };
        case 'streamoffline':
          return { ...base, event: 'stream', icon: '⚫', user: '', text: 'Der Stream ist beendet.', detail: '' };
        default:
          return null;
      }
    };

    /** Event-Eintrag in den Chat, bei Alert-Events mit ▶ zum nochmal Abspielen */
    const pushEvent = (event: StreamEvent) => {
      const item = eventItem(event);
      if (!item || item.kind !== 'event') return;
      if (REPLAYABLE.includes(event.type)) {
        item.replay = true;
        eventsById.set(item.id, event);
        if (eventsById.size > 200) eventsById.delete(eventsById.keys().next().value!);
      }
      push(item);
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
            own: ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(event.user.id),
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
        default:
          pushEvent(event);
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

    /** { patch, source }: nur die geänderten Werte, source = welche Seite gespeichert hat */
    ctx.api.post('/settings', ({ body }) => {
      const emotesBefore = JSON.stringify(settings.emotes);
      settings = applyPatch(settings, body?.patch ?? body?.settings);
      store.update(settings);
      ctx.overlay.broadcast({ kind: 'settings', source: typeof body?.source === 'string' ? body.source : null });
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

    // -------------------------------------------------------- Alerts aus dem Chat-Fenster steuern

    const alerts = () => {
      const service = alertsService();
      if (!service) throw new HttpError(409, 'Das Alerts-Addon ist aus.');
      return service;
    };

    /** { id } → Alert zu einem Event aus dem Chat nochmal abspielen */
    ctx.api.post('/replay', async ({ body }) => {
      const event = eventsById.get(String(body?.id));
      if (!event) throw new HttpError(404, 'Das Event ist zu alt, um es nochmal abzuspielen.');
      return alerts().replay(event);
    });

    ctx.api.get('/alerts', () => alertsService()?.status() ?? null);
    ctx.api.post('/alerts/pause', ({ body }) => alerts().setPaused(body?.paused === true));
    ctx.api.post('/alerts/skip', () => alerts().skip());

    /** Nachricht aus dem Chat-Fenster senden */
    ctx.api.post('/send', async ({ body }) => {
      const message = String(body?.message ?? '').trim();
      if (!message) throw new HttpError(400, 'Leere Nachricht');
      if (!ctx.getUser()) throw new HttpError(401, 'Nicht bei Twitch eingeloggt');
      // Aus dem Chat-Fenster schreibst du selbst, nicht der Bot
      await ctx.chat.send(message, { replyTo: typeof body?.replyTo === 'string' ? body.replyTo : undefined, as: 'broadcaster' });
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
