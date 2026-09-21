import { randomUUID } from 'node:crypto';
import type { Addon } from '../../core/addons';
import { keyboard, validateSteps, type KeyStep } from '../../core/keyboard';
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
  /** Belohnungen dieser Gruppe gehören einer anderen App (z.B. HudFX) → nie übernehmen */
  foreign?: boolean;
  /** Nur aktiv, wenn eines dieser Spiele (Twitch-Kategorien) gespielt wird */
  gameRule?: GameRule | null;
}

interface Game {
  id: string;
  name: string;
}

interface GameRule {
  games: Game[];
  /** Was bei anderen Spielen passiert: ausblenden (Zuschauer sehen sie nicht) oder pausieren (sichtbar, aber gesperrt) */
  mode: 'hide' | 'pause';
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
  /** Einzelne Belohnungen, die einer anderen App gehören → nie übernehmen */
  foreignRewards: string[];
  /** Not-Aus für alle Keybinds */
  keybindsEnabled: boolean;
  /** Reward-ID → Tastenfolge */
  keybinds: Record<string, Keybind>;
}

interface Keybind {
  enabled: boolean;
  steps: KeyStep[];
  /** Nur bei diesen Spielen ausführen (leer = immer) */
  games: Game[];
  /** Nur zur Info: Name der Belohnung */
  title: string;
}

const DEFAULTS: Settings = { groups: [], imports: [], foreignRewards: [], keybindsEnabled: true, keybinds: {} };
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

    // ------------------------------------------------------------ Spiel-Regeln

    /** Aktuelle Kategorie des Kanals (null = noch unbekannt) */
    let currentGame: Game | null = null;
    let lastApply: { at: number; game: string; changed: number; skipped: number } | null = null;

    const loadCurrentGame = async (): Promise<Game | null> => {
      const user = ctx.getUser();
      if (!user) return null;
      const res = await ctx.twitch.request<{ data: { game_id: string; game_name: string }[] }>('GET', '/channels', {
        query: { broadcaster_id: user.id },
      });
      const info = res.data[0];
      currentGame = info ? { id: info.game_id, name: info.game_name } : null;
      return currentGame;
    };

    /**
     * Schaltet alle Belohnungen mit Spiel-Regel passend zum aktuellen Spiel.
     * Liegt eine Belohnung in mehreren Gruppen mit Regel, ist sie aktiv, sobald eine davon passt.
     */
    const applyGameRules = async (reason: string) => {
      const ruled = settings.get('groups').filter((g) => g.gameRule?.games.length);
      if (!ruled.length || !currentGame) return { changed: 0, skipped: [] as string[], failed: [] as string[] };

      const wanted = new Map<string, { active: boolean; mode: GameRule['mode'] }>();
      for (const group of ruled) {
        const rule = group.gameRule!;
        const matches = rule.games.some((g) => g.id === currentGame!.id);
        for (const id of group.rewardIds) {
          const prev = wanted.get(id);
          wanted.set(id, {
            active: (prev?.active ?? false) || matches,
            // "Ausblenden" gewinnt, wenn sich Gruppen widersprechen
            mode: prev?.mode === 'hide' || rule.mode === 'hide' ? 'hide' : 'pause',
          });
        }
      }

      const [all, manageable] = await Promise.all([fetchRewards(), fetchRewards(true)]);
      const manageableIds = new Set(manageable.map((r) => r.id));
      let changed = 0;
      const skipped: string[] = [];
      const failed: string[] = [];
      for (const reward of all) {
        const want = wanted.get(reward.id);
        if (!want) continue;
        if (!manageableIds.has(reward.id)) {
          skipped.push(reward.title);
          continue;
        }
        // Beim Wechsel ins passende Spiel wird beides zurückgesetzt (sichtbar + nicht pausiert)
        const patch: { is_enabled?: boolean; is_paused?: boolean } = {};
        if (want.active) {
          if (!reward.is_enabled) patch.is_enabled = true;
          if (reward.is_paused) patch.is_paused = false;
        } else if (want.mode === 'hide') {
          if (reward.is_enabled) patch.is_enabled = false;
        } else if (!reward.is_paused) {
          patch.is_paused = true;
        }
        if (!Object.keys(patch).length) continue;
        try {
          await patchReward(reward.id, patch);
          changed++;
        } catch (err) {
          failed.push(`${reward.title}: ${(err as Error).message}`);
        }
      }
      lastApply = { at: Date.now(), game: currentGame.name, changed, skipped: skipped.length };
      ctx.log.info(`Spiel-Regeln (${reason}, Spiel „${currentGame.name}“): ${changed} geändert${skipped.length ? `, ${skipped.length} übersprungen (🔒)` : ''}`);
      return { changed, skipped, failed };
    };

    // Kategorie gewechselt → Regeln anwenden
    ctx.events.on('channelupdate', async (event) => {
      if (event.test) return;
      const changedGame = currentGame?.id !== event.categoryId;
      currentGame = { id: event.categoryId, name: event.categoryName };
      if (changedGame) await applyGameRules('Spielwechsel').catch((err) => ctx.log.warn('Spiel-Regeln fehlgeschlagen:', err));
    });

    // Beim Start: aktuelles Spiel holen und Regeln einmal anwenden (Login kann etwas dauern)
    let startupTries = 0;
    const startup = async () => {
      if (!ctx.getUser()) {
        if (++startupTries < 30) startupTimer = setTimeout(startup, 2000);
        return;
      }
      try {
        await loadCurrentGame();
        await applyGameRules('Start');
      } catch (err) {
        ctx.log.warn('Spiel-Regeln beim Start fehlgeschlagen:', err);
      }
    };
    let startupTimer: NodeJS.Timeout | null = setTimeout(startup, 1000);
    ctx.onDispose(() => {
      if (startupTimer) clearTimeout(startupTimer);
    });

    ctx.api.get('/game', async () => {
      if (!currentGame) await loadCurrentGame().catch(() => null);
      return { current: currentGame, lastApply };
    });

    /** Spiele/Kategorien bei Twitch suchen */
    ctx.api.get('/games/search', async ({ query }) => {
      const q = String(query.get('q') ?? '').trim();
      if (!q) return [];
      const res = await ctx.twitch.request<{ data: { id: string; name: string; box_art_url: string }[] }>('GET', '/search/categories', {
        query: { query: q, first: '12' },
      });
      return res.data.map((g) => ({ id: g.id, name: g.name, image: g.box_art_url.replace('{width}', '52').replace('{height}', '72') }));
    });

    /** { id, rule: { games, mode } | null } – Spiel-Regel einer Gruppe setzen und gleich anwenden */
    ctx.api.post('/groups/game-rule', async ({ body }) => {
      const groups = settings.get('groups');
      if (!groups.some((g) => g.id === body?.id)) throw new HttpError(404, 'Gruppe nicht gefunden');
      let rule: GameRule | null = null;
      if (body?.rule) {
        const games: Game[] = (Array.isArray(body.rule.games) ? body.rule.games : [])
          .filter((g: Partial<Game>) => typeof g?.id === 'string' && g.id && typeof g.name === 'string')
          .map((g: Game) => ({ id: g.id, name: g.name.slice(0, 100) }));
        rule = { games, mode: body.rule.mode === 'pause' ? 'pause' : 'hide' };
      }
      saveGroups(groups.map((g) => (g.id === body.id ? { ...g, gameRule: rule } : g)));
      if (!currentGame) await loadCurrentGame().catch(() => null);
      return applyGameRules('Regel geändert');
    });

    // ------------------------------------------------------------ Keybinds

    // Belohnung eingelöst → Tastenfolge ausführen (klappt für ALLE Belohnungen, auch fremde)
    ctx.events.on('redemption', async (event) => {
      if (event.test || !settings.get('keybindsEnabled')) return;
      const bind = settings.get('keybinds')[event.reward.id];
      if (!bind?.enabled || !bind.steps.length) return;
      if (bind.games.length) {
        if (!currentGame) await loadCurrentGame().catch(() => null);
        if (!bind.games.some((g) => g.id === currentGame?.id)) {
          ctx.log.info(`Keybind „${event.reward.title}“ übersprungen: falsches Spiel (${currentGame?.name ?? 'unbekannt'})`);
          return;
        }
      }
      await keyboard.run(bind.steps, event.reward.title).catch((err) => ctx.log.warn(`Keybind „${event.reward.title}“ fehlgeschlagen:`, err));
    });

    const parseGames = (input: unknown): Game[] =>
      (Array.isArray(input) ? input : [])
        .filter((g: Partial<Game>) => typeof g?.id === 'string' && g.id && typeof g.name === 'string')
        .map((g: Game) => ({ id: g.id, name: g.name.slice(0, 100) }));

    ctx.api.get('/keybinds', () => ({ enabled: settings.get('keybindsEnabled'), binds: settings.get('keybinds') }));

    ctx.api.post('/keybinds/enabled', ({ body }) => {
      settings.set('keybindsEnabled', body?.enabled === true);
      ctx.log.info(body?.enabled ? 'Keybinds eingeschaltet' : 'Keybinds ausgeschaltet (Not-Aus)');
      return { enabled: settings.get('keybindsEnabled') };
    });

    /** { rewardId, title, bind: { enabled, steps, games } | null } */
    ctx.api.post('/keybinds/save', ({ body }) => {
      const rewardId = String(body?.rewardId ?? '');
      if (!rewardId) throw new HttpError(400, 'rewardId fehlt');
      const binds = { ...settings.get('keybinds') };
      if (!body.bind) {
        delete binds[rewardId];
      } else {
        let steps: KeyStep[];
        try {
          steps = validateSteps(body.bind.steps);
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
        binds[rewardId] = {
          enabled: body.bind.enabled !== false,
          steps,
          games: parseGames(body.bind.games),
          title: String(body.title ?? '').slice(0, 45),
        };
      }
      settings.set('keybinds', binds);
      return binds[rewardId] ?? null;
    });

    /** Tastenfolge testen – nach einer Wartezeit, damit man ins Ziel-Fenster wechseln kann */
    ctx.api.post('/keybinds/test', async ({ body }) => {
      let steps: KeyStep[];
      try {
        steps = validateSteps(body?.steps);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const waitMs = Math.max(0, Math.min(10_000, Number(body?.waitMs) || 0));
      setTimeout(() => {
        keyboard.run(steps, 'Test').catch((err) => ctx.log.warn('Keybind-Test fehlgeschlagen:', err));
      }, waitMs);
    });

    /** Regeln jetzt mit dem aktuellen Spiel anwenden */
    ctx.api.post('/game-rules/apply', async () => {
      await loadCurrentGame();
      return { game: currentGame, ...(await applyGameRules('von Hand')) };
    });

    /** Warum eine Belohnung als "andere App" gilt: 'self' (selbst markiert), Gruppenname oder null */
    const foreignReason = (rewardId: string): string | null => {
      if (settings.get('foreignRewards').includes(rewardId)) return 'self';
      return settings.get('groups').find((g) => g.foreign && g.rewardIds.includes(rewardId))?.name ?? null;
    };

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
            foreign: manageableIds.has(r.id) ? null : foreignReason(r.id),
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
      const foreign = body?.foreign === true;
      const groups = settings.get('groups');
      const existing = groups.find((g) => g.id === body?.id);
      if (existing) {
        saveGroups(groups.map((g) => (g.id === existing.id ? { ...g, name, color, icon, foreign } : g)));
        return { ...existing, name, color, icon, foreign };
      }
      const group: Group = { id: randomUUID(), name, color, icon, foreign, rewardIds: Array.isArray(body?.rewardIds) ? body.rewardIds.map(String) : [] };
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

    /** { id, foreign } – nur den "andere App"-Schalter einer Gruppe ändern */
    ctx.api.post('/groups/foreign', ({ body }) => {
      const groups = settings.get('groups');
      if (!groups.some((g) => g.id === body?.id)) throw new HttpError(404, 'Gruppe nicht gefunden');
      saveGroups(groups.map((g) => (g.id === body.id ? { ...g, foreign: body.foreign === true } : g)));
    });

    /** { id, foreign } – einzelne Belohnung als "gehört einer anderen App" markieren */
    ctx.api.post('/rewards/foreign', ({ body }) => {
      const id = String(body?.id ?? '');
      if (!id) throw new HttpError(400, 'id fehlt');
      const list = settings.get('foreignRewards').filter((x) => x !== id);
      if (body?.foreign === true) list.push(id);
      settings.set('foreignRewards', list);
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
      settings.set('foreignRewards', settings.get('foreignRewards').filter((id) => id !== body?.id));
      const binds = { ...settings.get('keybinds') };
      delete binds[String(body?.id)];
      settings.set('keybinds', binds);
      ctx.log.info('Belohnung gelöscht');
    });

    // ------------------------------------------------------------ Übernehmen (Dashboard-Belohnung → von der Suite verwaltet)

    /** Schritt 1: Einstellungen merken. Danach löscht man das Original im Twitch-Dashboard. */
    ctx.api.post('/imports/start', async ({ body }) => {
      const reward = (await fetchRewards()).find((r) => r.id === body?.id);
      if (!reward) throw new HttpError(404, 'Belohnung nicht gefunden');
      const reason = foreignReason(reward.id);
      if (reason) {
        throw new HttpError(400, reason === 'self'
          ? 'Diese Belohnung ist als „von einer anderen App“ markiert und wird nicht übernommen.'
          : `Diese Belohnung liegt in der Gruppe „${reason}“, die als „andere App“ markiert ist. Sie wird nicht übernommen.`);
      }
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
      const binds = { ...settings.get('keybinds') };
      if (binds[pending.oldId]) {
        binds[reward.id] = binds[pending.oldId];
        delete binds[pending.oldId];
        settings.set('keybinds', binds);
      }
      settings.set('imports', settings.get('imports').filter((i) => i.oldId !== pending.oldId));
      ctx.log.info(`Belohnung übernommen: ${reward.title}`);
      return { id: reward.id, oldId: pending.oldId };
    });

    ctx.api.post('/imports/cancel', ({ body }) => {
      settings.set('imports', settings.get('imports').filter((i) => i.oldId !== body?.id));
    });
  },
};
