import { randomUUID } from 'node:crypto';
import type { Addon } from '../../core/addons';
import { HttpError } from '../../core/server';
import { CHANNELPOINTS_SERVICE, type ChannelPointsService, type GroupInfo } from './service';

/** Belohnung, wie Twitch sie liefert (nur die Felder, die wir brauchen) */
interface HelixReward {
  id: string;
  title: string;
  prompt: string;
  cost: number;
  image: { url_1x: string; url_2x: string } | null;
  default_image: { url_1x: string; url_2x: string } | null;
  background_color: string;
  is_enabled: boolean;
  is_paused: boolean;
  is_in_stock: boolean;
  is_user_input_required: boolean;
  max_per_stream_setting: { is_enabled: boolean; max_per_stream: number };
  max_per_user_per_stream_setting: { is_enabled: boolean; max_per_user_per_stream: number };
  global_cooldown_setting: { is_enabled: boolean; global_cooldown_seconds: number };
  should_redemptions_skip_request_queue: boolean;
  redemptions_redeemed_current_stream: number | null;
  cooldown_expires_at: string | null;
}

/** Felder, die man beim Anlegen/Bearbeiten an Twitch schickt */
interface RewardData {
  title: string;
  cost: number;
  prompt: string;
  is_enabled: boolean;
  background_color: string;
  is_user_input_required: boolean;
  is_max_per_stream_enabled: boolean;
  max_per_stream: number;
  is_max_per_user_per_stream_enabled: boolean;
  max_per_user_per_stream: number;
  is_global_cooldown_enabled: boolean;
  global_cooldown_seconds: number;
  should_redemptions_skip_request_queue: boolean;
}

interface Group extends GroupInfo {
  rewardIds: string[];
}

/** Belohnung, die gerade "übernommen" wird: Einstellungen gemerkt, Original wird von Hand gelöscht */
interface PendingImport {
  oldId: string;
  data: RewardData;
  startedAt: number;
}

interface Settings {
  groups: Group[];
  imports: PendingImport[];
}

const DEFAULTS: Settings = { groups: [], imports: [] };
const MAX_REWARDS = 50;

function toData(r: HelixReward): RewardData {
  return {
    title: r.title,
    cost: r.cost,
    prompt: r.prompt,
    is_enabled: r.is_enabled,
    background_color: r.background_color,
    is_user_input_required: r.is_user_input_required,
    is_max_per_stream_enabled: r.max_per_stream_setting.is_enabled,
    max_per_stream: r.max_per_stream_setting.max_per_stream,
    is_max_per_user_per_stream_enabled: r.max_per_user_per_stream_setting.is_enabled,
    max_per_user_per_stream: r.max_per_user_per_stream_setting.max_per_user_per_stream,
    is_global_cooldown_enabled: r.global_cooldown_setting.is_enabled,
    global_cooldown_seconds: r.global_cooldown_setting.global_cooldown_seconds,
    should_redemptions_skip_request_queue: r.should_redemptions_skip_request_queue,
  };
}

const int = (value: unknown, min: number, max: number, name: string): number => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `${name} muss eine ganze Zahl von ${min} bis ${max} sein.`);
  return n;
};

/** Prüft die Eingaben aus dem Formular, bevor sie an Twitch gehen. */
function validateData(input: unknown): RewardData {
  const d = (input ?? {}) as Record<string, unknown>;
  const title = String(d.title ?? '').trim();
  if (!title || title.length > 45) throw new HttpError(400, 'Der Name muss 1 bis 45 Zeichen lang sein.');
  const prompt = String(d.prompt ?? '').trim();
  if (prompt.length > 200) throw new HttpError(400, 'Die Beschreibung darf höchstens 200 Zeichen haben.');
  const color = String(d.background_color ?? '#9146FF');
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new HttpError(400, 'Ungültige Farbe.');
  const bool = (key: string) => d[key] === true;
  const data: RewardData = {
    title,
    cost: int(d.cost, 1, 2_147_483_647, 'Kosten'),
    prompt,
    is_enabled: d.is_enabled !== false,
    background_color: color.toUpperCase(),
    is_user_input_required: bool('is_user_input_required'),
    is_max_per_stream_enabled: bool('is_max_per_stream_enabled'),
    max_per_stream: 1,
    is_max_per_user_per_stream_enabled: bool('is_max_per_user_per_stream_enabled'),
    max_per_user_per_stream: 1,
    is_global_cooldown_enabled: bool('is_global_cooldown_enabled'),
    global_cooldown_seconds: 1,
    should_redemptions_skip_request_queue: bool('should_redemptions_skip_request_queue'),
  };
  // Twitch prüft die Zahlen nur, wenn die jeweilige Option an ist
  if (data.is_max_per_stream_enabled) data.max_per_stream = int(d.max_per_stream, 1, 1_000_000, 'Max. pro Stream');
  if (data.is_max_per_user_per_stream_enabled) data.max_per_user_per_stream = int(d.max_per_user_per_stream, 1, 1_000_000, 'Max. pro Zuschauer');
  if (data.is_global_cooldown_enabled) data.global_cooldown_seconds = int(d.global_cooldown_seconds, 1, 604_800, 'Abklingzeit');
  return data;
}

/** Twitch-Fehlermeldungen verständlicher machen */
function explain(err: unknown): Error {
  const message = (err as Error).message ?? String(err);
  if (/DUPLICATE_REWARD/i.test(message)) return new HttpError(400, 'Es gibt schon eine Belohnung mit diesem Namen.');
  if (/403/.test(message) && /manage|client/i.test(message)) {
    return new HttpError(403, 'Diese Belohnung wurde nicht von der Suite angelegt, deshalb darf sie sie nicht ändern.');
  }
  if (/403/.test(message)) return new HttpError(403, 'Kein Zugriff – Kanalpunkte gibt es nur für Affiliates und Partner.');
  if (/MAXIMUM_REWARDS|maximum/i.test(message)) return new HttpError(400, `Twitch erlaubt höchstens ${MAX_REWARDS} Belohnungen pro Kanal.`);
  return err instanceof Error ? err : new Error(message);
}

export const channelPointsAddon: Addon = {
  id: 'channelpoints',
  name: 'Kanalpunkte',
  icon: '🎯',
  version: '0.1.0',
  author: 'Mini',
  description: 'Belohnungen anlegen, bearbeiten und in Gruppen sortieren. Eine ganze Gruppe (z.B. HudFX) mit einem Klick pausieren oder für Alerts stummschalten.',
  settingsPage: 'index.html',

  activate(ctx) {
    const settings = ctx.settings<Settings>(DEFAULTS);

    const service: ChannelPointsService = {
      groups: () => settings.get('groups').map(({ id, name, icon, color }) => ({ id, name, icon, color })),
      groupsOf: (rewardId) =>
        settings
          .get('groups')
          .filter((g) => g.rewardIds.includes(rewardId))
          .map(({ id, name, icon, color }) => ({ id, name, icon, color })),
    };
    ctx.provide(CHANNELPOINTS_SERVICE, service);

    const broadcasterId = () => {
      const user = ctx.getUser();
      if (!user) throw new HttpError(401, 'Bitte zuerst in der Übersicht mit Twitch verbinden.');
      return user.id;
    };

    const fetchRewards = async (onlyManageable = false) => {
      const res = await ctx.twitch
        .request<{ data: HelixReward[] }>('GET', '/channel_points/custom_rewards', {
          query: { broadcaster_id: broadcasterId(), ...(onlyManageable ? { only_manageable_rewards: 'true' } : {}) },
        })
        .catch((err) => {
          throw explain(err);
        });
      return res.data;
    };

    const patchReward = (id: string, body: Partial<RewardData> & { is_paused?: boolean }) =>
      ctx.twitch
        .request<{ data: HelixReward[] }>('PATCH', '/channel_points/custom_rewards', {
          query: { broadcaster_id: broadcasterId(), id },
          body,
        })
        .then((res) => res.data[0])
        .catch((err) => {
          throw explain(err);
        });

    const createReward = (data: RewardData) =>
      ctx.twitch
        .request<{ data: HelixReward[] }>('POST', '/channel_points/custom_rewards', {
          query: { broadcaster_id: broadcasterId() },
          body: data,
        })
        .then((res) => res.data[0])
        .catch((err) => {
          throw explain(err);
        });

    const saveGroups = (groups: Group[]) => settings.set('groups', groups);

    /** Belohnung in allen Gruppen durch eine neue ID ersetzen (nach dem Übernehmen) */
    const replaceInGroups = (oldId: string, newId: string) =>
      saveGroups(settings.get('groups').map((g) => ({ ...g, rewardIds: g.rewardIds.map((id) => (id === oldId ? newId : id)) })));

    // ------------------------------------------------------------ Übersicht

    ctx.api.get('/state', async () => {
      const [all, manageable] = await Promise.all([fetchRewards(), fetchRewards(true)]);
      const manageableIds = new Set(manageable.map((r) => r.id));
      const groups = settings.get('groups');
      const existingIds = new Set(all.map((r) => r.id));

      // Gelöschte Belohnungen aus den Gruppen räumen – außer sie werden gerade übernommen
      const importing = new Set(settings.get('imports').map((i) => i.oldId));
      const cleaned = groups.map((g) => ({ ...g, rewardIds: g.rewardIds.filter((id) => existingIds.has(id) || importing.has(id)) }));
      if (cleaned.some((g, i) => g.rewardIds.length !== groups[i].rewardIds.length)) saveGroups(cleaned);

      return {
        max: MAX_REWARDS,
        groups: cleaned,
        imports: settings.get('imports').map((i) => ({ ...i, originalExists: existingIds.has(i.oldId) })),
        rewards: all
          .map((r) => ({
            id: r.id,
            title: r.title,
            prompt: r.prompt,
            cost: r.cost,
            color: r.background_color,
            image: (r.image ?? r.default_image)?.url_2x ?? null,
            customImage: !!r.image,
            enabled: r.is_enabled,
            paused: r.is_paused,
            manageable: manageableIds.has(r.id),
            redeemedThisStream: r.redemptions_redeemed_current_stream,
            data: toData(r),
          }))
          .sort((a, b) => a.cost - b.cost),
      };
    });

    // ------------------------------------------------------------ Gruppen

    ctx.api.post('/groups/save', ({ body }) => {
      const name = String(body?.name ?? '').trim().slice(0, 40);
      if (!name) throw new HttpError(400, 'Die Gruppe braucht einen Namen.');
      const color = /^#[0-9a-f]{6}$/i.test(body?.color) ? String(body.color).toUpperCase() : '#9146FF';
      const icon = String(body?.icon ?? '📁').slice(0, 8) || '📁';
      const groups = settings.get('groups');
      const existing = groups.find((g) => g.id === body?.id);
      if (existing) {
        saveGroups(groups.map((g) => (g.id === existing.id ? { ...g, name, color, icon } : g)));
        return { ...existing, name, color, icon };
      }
      const group: Group = { id: randomUUID(), name, color, icon, rewardIds: Array.isArray(body?.rewardIds) ? body.rewardIds.map(String) : [] };
      saveGroups([...groups, group]);
      return group;
    });

    ctx.api.post('/groups/delete', ({ body }) => {
      saveGroups(settings.get('groups').filter((g) => g.id !== body?.id));
    });

    ctx.api.post('/groups/reorder', ({ body }) => {
      const order: string[] = Array.isArray(body?.ids) ? body.ids : [];
      const groups = settings.get('groups');
      saveGroups([...groups].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)));
    });

    /** { rewardId, groupIds } – in genau diese Gruppen einsortieren */
    ctx.api.post('/groups/assign', ({ body }) => {
      const rewardId = String(body?.rewardId ?? '');
      const groupIds: string[] = Array.isArray(body?.groupIds) ? body.groupIds.map(String) : [];
      if (!rewardId) throw new HttpError(400, 'rewardId fehlt');
      saveGroups(
        settings.get('groups').map((g) => {
          const has = g.rewardIds.includes(rewardId);
          const want = groupIds.includes(g.id);
          if (has === want) return g;
          return { ...g, rewardIds: want ? [...g.rewardIds, rewardId] : g.rewardIds.filter((id) => id !== rewardId) };
        }),
      );
    });

    /** { id, rewardIds } – Mitglieder einer Gruppe komplett festlegen */
    ctx.api.post('/groups/members', ({ body }) => {
      const rewardIds: string[] = Array.isArray(body?.rewardIds) ? [...new Set<string>(body.rewardIds.map(String))] : [];
      const groups = settings.get('groups');
      if (!groups.some((g) => g.id === body?.id)) throw new HttpError(404, 'Gruppe nicht gefunden');
      saveGroups(groups.map((g) => (g.id === body.id ? { ...g, rewardIds } : g)));
    });

    /** Aktion für alle Belohnungen einer Gruppe: pause | resume | enable | disable */
    ctx.api.post('/groups/action', async ({ body }) => {
      const group = settings.get('groups').find((g) => g.id === body?.id);
      if (!group) throw new HttpError(404, 'Gruppe nicht gefunden');
      const patch = ({ pause: { is_paused: true }, resume: { is_paused: false }, enable: { is_enabled: true }, disable: { is_enabled: false } } as const)[
        body?.action as 'pause' | 'resume' | 'enable' | 'disable'
      ];
      if (!patch) throw new HttpError(400, 'Unbekannte Aktion');

      const manageable = new Set((await fetchRewards(true)).map((r) => r.id));
      const all = await fetchRewards();
      const inGroup = all.filter((r) => group.rewardIds.includes(r.id));
      let changed = 0;
      const skipped: string[] = [];
      const failed: string[] = [];
      for (const reward of inGroup) {
        if (!manageable.has(reward.id)) {
          skipped.push(reward.title);
          continue;
        }
        try {
          await patchReward(reward.id, patch);
          changed++;
        } catch (err) {
          failed.push(`${reward.title}: ${(err as Error).message}`);
        }
      }
      ctx.log.info(`Gruppe „${group.name}“: ${body.action} → ${changed} geändert, ${skipped.length} übersprungen`);
      return { changed, skipped, failed };
    });

    // ------------------------------------------------------------ Belohnungen

    ctx.api.post('/rewards/save', async ({ body }) => {
      const data = validateData(body?.data);
      const groupIds: string[] = Array.isArray(body?.groupIds) ? body.groupIds.map(String) : [];
      const reward = body?.id ? await patchReward(String(body.id), data) : await createReward(data);
      if (!body?.id && groupIds.length) {
        saveGroups(settings.get('groups').map((g) => (groupIds.includes(g.id) ? { ...g, rewardIds: [...g.rewardIds, reward.id] } : g)));
      }
      ctx.log.info(`Belohnung ${body?.id ? 'gespeichert' : 'angelegt'}: ${reward.title}`);
      return { id: reward.id };
    });

    /** Schnell-Schalter: { id, paused } oder { id, enabled } */
    ctx.api.post('/rewards/toggle', async ({ body }) => {
      const patch: { is_paused?: boolean; is_enabled?: boolean } = {};
      if (typeof body?.paused === 'boolean') patch.is_paused = body.paused;
      if (typeof body?.enabled === 'boolean') patch.is_enabled = body.enabled;
      if (!Object.keys(patch).length) throw new HttpError(400, 'Nichts zu ändern');
      await patchReward(String(body.id), patch);
    });

    ctx.api.post('/rewards/delete', async ({ body }) => {
      await ctx.twitch
        .request('DELETE', '/channel_points/custom_rewards', { query: { broadcaster_id: broadcasterId(), id: String(body?.id) } })
        .catch((err) => {
          throw explain(err);
        });
      saveGroups(settings.get('groups').map((g) => ({ ...g, rewardIds: g.rewardIds.filter((id) => id !== body?.id) })));
      ctx.log.info('Belohnung gelöscht');
    });

    // ------------------------------------------------------------ Übernehmen (Dashboard-Belohnung → von der Suite verwaltet)

    /** Schritt 1: Einstellungen merken. Danach löscht man das Original im Twitch-Dashboard. */
    ctx.api.post('/imports/start', async ({ body }) => {
      const reward = (await fetchRewards()).find((r) => r.id === body?.id);
      if (!reward) throw new HttpError(404, 'Belohnung nicht gefunden');
      const imports = settings.get('imports').filter((i) => i.oldId !== reward.id);
      settings.set('imports', [...imports, { oldId: reward.id, data: toData(reward), startedAt: Date.now() }]);
    });

    /** Schritt 2: Original ist weg → neu anlegen und Gruppen übertragen. */
    ctx.api.post('/imports/finish', async ({ body }) => {
      const pending = settings.get('imports').find((i) => i.oldId === body?.id);
      if (!pending) throw new HttpError(404, 'Nichts zu übernehmen');
      const all = await fetchRewards();
      if (all.some((r) => r.id === pending.oldId)) {
        throw new HttpError(400, 'Die Original-Belohnung existiert noch. Lösche sie zuerst im Twitch-Dashboard.');
      }
      if (all.length >= MAX_REWARDS) throw new HttpError(400, `Twitch erlaubt höchstens ${MAX_REWARDS} Belohnungen pro Kanal.`);
      const reward = await createReward(pending.data);
      replaceInGroups(pending.oldId, reward.id);
      settings.set('imports', settings.get('imports').filter((i) => i.oldId !== pending.oldId));
      ctx.log.info(`Belohnung übernommen: ${reward.title}`);
      return { id: reward.id, oldId: pending.oldId };
    });

    ctx.api.post('/imports/cancel', ({ body }) => {
      settings.set('imports', settings.get('imports').filter((i) => i.oldId !== body?.id));
    });
  },
};
