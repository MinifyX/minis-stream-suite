import { randomUUID } from 'node:crypto';
import type { Addon } from '../../core/addons';
import { HttpError } from '../../core/server';
import type { EventOfType } from '../../core/twitch/events';
import { CHANNELPOINTS_SERVICE, type ChannelPointsService } from '../channelpoints/service';

/**
 * Einlöse-Warteschlange: Einlösungen, die noch erledigt werden müssen („Song wünschen“, „Liegestütze“ …).
 * Abhaken = bei Twitch als erledigt markieren, Zurückerstatten = Punkte gehen an den Zuschauer zurück.
 *
 * Twitch lässt das nur bei Belohnungen zu, die die Suite selbst angelegt hat. Einlösungen anderer
 * Belohnungen (Dashboard, HudFX …) stehen trotzdem in der Liste, lassen sich aber nur lokal abhaken.
 */

interface QueueEntry {
  /** ID der Einlösung bei Twitch */
  id: string;
  rewardId: string;
  rewardTitle: string;
  cost: number;
  user: { id: string; login: string; name: string };
  input: string;
  at: number;
  /** Darf die Suite den Status bei Twitch ändern? */
  manageable: boolean;
  test?: boolean;
}

/** always = immer in die Liste, never = nie. Ohne Eintrag entscheidet Twitch (siehe unten) */
type RewardMode = 'always' | 'never';

interface Settings {
  enabled: boolean;
  /** Reward-ID → eigene Einstellung */
  rewards: Record<string, { mode: RewardMode; title: string }>;
  /** Gruppen aus dem Kanalpunkte-Addon, deren Einlösungen nie in die Liste kommen (z.B. HudFX) */
  ignoredGroups: string[];
  entries: QueueEntry[];
}

interface HelixReward {
  id: string;
  title: string;
  cost: number;
  background_color: string;
  should_redemptions_skip_request_queue: boolean;
  image: { url_1x: string } | null;
  default_image: { url_1x: string } | null;
}

interface HelixRedemption {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  user_input: string;
  redeemed_at: string;
  reward: { id: string; title: string; cost: number };
}

const DEFAULTS: Settings = { enabled: true, rewards: {}, ignoredGroups: [], entries: [] };
/** Nicht endlos wachsen lassen, falls nie jemand abhakt */
const MAX_ENTRIES = 300;
/** So lange gilt die Liste der Belohnungen, die die Suite verwalten darf */
const MANAGEABLE_TTL_MS = 60_000;

export const queueAddon: Addon = {
  id: 'queue',
  name: 'Warteschlange',
  icon: '📋',
  version: '0.1.0',
  author: 'Mini',
  description: 'Einlösungen der Reihe nach abarbeiten: abhaken oder Punkte zurückerstatten. Auch als kleines Fenster, das immer im Vordergrund bleibt.',
  settingsPage: 'index.html',

  activate(ctx) {
    const settings = ctx.settings<Settings>(DEFAULTS);
    const channelPoints = () => ctx.use<ChannelPointsService>(CHANNELPOINTS_SERVICE);

    const broadcasterId = () => {
      const user = ctx.getUser();
      if (!user) throw new HttpError(401, 'Bitte zuerst in der Übersicht mit Twitch verbinden.');
      return user.id;
    };

    // ------------------------------------------------------------ Belohnungen, die die Suite ändern darf

    let manageable: { at: number; rewards: HelixReward[] } | null = null;
    const manageableRewards = async (fresh = false) => {
      if (!fresh && manageable && Date.now() - manageable.at < MANAGEABLE_TTL_MS) return manageable.rewards;
      const res = await ctx.twitch.request<{ data: HelixReward[] }>('GET', '/channel_points/custom_rewards', {
        query: { broadcaster_id: broadcasterId(), only_manageable_rewards: 'true' },
      });
      manageable = { at: Date.now(), rewards: res.data };
      return res.data;
    };
    const isManageable = async (rewardId: string) => {
      try {
        return (await manageableRewards()).some((r) => r.id === rewardId);
      } catch {
        return false;
      }
    };

    /**
     * Kommt eine Einlösung in die Liste?
     * Eigene Einstellung der Belohnung > Gruppe ignoriert > Twitch: „unfulfilled“ heißt, die Belohnung
     * nutzt die Warteschlange (bei Twitch: „Einlösungen überspringen die Warteschlange“ ist aus).
     */
    const wanted = (rewardId: string, status: string) => {
      const own = settings.get('rewards')[rewardId];
      if (own) return own.mode === 'always';
      const ignored = settings.get('ignoredGroups');
      if (channelPoints()?.groupsOf(rewardId).some((g) => ignored.includes(g.id))) return false;
      return status === 'unfulfilled';
    };

    const save = (entries: QueueEntry[]) => settings.set('entries', entries.slice(-MAX_ENTRIES));
    const remove = (ids: string[]) => save(settings.get('entries').filter((e) => !ids.includes(e.id)));

    ctx.events.on('redemption', async (event: EventOfType<'redemption'>) => {
      if (!settings.get('enabled') || !wanted(event.reward.id, event.status)) return;
      if (settings.get('entries').some((e) => e.id === event.redemptionId && !event.test)) return;
      const entry: QueueEntry = {
        id: event.test ? `test-${randomUUID()}` : event.redemptionId,
        rewardId: event.reward.id,
        rewardTitle: event.reward.title,
        cost: event.reward.cost,
        user: event.user,
        input: event.input,
        at: Date.now(),
        manageable: !event.test && (await isManageable(event.reward.id)),
        ...(event.test ? { test: true } : {}),
      };
      save([...settings.get('entries'), entry]);
    });

    // Woanders erledigt oder zurückerstattet (Dashboard, Mod, andere App) → raus aus der Liste
    ctx.events.on('redemptionupdate', (event) => {
      if (!event.test) remove([event.redemptionId]);
    });

    // ------------------------------------------------------------ Status bei Twitch setzen

    /** Einlösungen bei Twitch auf erledigt/zurückerstattet setzen (max. 50 pro Aufruf und Belohnung) */
    const setStatus = async (entries: QueueEntry[], status: 'FULFILLED' | 'CANCELED') => {
      const byReward = new Map<string, string[]>();
      for (const e of entries) {
        if (!e.manageable || e.test) continue;
        byReward.set(e.rewardId, [...(byReward.get(e.rewardId) ?? []), e.id]);
      }
      const failed: string[] = [];
      for (const [rewardId, ids] of byReward) {
        for (let i = 0; i < ids.length; i += 50) {
          try {
            await ctx.twitch.request('PATCH', '/channel_points/custom_rewards/redemptions', {
              query: { broadcaster_id: broadcasterId(), reward_id: rewardId, id: ids.slice(i, i + 50) },
              body: { status },
            });
          } catch (err) {
            const message = (err as Error).message;
            // Schon erledigt/erstattet (z.B. im Dashboard) → trotzdem aus der Liste nehmen
            if (/404/.test(message)) continue;
            ctx.log.warn(`Status ${status} fehlgeschlagen:`, err);
            failed.push(...ids.slice(i, i + 50));
          }
        }
      }
      return failed;
    };

    const finish = async (ids: string[], status: 'FULFILLED' | 'CANCELED' | null) => {
      const entries = settings.get('entries').filter((e) => ids.includes(e.id));
      if (!entries.length) throw new HttpError(404, 'Nicht (mehr) in der Warteschlange');
      if (status === 'CANCELED' && entries.some((e) => !e.manageable && !e.test)) {
        throw new HttpError(400, 'Zurückerstatten geht nur bei Belohnungen, die die Suite angelegt hat (🔒).');
      }
      const failed = status ? await setStatus(entries, status) : [];
      remove(ids.filter((id) => !failed.includes(id)));
      if (failed.length) throw new HttpError(502, `${failed.length} Einlösung(en) konnten bei Twitch nicht geändert werden. Sie bleiben in der Liste.`);
      return state();
    };

    // ------------------------------------------------------------ Abgleich mit Twitch

    /**
     * Offene Einlösungen von Twitch holen (z.B. nach einem Neustart): Fehlende kommen dazu,
     * Einträge, die bei Twitch nicht mehr offen sind, fliegen raus. Geht nur für Belohnungen der Suite.
     */
    const sync = async () => {
      const rewards = (await manageableRewards(true)).filter((r) => !r.should_redemptions_skip_request_queue);
      const open: QueueEntry[] = [];
      for (const reward of rewards) {
        let cursor: string | undefined;
        do {
          const res = await ctx.twitch.request<{ data: HelixRedemption[]; pagination?: { cursor?: string } }>(
            'GET', '/channel_points/custom_rewards/redemptions', {
              query: { broadcaster_id: broadcasterId(), reward_id: reward.id, status: 'UNFULFILLED', sort: 'OLDEST', first: '50', ...(cursor ? { after: cursor } : {}) },
            });
          for (const r of res.data) {
            open.push({
              id: r.id,
              rewardId: r.reward.id,
              rewardTitle: r.reward.title,
              cost: r.reward.cost,
              user: { id: r.user_id, login: r.user_login, name: r.user_name },
              input: r.user_input ?? '',
              at: Date.parse(r.redeemed_at) || Date.now(),
              manageable: true,
            });
          }
          cursor = res.pagination?.cursor;
        } while (cursor && open.length < MAX_ENTRIES);
      }
      const openIds = new Set(open.map((e) => e.id));
      const syncedRewards = new Set(rewards.map((r) => r.id));
      // Behalten: alles, was Twitch nicht kennt (fremde Belohnungen, Tests), und was bei Twitch noch offen ist
      const before = settings.get('entries');
      const kept = before.filter((e) => !e.manageable || !syncedRewards.has(e.rewardId) || openIds.has(e.id));
      const keptIds = new Set(kept.map((e) => e.id));
      const added = open.filter((e) => !keptIds.has(e.id) && wanted(e.rewardId, 'unfulfilled'));
      save([...kept, ...added].sort((a, b) => a.at - b.at));
      return { added: added.length, removed: before.length - kept.length };
    };

    // Beim Start einmal abgleichen (Login kann etwas dauern)
    let tries = 0;
    const startup = async () => {
      if (!ctx.getUser()) {
        if (++tries < 30) startupTimer = setTimeout(startup, 2000);
        return;
      }
      await sync().catch((err) => ctx.log.warn('Abgleich mit Twitch fehlgeschlagen:', err));
    };
    let startupTimer: NodeJS.Timeout | null = setTimeout(startup, 1500);
    ctx.onDispose(() => {
      if (startupTimer) clearTimeout(startupTimer);
    });

    // ------------------------------------------------------------ API

    const state = () => ({
      enabled: settings.get('enabled'),
      entries: settings.get('entries'),
      now: Date.now(),
    });

    ctx.api.get('/state', state);

    ctx.api.post('/done', ({ body }) => finish([String(body?.id)], 'FULFILLED'));
    ctx.api.post('/refund', ({ body }) => finish([String(body?.id)], 'CANCELED'));
    /** Nur aus der Liste nehmen, bei Twitch nichts ändern */
    ctx.api.post('/remove', ({ body }) => finish([String(body?.id)], null));
    ctx.api.post('/done-all', () => {
      const ids = settings.get('entries').map((e) => e.id);
      return ids.length ? finish(ids, 'FULFILLED') : state();
    });

    ctx.api.post('/sync', async () => ({ ...(await sync()), ...state() }));

    ctx.api.post('/settings', ({ body }) => {
      if (typeof body?.enabled === 'boolean') settings.set('enabled', body.enabled);
      if (Array.isArray(body?.ignoredGroups)) settings.set('ignoredGroups', body.ignoredGroups.map(String));
      return state();
    });

    /** Alle Belohnungen mit der Info, ob ihre Einlösungen in die Liste kommen */
    ctx.api.get('/rewards', async () => {
      const [all, own] = await Promise.all([
        ctx.twitch.request<{ data: HelixReward[] }>('GET', '/channel_points/custom_rewards', { query: { broadcaster_id: broadcasterId() } }),
        manageableRewards(true),
      ]);
      const ownIds = new Set(own.map((r) => r.id));
      const modes = settings.get('rewards');
      const cp = channelPoints();
      return {
        groups: cp?.groups() ?? null,
        ignoredGroups: settings.get('ignoredGroups'),
        rewards: all.data
          .map((r) => ({
            id: r.id,
            title: r.title,
            cost: r.cost,
            color: r.background_color,
            image: (r.image ?? r.default_image)?.url_1x ?? null,
            usesQueue: !r.should_redemptions_skip_request_queue,
            manageable: ownIds.has(r.id),
            mode: modes[r.id]?.mode ?? null,
            groups: cp?.groupsOf(r.id).map((g) => g.id) ?? [],
            inQueue: wanted(r.id, r.should_redemptions_skip_request_queue ? 'fulfilled' : 'unfulfilled'),
          }))
          .sort((a, b) => a.cost - b.cost),
      };
    });

    /** { id, title, mode: 'always' | 'never' | null } – null = wie Twitch */
    ctx.api.post('/rewards/mode', ({ body }) => {
      const id = String(body?.id ?? '');
      if (!id) throw new HttpError(400, 'id fehlt');
      const rewards = { ...settings.get('rewards') };
      if (body.mode === 'always' || body.mode === 'never') rewards[id] = { mode: body.mode, title: String(body.title ?? '') };
      else delete rewards[id];
      settings.set('rewards', rewards);
    });

    // ------------------------------------------------------------ Fenster (immer im Vordergrund, auch als OBS-Dock)

    ctx.api.post('/window/open', () => {
      ctx.windows.open('window', 'index.html?window=1', { title: 'Warteschlange – Mini\'s Stream Suite', width: 380, height: 600 });
    });
    ctx.api.get('/window/state', () => ({ open: ctx.windows.isOpen('window'), onTop: ctx.windows.isAlwaysOnTop('window') }));
    ctx.api.post('/window/pin', ({ body }) => {
      ctx.windows.setAlwaysOnTop('window', body?.onTop === true);
      return { onTop: ctx.windows.isAlwaysOnTop('window') };
    });
  },
};
