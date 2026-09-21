import { randomUUID } from 'node:crypto';
import type { Addon } from '../../core/addons';
import { HttpError } from '../../core/server';
import { makeTestEvent, type StreamEvent } from '../../core/twitch/events';

const ALERT_TYPES = ['redemption', 'follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid'] as const;
type AlertType = (typeof ALERT_TYPES)[number];

interface RewardSetting {
  alert: boolean;
  /** Nur zur Info in der Datei, damit man sieht, welche Belohnung gemeint ist */
  title: string;
}

interface AlertSettings {
  enabled: Record<AlertType, boolean>;
  templates: Record<AlertType, string>;
  durationMs: number;
  sound: boolean;
  minBits: number;
  minRaiders: number;
  /** Alert für Belohnungen ohne eigene Einstellung (auch neu angelegte) */
  newRewardDefault: boolean;
  /** Eigene Einstellung pro Belohnung (Reward-ID → Einstellung) */
  rewards: Record<string, RewardSetting>;
}

const DEFAULTS: AlertSettings = {
  enabled: { redemption: true, follow: true, sub: true, resub: true, giftsub: true, cheer: true, raid: true },
  templates: {
    redemption: '{user} hat „{reward}“ eingelöst!',
    follow: '{user} folgt jetzt!',
    sub: '{user} hat abonniert!',
    resub: '{user} ist seit {months} Monaten dabei!',
    giftsub: '{user} verschenkt {count} Abos!',
    cheer: '{user} cheert {bits} Bits!',
    raid: '{user} raidet mit {viewers} Leuten!',
  },
  durationMs: 5000,
  sound: true,
  minBits: 1,
  minRaiders: 1,
  newRewardDefault: true,
  rewards: {},
};

interface HelixReward {
  id: string;
  title: string;
  cost: number;
  is_enabled: boolean;
  is_paused: boolean;
  background_color: string;
  image: { url_1x: string } | null;
  default_image: { url_1x: string } | null;
}

export interface Alert {
  id: string;
  type: AlertType;
  text: string;
  subtext: string;
  durationMs: number;
  sound: boolean;
}

function tierName(tier: string): string {
  return { '1000': '1', '2000': '2', '3000': '3' }[tier] ?? tier;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}

/** Entscheidet, ob für ein Event ein Alert kommt – hier sitzt die ganze Filter-Logik. */
function shouldAlert(event: StreamEvent, s: AlertSettings): boolean {
  if (event.type === 'chat' || !s.enabled[event.type]) return false;
  switch (event.type) {
    case 'redemption':
      return s.rewards[event.reward.id]?.alert ?? s.newRewardDefault;
    case 'sub':
      // Verschenkte Abos lösen pro Empfänger ein "sub" aus → das übernimmt der Gift-Alert
      return !event.isGift;
    case 'cheer':
      return event.bits >= s.minBits;
    case 'raid':
      return event.viewers >= s.minRaiders;
    default:
      return true;
  }
}

function buildAlert(event: StreamEvent, s: AlertSettings): Alert | null {
  if (event.type === 'chat') return null;
  const user = event.user?.name ?? 'Anonym';
  let values: Record<string, string | number> = { user };
  let subtext = '';
  switch (event.type) {
    case 'redemption':
      values = { user, reward: event.reward.title, cost: event.reward.cost };
      subtext = event.input;
      break;
    case 'sub':
      values = { user, tier: tierName(event.tier) };
      break;
    case 'resub':
      values = { user, tier: tierName(event.tier), months: event.months };
      subtext = event.message;
      break;
    case 'giftsub':
      values = { user, tier: tierName(event.tier), count: event.count };
      break;
    case 'cheer':
      values = { user, bits: event.bits };
      subtext = event.message;
      break;
    case 'raid':
      values = { user, viewers: event.viewers };
      break;
  }
  return {
    id: randomUUID(),
    type: event.type,
    text: fill(s.templates[event.type], values),
    subtext,
    durationMs: s.durationMs,
    sound: s.sound,
  };
}

export const alertsAddon: Addon = {
  id: 'alerts',
  name: 'Alerts',
  icon: '🔔',
  version: '0.1.0',
  author: 'Mini',
  description: 'Alerts für Follows, Subs, Bits, Raids und Kanalpunkte – pro Belohnung ein- oder ausschaltbar.',
  settingsPage: 'settings.html',

  activate(ctx) {
    const settings = ctx.settings<AlertSettings>(DEFAULTS);

    const show = (event: StreamEvent) => {
      const alert = buildAlert(event, settings.all());
      if (alert) ctx.overlay.broadcast({ kind: 'alert', alert });
    };

    ctx.events.onAny((event) => {
      if (shouldAlert(event, settings.all())) show(event);
    });

    ctx.api.get('/settings', () => settings.all());

    ctx.api.post('/settings', ({ body }) => {
      const patch: Partial<AlertSettings> = {};
      for (const key of Object.keys(DEFAULTS) as (keyof AlertSettings)[]) {
        if (key === 'rewards' || !(key in (body ?? {}))) continue;
        const value = body[key];
        if (typeof value !== typeof DEFAULTS[key]) throw new HttpError(400, `Ungültiger Wert für ${key}`);
        (patch as Record<string, unknown>)[key] =
          typeof value === 'object' ? { ...(settings.get(key) as object), ...value } : value;
      }
      settings.update(patch);
      return settings.all();
    });

    /** Belohnungen live von Twitch + ob jeweils ein Alert kommt. */
    ctx.api.get('/rewards', async () => {
      const user = ctx.getUser();
      if (!user) throw new HttpError(401, 'Bitte zuerst in der Übersicht mit Twitch verbinden.');
      const res = await ctx.twitch.request<{ data: HelixReward[] }>('GET', '/channel_points/custom_rewards', {
        query: { broadcaster_id: user.id },
      });
      const s = settings.all();
      return {
        rewards: res.data
          .map((r) => ({
            id: r.id,
            title: r.title,
            cost: r.cost,
            enabled: r.is_enabled,
            paused: r.is_paused,
            color: r.background_color,
            image: (r.image ?? r.default_image)?.url_1x ?? null,
            custom: r.id in s.rewards,
            alert: s.rewards[r.id]?.alert ?? s.newRewardDefault,
          }))
          .sort((a, b) => a.cost - b.cost),
      };
    });

    /** { changes: { [rewardId]: { alert, title } | null } } – null = zurück auf Standard */
    ctx.api.post('/rewards', ({ body }) => {
      const changes = body?.changes;
      if (!changes || typeof changes !== 'object') throw new HttpError(400, '"changes" fehlt');
      const rewards = { ...settings.get('rewards') };
      for (const [id, change] of Object.entries(changes as Record<string, RewardSetting | null>)) {
        if (change === null) delete rewards[id];
        else if (typeof change?.alert === 'boolean') rewards[id] = { alert: change.alert, title: String(change.title ?? '') };
      }
      settings.set('rewards', rewards);
    });

    /** Test-Alert. Mit respectFilter wird geprüft, ob der Alert wirklich käme. */
    ctx.api.post('/test', ({ body }) => {
      const type = body?.type as AlertType;
      if (!ALERT_TYPES.includes(type)) throw new HttpError(400, 'Unbekannter Alert-Typ');
      const event = makeTestEvent(type, body?.reward);
      if (body?.respectFilter && !shouldAlert(event, settings.all())) return { shown: false };
      show(event);
      return { shown: true };
    });

    ctx.api.post('/skip', () => ctx.overlay.broadcast({ kind: 'skip' }));
  },
};
