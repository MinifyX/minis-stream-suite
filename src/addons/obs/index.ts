import type { Addon, AddonContext } from '../../core/addons';
import { ROLE_LEVEL, roleLevel } from '../../core/chat';
import { HttpError } from '../../core/server';
import type { StreamEvent } from '../../core/twitch/events';
import { ObsClient, type ObsConnection } from './client';
import {
  DEFAULTS,
  cleanHost,
  cleanPort,
  describeStep,
  renameFilter,
  renameScene,
  renameSource,
  validateAction,
  type ObsAction,
  type Settings,
  type Step,
} from './model';

// ------------------------------------------------------------------ Typen

type LogLevel = 'ok' | 'info' | 'warn' | 'err';

interface LogEntry {
  time: number;
  level: LogLevel;
  /** Name der Aktion (oder "" für allgemeine Meldungen) */
  action: string;
  message: string;
}

/** Was wir von OBS für die Auswahllisten brauchen */
interface ObsData {
  /** In der Reihenfolge wie in OBS (oben → unten) */
  scenes: { name: string; items: { source: string; group: string; isGroup: boolean }[] }[];
  /** Quellen und Szenen, die Filter haben */
  filters: { source: string; filters: string[] }[];
  loadedAt: number;
}

/** Ein laufender Durchgang – kann per Not-Aus abgebrochen werden */
interface Run {
  cancelled: boolean;
  /** Weckt alle gerade wartenden Schritte sofort auf */
  wakers: Set<() => void>;
}

interface Slot {
  run: Run;
  queue: Array<{ action: ObsAction; reason: string }>;
  done: Promise<void>;
}

type Undo = () => Promise<void>;

const MAX_LOG = 100;
/** So viele Auslöser pro Aktion dürfen warten, der Rest wird übersprungen */
const MAX_QUEUE = 20;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Wird beim Deaktivieren aufgerufen (deactivate bekommt keinen ctx) */
let shutdown: (() => Promise<void>) | null = null;

// ------------------------------------------------------------------ Addon

export const obsAddon: Addon = {
  id: 'obs',
  name: 'OBS-Steuerung',
  icon: '🎬',
  version: '0.1.0',
  author: 'Mini',
  description: 'Szenen wechseln, Quellen und Filter schalten – per Kanalpunkte, Chat-Command, Follow, Sub, Cheer oder Raid. Direkt über den WebSocket-Server von OBS, ohne Tastendrücke.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);
    const client = new ObsClient(ctx.log);
    const log: LogEntry[] = [];
    const slots = new Map<string, Slot>();
    /** Letzte Benutzung eines Chat-Commands pro Aktion (für den Cooldown) */
    const lastCommand = new Map<string, number>();

    const addLog = (level: LogLevel, action: string, message: string) => {
      log.push({ time: Date.now(), level, action, message });
      if (log.length > MAX_LOG) log.shift();
    };

    const connection = (): ObsConnection => ({
      host: settings.get('host'),
      port: settings.get('port'),
      password: settings.get('password'),
    });

    // -------------------------------------------------------- Szenen & Quellen aus OBS

    let data: ObsData | null = null;
    /** Zählt hoch, wenn sich die Liste geändert hat – so weiß die Seite, wann sie neu laden muss */
    let dataVersion = 0;
    let currentScene: string | null = null;
    let loading: Promise<void> | null = null;
    let reloadAgain = false;
    let refreshTimer: NodeJS.Timeout | null = null;

    const loadData = async (): Promise<void> => {
      const list = await client.request<{ currentProgramSceneName?: string; scenes: { sceneName: string }[] }>('GetSceneList');
      currentScene = list.currentProgramSceneName ?? currentScene;
      // OBS liefert die Szenen von unten nach oben
      const sceneNames = [...list.scenes].reverse().map((s) => s.sceneName);

      type Item = { sourceName: string; isGroup: boolean | null };
      const scenes = await Promise.all(sceneNames.map(async (name) => {
        const res = await client.request<{ sceneItems: Item[] }>('GetSceneItemList', { sceneName: name });
        const items: ObsData['scenes'][number]['items'] = [];
        for (const item of [...res.sceneItems].reverse()) {
          items.push({ source: item.sourceName, group: '', isGroup: !!item.isGroup });
          if (!item.isGroup) continue;
          // Quellen in Gruppen gehören zur Gruppe, nicht direkt zur Szene
          const inner = await client
            .request<{ sceneItems: Item[] }>('GetGroupSceneItemList', { sceneName: item.sourceName })
            .catch(() => ({ sceneItems: [] as Item[] }));
          for (const child of [...inner.sceneItems].reverse()) items.push({ source: child.sourceName, group: item.sourceName, isGroup: false });
        }
        return { name, items };
      }));

      // Filter: Szenen, Gruppen und alle Eingänge (auch Mikro/Desktop-Audio, die in keiner Szene stecken)
      const inputs = await client
        .request<{ inputs: { inputName: string }[] }>('GetInputList')
        .catch(() => ({ inputs: [] as { inputName: string }[] }));
      const sources = new Set<string>([
        ...sceneNames,
        ...scenes.flatMap((s) => s.items.filter((i) => i.isGroup).map((i) => i.source)),
        ...inputs.inputs.map((i) => i.inputName),
      ]);
      const filters = (await Promise.all([...sources].map(async (source) => {
        const res = await client
          .request<{ filters: { filterName: string }[] }>('GetSourceFilterList', { sourceName: source })
          .catch(() => ({ filters: [] as { filterName: string }[] }));
        return { source, filters: res.filters.map((f) => f.filterName) };
      }))).filter((f) => f.filters.length).sort((a, b) => a.source.localeCompare(b.source, 'de'));

      data = { scenes, filters, loadedAt: Date.now() };
      dataVersion++;
    };

    /** Liste neu laden (mehrere Aufrufe gleichzeitig werden zusammengefasst) */
    const refresh = async (): Promise<void> => {
      if (loading) {
        reloadAgain = true;
        return loading;
      }
      loading = (async () => {
        do {
          reloadAgain = false;
          await loadData();
        } while (reloadAgain && client.connected);
      })().finally(() => {
        loading = null;
      });
      return loading;
    };

    /** Nach Änderungen in OBS kurz warten (oft kommen mehrere Events hintereinander) und dann neu laden */
    const scheduleRefresh = () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        if (client.connected) refresh().catch((err) => ctx.log.warn('OBS-Liste konnte nicht geladen werden:', err));
      }, 500);
    };

    const REFRESH_EVENTS = new Set([
      'SceneCreated', 'SceneRemoved', 'SceneListChanged', 'SceneItemCreated', 'SceneItemRemoved', 'SceneItemListReindexed',
      'InputCreated', 'InputRemoved', 'SourceFilterCreated', 'SourceFilterRemoved', 'CurrentSceneCollectionChanged',
    ]);

    /** Umbenennen in OBS → Aktionen automatisch anpassen, damit nichts kaputtgeht */
    const applyRename = (change: (actions: ObsAction[]) => boolean, what: string) => {
      const actions = settings.get('actions').map((a) => structuredClone(a));
      if (!change(actions)) return;
      settings.set('actions', actions);
      addLog('info', '', `${what} – Aktionen wurden angepasst.`);
      ctx.log.info(`${what} – Aktionen wurden angepasst.`);
    };

    client.onEvent((type, d) => {
      if (type === 'CurrentProgramSceneChanged') currentScene = d.sceneName ?? currentScene;
      if (type === 'SceneNameChanged') {
        if (currentScene === d.oldSceneName) currentScene = d.sceneName;
        applyRename((a) => renameScene(a, d.oldSceneName, d.sceneName), `Szene „${d.oldSceneName}“ heißt jetzt „${d.sceneName}“`);
        scheduleRefresh();
      }
      if (type === 'InputNameChanged') {
        applyRename((a) => renameSource(a, d.oldInputName, d.inputName), `Quelle „${d.oldInputName}“ heißt jetzt „${d.inputName}“`);
        scheduleRefresh();
      }
      if (type === 'SourceFilterNameChanged') {
        applyRename((a) => renameFilter(a, d.sourceName, d.oldFilterName, d.filterName), `Filter „${d.oldFilterName}“ heißt jetzt „${d.filterName}“`);
        scheduleRefresh();
      }
      if (REFRESH_EVENTS.has(type)) scheduleRefresh();
    });

    let lastState = client.status().state;
    client.onState((status) => {
      // Der Handler kommt auch bei reinen Info-Änderungen (z.B. Versionsnummer) – nur echte Wechsel zählen
      if (status.state === lastState) return;
      const before = lastState;
      lastState = status.state;
      if (status.state === 'connected') {
        addLog('ok', '', 'Mit OBS verbunden.');
        scheduleRefresh();
      } else if (status.state === 'connecting' && before === 'connected') {
        addLog('warn', '', 'Verbindung zu OBS verloren – verbinde neu…');
      } else if (status.state === 'disconnected' && status.error) {
        addLog('err', '', status.error);
      }
    });

    // -------------------------------------------------------- Aktionen ausführen

    const newRun = (): Run => ({ cancelled: false, wakers: new Set() });

    /** Warten, das per Not-Aus sofort endet */
    const sleep = (ms: number, run: Run) => new Promise<void>((resolve) => {
      if (run.cancelled) return resolve();
      const wake = () => {
        clearTimeout(timer);
        run.wakers.delete(wake);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      run.wakers.add(wake);
    });

    const getCurrentScene = async (): Promise<string | null> => {
      const res = await client.request<{ sceneName?: string; currentProgramSceneName?: string }>('GetCurrentProgramScene');
      return res.sceneName ?? res.currentProgramSceneName ?? null;
    };

    const sceneItemId = async (sceneName: string, sourceName: string): Promise<number> => {
      const res = await client.request<{ sceneItemId: number }>('GetSceneItemId', { sceneName, sourceName });
      return res.sceneItemId;
    };

    /** Einen Schritt ausführen. Gibt zurück, wie man ihn rückgängig macht (oder null, wenn sich nichts geändert hat). */
    const execute = async (step: Exclude<Step, { type: 'wait' }>): Promise<Undo | null> => {
      switch (step.type) {
        case 'scene': {
          const before = await getCurrentScene();
          await client.request('SetCurrentProgramScene', { sceneName: step.scene });
          if (!before || before === step.scene) return null;
          return async () => {
            // Nur zurückwechseln, wenn noch unsere Szene läuft – sonst hast du inzwischen selbst gewechselt
            if ((await getCurrentScene()) !== step.scene) return;
            await client.request('SetCurrentProgramScene', { sceneName: before });
          };
        }
        case 'source': {
          const sceneName = step.group || step.scene;
          const id = await sceneItemId(sceneName, step.source);
          const { sceneItemEnabled: before } = await client.request<{ sceneItemEnabled: boolean }>('GetSceneItemEnabled', { sceneName, sceneItemId: id });
          const wanted = step.mode === 'toggle' ? !before : step.mode === 'show';
          if (wanted === before) return null;
          await client.request('SetSceneItemEnabled', { sceneName, sceneItemId: id, sceneItemEnabled: wanted });
          return async () => {
            // ID neu holen – die Quelle könnte inzwischen neu angelegt worden sein
            const again = await sceneItemId(sceneName, step.source);
            await client.request('SetSceneItemEnabled', { sceneName, sceneItemId: again, sceneItemEnabled: before });
          };
        }
        case 'filter': {
          const target = { sourceName: step.source, filterName: step.filter };
          const { filterEnabled: before } = await client.request<{ filterEnabled: boolean }>('GetSourceFilter', target);
          const wanted = step.mode === 'toggle' ? !before : step.mode === 'on';
          if (wanted === before) return null;
          await client.request('SetSourceFilterEnabled', { ...target, filterEnabled: wanted });
          return async () => {
            await client.request('SetSourceFilterEnabled', { ...target, filterEnabled: before });
          };
        }
      }
    };

    const runAction = async (action: ObsAction, reason: string, run: Run): Promise<void> => {
      const reverts: Promise<void>[] = [];
      let longest = 0;
      let failed = false;
      for (const [index, step] of action.steps.entries()) {
        if (run.cancelled) break;
        if (step.type === 'wait') {
          await sleep(step.ms, run);
          continue;
        }
        let undo: Undo | null;
        try {
          undo = await execute(step);
        } catch (err) {
          // Bei einem Fehler hören wir auf – die weiteren Schritte bauen meist darauf auf
          failed = true;
          addLog('err', action.name, `Schritt ${index + 1} (${describeStep(step)}): ${errorText(err)}`);
          ctx.log.warn(`OBS-Aktion „${action.name}“, Schritt ${index + 1} (${describeStep(step)}): ${errorText(err)}`);
          break;
        }
        if (undo && step.revertAfter > 0) {
          const revert = undo;
          longest = Math.max(longest, step.revertAfter);
          reverts.push(sleep(step.revertAfter * 1000, run)
            .then(() => revert())
            .catch((err) => addLog('err', action.name, `Zurücksetzen (${describeStep(step)}) fehlgeschlagen: ${errorText(err)}`)));
        }
      }
      if (run.cancelled) {
        addLog('warn', action.name, `Abgebrochen (${reason})${reverts.length ? ' – Rückgängig-Schritte wurden sofort ausgeführt' : ''}.`);
      } else if (!failed) {
        addLog('ok', action.name, `Ausgeführt (${reason})${reverts.length ? ` – wird nach bis zu ${longest} s zurückgesetzt` : ''}.`);
      }
      // Die Aktion gilt erst als fertig, wenn alles zurückgesetzt ist – so überlappt die nächste nicht
      await Promise.all(reverts);
    };

    /** Arbeitet die Warteschlange einer Aktion ab */
    const work = async (id: string, slot: Slot, first: { action: ObsAction; reason: string }): Promise<void> => {
      let next: { action: ObsAction; reason: string } | undefined = first;
      while (next && !slot.run.cancelled) {
        if (!client.connected) {
          addLog('warn', next.action.name, `OBS ist nicht verbunden – übersprungen (${next.reason}).`);
        } else {
          await runAction(next.action, next.reason, slot.run).catch((err) => addLog('err', next!.action.name, errorText(err)));
        }
        next = slot.queue.shift();
      }
      slots.delete(id);
    };

    /** Aktion auslösen: sofort starten, in die Warteschlange stellen oder überspringen */
    const fire = (action: ObsAction, reason: string): 'started' | 'queued' | 'skipped' => {
      if (!client.connected) {
        addLog('warn', action.name, `OBS ist nicht verbunden – übersprungen (${reason}).`);
        ctx.log.warn(`OBS ist nicht verbunden – Aktion „${action.name}“ übersprungen (${reason}).`);
        return 'skipped';
      }
      const slot = slots.get(action.id);
      if (slot) {
        if (action.overlap === 'skip') {
          addLog('info', action.name, `Läuft noch – übersprungen (${reason}).`);
          return 'skipped';
        }
        if (slot.queue.length >= MAX_QUEUE) {
          addLog('warn', action.name, `Warteschlange voll (${MAX_QUEUE}) – übersprungen (${reason}).`);
          return 'skipped';
        }
        slot.queue.push({ action, reason });
        addLog('info', action.name, `Läuft noch – wartet als ${slot.queue.length}. in der Schlange (${reason}).`);
        return 'queued';
      }
      const fresh: Slot = { run: newRun(), queue: [], done: Promise.resolve() };
      slots.set(action.id, fresh);
      fresh.done = work(action.id, fresh, { action, reason });
      return 'started';
    };

    /** Alles Laufende abbrechen: Warteschlangen leeren, Wartezeiten beenden, Rückgängig-Schritte sofort ausführen */
    const stopAll = (): Promise<void> => {
      const running = [...slots.values()];
      for (const slot of running) {
        slot.queue.length = 0;
        slot.run.cancelled = true;
        for (const wake of [...slot.run.wakers]) wake();
      }
      return Promise.all(running.map((s) => s.done)).then(() => undefined);
    };

    // -------------------------------------------------------- Auslöser

    /** Aktive Aktionen mit passendem Auslöser – oder keine, wenn der Not-Aus an ist */
    const matching = (test: (action: ObsAction) => boolean, event: StreamEvent): ObsAction[] => {
      if (event.test && !settings.get('reactToTests')) return [];
      const found = settings.get('actions').filter((a) => a.enabled && test(a));
      if (found.length && !settings.get('actionsEnabled')) {
        for (const a of found) addLog('info', a.name, 'Not-Aus ist an – nicht ausgeführt.');
        return [];
      }
      return found;
    };

    ctx.events.on('redemption', (event) => {
      for (const action of matching((a) => a.trigger.type === 'reward' && a.trigger.rewardId === event.reward.id, event)) {
        fire(action, `Kanalpunkte „${event.reward.title}“ von ${event.user.name}`);
      }
    });

    ctx.events.on('follow', (event) => {
      for (const action of matching((a) => a.trigger.type === 'follow', event)) fire(action, `Follow von ${event.user.name}`);
    });

    // Geschenk-Subs kommen zusätzlich als einzelne "sub"-Events (isGift) – die ignorieren wir, sonst löst ein 5er-Geschenk 6× aus
    ctx.events.on('sub', (event) => {
      if (event.isGift) return;
      for (const action of matching((a) => a.trigger.type === 'sub', event)) fire(action, `Sub von ${event.user.name}`);
    });
    ctx.events.on('resub', (event) => {
      for (const action of matching((a) => a.trigger.type === 'sub', event)) fire(action, `Resub von ${event.user.name} (${event.months} Monate)`);
    });
    ctx.events.on('giftsub', (event) => {
      for (const action of matching((a) => a.trigger.type === 'sub', event)) {
        fire(action, `${event.count} Geschenk-Sub(s) von ${event.user?.name ?? 'Anonym'}`);
      }
    });

    ctx.events.on('cheer', (event) => {
      const hits = matching((a) => a.trigger.type === 'cheer' && event.bits >= a.trigger.minBits, event);
      for (const action of hits) fire(action, `${event.bits} Bits von ${event.user?.name ?? 'Anonym'}`);
    });

    ctx.events.on('raid', (event) => {
      const hits = matching((a) => a.trigger.type === 'raid' && event.viewers >= a.trigger.minViewers, event);
      for (const action of hits) fire(action, `Raid von ${event.user.name} mit ${event.viewers} Zuschauern`);
    });

    ctx.events.on('chat', (event) => {
      if (ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(event.user.id)) return;
      const word = event.message.trim().split(/\s+/)[0]?.toLowerCase();
      if (!word) return;
      const hits = matching((a) => a.trigger.type === 'command' && a.trigger.command === word, event);
      if (!hits.length) return;
      const isBroadcaster = event.user.id === ctx.getUser()?.id;
      const level = roleLevel(event.badges, isBroadcaster);
      const now = Date.now();
      for (const action of hits) {
        if (action.trigger.type !== 'command') continue;
        const { role, cooldown } = action.trigger;
        if (level < ROLE_LEVEL[role]) {
          addLog('info', action.name, `${event.user.name} darf ${word} nicht benutzen (braucht „${role}“).`);
          continue;
        }
        // Cooldown gilt für alle außer dir selbst
        const last = lastCommand.get(action.id) ?? 0;
        if (!isBroadcaster && cooldown && now - last < cooldown * 1000) {
          addLog('info', action.name, `Cooldown – noch ${Math.ceil((cooldown * 1000 - (now - last)) / 1000)} s (${word} von ${event.user.name}).`);
          continue;
        }
        lastCommand.set(action.id, now);
        fire(action, `${word} von ${event.user.name}`);
      }
    });

    // -------------------------------------------------------- Verbindung

    if (settings.get('autoConnect')) client.start(connection());

    shutdown = async () => {
      if (refreshTimer) clearTimeout(refreshTimer);
      // Laufende Aktionen abbrechen und ihre Rückgängig-Schritte noch schnell ausführen (max. 3 s)
      await Promise.race([stopAll(), new Promise((resolve) => setTimeout(resolve, 3000))]);
      client.stop();
    };
    ctx.onDispose(() => client.stop());

    // -------------------------------------------------------- API

    const state = () => ({
      connection: {
        host: settings.get('host'),
        port: settings.get('port'),
        hasPassword: !!settings.get('password'),
        autoConnect: settings.get('autoConnect'),
      },
      status: { ...client.status(), currentScene: client.connected ? currentScene : null },
      actionsEnabled: settings.get('actionsEnabled'),
      reactToTests: settings.get('reactToTests'),
      actions: settings.get('actions'),
      /** Aktion-ID → wie viele Durchgänge laufen/warten */
      running: Object.fromEntries([...slots].map(([id, slot]) => [id, 1 + slot.queue.length])),
      dataVersion,
      log: [...log].reverse(),
    });

    ctx.api.get('/state', () => state());

    /** Szenen, Quellen und Filter für die Auswahllisten. ?refresh=1 lädt neu aus OBS. */
    ctx.api.get('/obs', async ({ query }) => {
      if (client.connected && (query.get('refresh') === '1' || !data)) {
        await refresh().catch((err) => {
          throw new HttpError(502, `OBS-Liste konnte nicht geladen werden: ${errorText(err)}`);
        });
      }
      return { connected: client.connected, data, dataVersion };
    });

    /** { host, port, password?, clearPassword?, autoConnect } */
    ctx.api.post('/connection', ({ body }) => {
      const host = cleanHost(body?.host);
      const port = cleanPort(body?.port);
      const patch: Partial<Settings> = { host, port, autoConnect: body?.autoConnect !== false };
      if (body?.clearPassword === true) patch.password = '';
      else if (typeof body?.password === 'string' && body.password) patch.password = body.password.slice(0, 200);
      settings.update(patch);
      // Mit den neuen Daten verbinden, wenn wir verbunden sein sollen
      if (settings.get('autoConnect') || client.status().state !== 'disconnected') client.start(connection());
      return state();
    });

    ctx.api.post('/connect', () => {
      client.start(connection());
      return state();
    });

    ctx.api.post('/disconnect', () => {
      client.stop();
      addLog('info', '', 'Verbindung zu OBS getrennt.');
      return state();
    });

    /** { actionsEnabled?, reactToTests? } */
    ctx.api.post('/settings', async ({ body }) => {
      if (typeof body?.actionsEnabled === 'boolean') {
        settings.set('actionsEnabled', body.actionsEnabled);
        if (body.actionsEnabled) {
          addLog('info', '', 'Aktionen wieder eingeschaltet.');
          ctx.log.info('OBS-Aktionen eingeschaltet');
        } else {
          addLog('warn', '', 'Not-Aus: alle Aktionen gestoppt und ausgeschaltet.');
          ctx.log.info('OBS-Aktionen ausgeschaltet (Not-Aus)');
          await stopAll();
        }
      }
      if (typeof body?.reactToTests === 'boolean') settings.set('reactToTests', body.reactToTests);
      return state();
    });

    /** Alle Kanalpunkte-Belohnungen (auch fremde – wir lesen nur die Einlösungen) */
    ctx.api.get('/rewards', async () => {
      const user = ctx.getUser();
      if (!user) throw new HttpError(401, 'Bitte zuerst in der Übersicht mit Twitch verbinden.');
      type Reward = { id: string; title: string; cost: number; is_enabled: boolean; background_color: string };
      const res = await ctx.twitch
        .request<{ data: Reward[] }>('GET', '/channel_points/custom_rewards', { query: { broadcaster_id: user.id } })
        .catch((err) => {
          if (/403/.test(errorText(err))) throw new HttpError(403, 'Kein Zugriff – Kanalpunkte gibt es nur für Affiliates und Partner.');
          throw new HttpError(502, `Belohnungen konnten nicht geladen werden: ${errorText(err)}`);
        });
      return res.data
        .map((r) => ({ id: r.id, title: r.title, cost: r.cost, enabled: r.is_enabled, color: r.background_color }))
        .sort((a, b) => a.cost - b.cost || a.title.localeCompare(b.title, 'de'));
    });

    ctx.api.post('/actions/save', ({ body }) => {
      const action = validateAction(body?.action);
      const actions = settings.get('actions');
      const exists = actions.some((a) => a.id === action.id);
      settings.set('actions', exists ? actions.map((a) => (a.id === action.id ? action : a)) : [...actions, action]);
      return action;
    });

    ctx.api.post('/actions/toggle', ({ body }) => {
      settings.set('actions', settings.get('actions').map((a) => (a.id === body?.id ? { ...a, enabled: body.enabled === true } : a)));
      return state();
    });

    ctx.api.post('/actions/delete', ({ body }) => {
      settings.set('actions', settings.get('actions').filter((a) => a.id !== body?.id));
      return state();
    });

    /** Aktion jetzt ausführen: { id } für eine gespeicherte oder { action } für eine aus dem Editor */
    ctx.api.post('/actions/test', ({ body }) => {
      // Beim Testen aus dem Editor ist der Auslöser egal – nur die Schritte müssen stimmen
      const action = body?.action
        ? validateAction({ ...body.action, trigger: { type: 'manual' } })
        : settings.get('actions').find((a) => a.id === body?.id);
      if (!action) throw new HttpError(404, 'Aktion nicht gefunden.');
      if (!client.connected) throw new HttpError(409, 'OBS ist nicht verbunden. Verbinde dich zuerst (rechts unter „Verbindung“).');
      return { result: fire(action, 'Test') };
    });

    /** Alles Laufende abbrechen, ohne den Not-Aus einzuschalten */
    ctx.api.post('/actions/stop', async () => {
      const count = slots.size;
      await stopAll();
      if (count) addLog('info', '', `${count} laufende Aktion(en) gestoppt.`);
      return state();
    });

    ctx.api.post('/log/clear', () => {
      log.length = 0;
      return state();
    });
  },

  async deactivate() {
    const fn = shutdown;
    shutdown = null;
    await fn?.();
  },
};
