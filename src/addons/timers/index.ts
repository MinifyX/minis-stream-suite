import { randomUUID } from 'node:crypto';
import type { Addon, AddonContext } from '../../core/addons';
import { HttpError } from '../../core/server';

// ------------------------------------------------------------------ Datenmodell

interface Game {
  id: string;
  name: string;
}

interface Timer {
  id: string;
  name: string;
  enabled: boolean;
  /** Eine oder mehrere Nachrichten, die sich abwechseln */
  messages: string[];
  order: 'sequence' | 'random';
  /** Frühestens alle X Minuten */
  intervalMinutes: number;
  /** … und nur, wenn seit der letzten Timer-Nachricht so viele Chat-Nachrichten kamen */
  minChatLines: number;
  /** Nur wenn der Stream live ist */
  onlyLive: boolean;
  /** Nur bei diesen Spielen (leer = immer) */
  games: Game[];
  /** Welche Nachricht als Nächstes kommt (bei "sequence") */
  nextIndex: number;
}

interface Settings {
  timers: Timer[];
  /** Mindestabstand zwischen zwei Timer-Nachrichten (egal welcher Timer) */
  minGapSeconds: number;
}

const DEFAULTS: Settings = { timers: [], minGapSeconds: 60 };
const TICK_MS = 10_000;

type Waiting = 'disabled' | 'offline' | 'game' | 'time' | 'lines' | 'gap' | 'ready';

function validateTimer(input: unknown): Omit<Timer, 'nextIndex'> {
  const t = (input ?? {}) as Record<string, unknown>;
  const name = String(t.name ?? '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, 'Der Timer braucht einen Namen.');
  const messages = (Array.isArray(t.messages) ? t.messages : [])
    .map((m) => String(m ?? '').replace(/\s*\r?\n\s*/g, ' ').trim())
    .filter(Boolean);
  if (!messages.length) throw new HttpError(400, 'Mindestens eine Nachricht ist nötig.');
  if (messages.length > 20) throw new HttpError(400, 'Höchstens 20 Nachrichten pro Timer.');
  if (messages.some((m) => m.length > 500)) throw new HttpError(400, 'Eine Nachricht darf höchstens 500 Zeichen haben.');
  const int = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
  const games = (Array.isArray(t.games) ? t.games : [])
    .filter((g: Partial<Game>) => typeof g?.id === 'string' && g.id && typeof g.name === 'string')
    .map((g: Game) => ({ id: g.id, name: g.name.slice(0, 100) }));
  return {
    id: typeof t.id === 'string' && t.id ? t.id : randomUUID(),
    name,
    enabled: t.enabled !== false,
    messages,
    order: t.order === 'random' ? 'random' : 'sequence',
    intervalMinutes: int(t.intervalMinutes, 1, 720),
    minChatLines: int(t.minChatLines, 0, 500),
    onlyLive: t.onlyLive !== false,
    games,
  };
}

// ------------------------------------------------------------------ Addon

export const timersAddon: Addon = {
  id: 'timers',
  name: 'Timer-Nachrichten',
  icon: '⏰',
  version: '0.1.0',
  author: 'Mini',
  description: 'Automatische Chat-Nachrichten alle X Minuten, nur wenn live und genug im Chat los ist.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);

    // Laufzeit-Zustand (wird nicht gespeichert)
    let live: boolean | null = null;
    let game: Game | null = null;
    let lastAnyTimer = 0;
    const lastSent = new Map<string, number>();
    const linesSince = new Map<string, number>();
    const startedAt = Date.now();
    const lastMessage = new Map<string, string>();

    /** Nach dem Start / Live-Gehen soll nicht sofort alles feuern → Uhr bei jetzt starten */
    const resetClocks = () => {
      const now = Date.now();
      for (const t of settings.get('timers')) {
        lastSent.set(t.id, now);
        linesSince.set(t.id, 0);
      }
    };

    const loadChannel = async () => {
      const user = ctx.getUser();
      if (!user) return false;
      const [streams, channels] = await Promise.all([
        ctx.twitch.request<{ data: unknown[] }>('GET', '/streams', { query: { user_id: user.id } }),
        ctx.twitch.request<{ data: { game_id: string; game_name: string }[] }>('GET', '/channels', { query: { broadcaster_id: user.id } }),
      ]);
      live = streams.data.length > 0;
      const info = channels.data[0];
      game = info ? { id: info.game_id, name: info.game_name } : null;
      return true;
    };

    // Beim Start Live-Status und Spiel holen (Login kann etwas dauern)
    let startupTimer: NodeJS.Timeout | null = null;
    let tries = 0;
    const startup = async () => {
      try {
        if (await loadChannel()) return;
      } catch (err) {
        ctx.log.warn('Live-Status konnte nicht geladen werden:', err);
      }
      if (++tries < 30) startupTimer = setTimeout(startup, 2000);
    };
    startupTimer = setTimeout(startup, 1000);

    ctx.events.on('streamonline', (e) => {
      if (e.test) return;
      live = true;
      resetClocks();
      ctx.log.info('Stream ist live – Timer starten');
    });
    ctx.events.on('streamoffline', (e) => {
      if (e.test) return;
      live = false;
      ctx.log.info('Stream beendet – Timer pausieren');
    });
    ctx.events.on('channelupdate', (e) => {
      if (e.test) return;
      game = { id: e.categoryId, name: e.categoryName };
    });
    ctx.events.on('chat', (e) => {
      if (e.test || ctx.chat.isOwnMessage(e.messageId)) return;
      for (const t of settings.get('timers')) linesSince.set(t.id, (linesSince.get(t.id) ?? 0) + 1);
    });

    /** Warum ein Timer gerade (nicht) sendet + wann frühestens */
    const statusOf = (t: Timer, now = Date.now()): { waiting: Waiting; nextAt: number | null } => {
      const sent = lastSent.get(t.id) ?? startedAt;
      const dueAt = sent + t.intervalMinutes * 60_000;
      if (!t.enabled) return { waiting: 'disabled', nextAt: null };
      if (t.onlyLive && live !== true) return { waiting: 'offline', nextAt: null };
      if (t.games.length && !t.games.some((g) => g.id === game?.id)) return { waiting: 'game', nextAt: null };
      if (now < dueAt) return { waiting: 'time', nextAt: dueAt };
      if ((linesSince.get(t.id) ?? 0) < t.minChatLines) return { waiting: 'lines', nextAt: null };
      const gapAt = lastAnyTimer + settings.get('minGapSeconds') * 1000;
      if (now < gapAt) return { waiting: 'gap', nextAt: gapAt };
      return { waiting: 'ready', nextAt: now };
    };

    /** Nächste Nachricht eines Timers auswählen und senden */
    const fire = async (t: Timer, reason: string) => {
      let index: number;
      if (t.order === 'random' && t.messages.length > 1) {
        // Zufällig, aber möglichst nie zweimal dieselbe hintereinander
        const candidates = t.messages.map((_, i) => i).filter((i) => t.messages[i] !== lastMessage.get(t.id));
        const pool = candidates.length ? candidates : t.messages.map((_, i) => i);
        index = pool[Math.floor(Math.random() * pool.length)];
      } else {
        index = t.nextIndex % t.messages.length;
      }
      const now = Date.now();
      lastSent.set(t.id, now);
      linesSince.set(t.id, 0);
      lastAnyTimer = now;
      lastMessage.set(t.id, t.messages[index]);
      settings.set('timers', settings.get('timers').map((x) => (x.id === t.id ? { ...x, nextIndex: (index + 1) % t.messages.length } : x)));
      const text = await ctx.chat.render(t.messages[index]);
      await ctx.chat.send(text);
      ctx.log.info(`Timer „${t.name}“ gesendet (${reason})`);
    };

    // Alle 10 Sekunden prüfen – pro Durchgang höchstens EINE Nachricht
    let busy = false;
    const tick = setInterval(async () => {
      if (busy || !ctx.getUser()) return;
      const now = Date.now();
      const ready = settings.get('timers')
        .filter((t) => statusOf(t, now).waiting === 'ready')
        .sort((a, b) => (lastSent.get(a.id) ?? startedAt) - (lastSent.get(b.id) ?? startedAt));
      if (!ready.length) return;
      busy = true;
      try {
        await fire(ready[0], 'automatisch');
      } catch (err) {
        ctx.log.warn(`Timer „${ready[0].name}“ fehlgeschlagen:`, err);
      } finally {
        busy = false;
      }
    }, TICK_MS);

    ctx.onDispose(() => {
      clearInterval(tick);
      if (startupTimer) clearTimeout(startupTimer);
    });

    // -------------------------------------------------------- API

    ctx.api.get('/state', () => {
      const now = Date.now();
      return {
        settings: settings.all(),
        live,
        game,
        status: Object.fromEntries(settings.get('timers').map((t) => {
          const s = statusOf(t, now);
          return [t.id, { ...s, linesSince: linesSince.get(t.id) ?? 0, lastSent: lastSent.get(t.id) ?? null }];
        })),
      };
    });

    ctx.api.post('/settings', ({ body }) => {
      if (body?.minGapSeconds !== undefined) {
        settings.set('minGapSeconds', Math.max(0, Math.min(3600, Math.round(Number(body.minGapSeconds) || 0))));
      }
      return settings.all();
    });

    ctx.api.post('/timers/save', ({ body }) => {
      const timer = validateTimer(body?.timer);
      const timers = settings.get('timers');
      const existing = timers.find((t) => t.id === timer.id);
      const full: Timer = { ...timer, nextIndex: existing ? existing.nextIndex % timer.messages.length : 0 };
      settings.set('timers', existing ? timers.map((t) => (t.id === full.id ? full : t)) : [...timers, full]);
      // Neuer Timer: Uhr ab jetzt, damit er nicht sofort losfeuert
      if (!existing) {
        lastSent.set(full.id, Date.now());
        linesSince.set(full.id, 0);
      }
      return full;
    });

    ctx.api.post('/timers/toggle', ({ body }) => {
      settings.set('timers', settings.get('timers').map((t) => (t.id === body?.id ? { ...t, enabled: body.enabled === true } : t)));
      if (body?.enabled === true) {
        lastSent.set(String(body.id), Date.now());
        linesSince.set(String(body.id), 0);
      }
    });

    ctx.api.post('/timers/delete', ({ body }) => {
      settings.set('timers', settings.get('timers').filter((t) => t.id !== body?.id));
      lastSent.delete(String(body?.id));
      linesSince.delete(String(body?.id));
    });

    /** Nächste Nachricht jetzt sofort senden (Knopf in der Oberfläche) */
    ctx.api.post('/timers/send-now', async ({ body }) => {
      const timer = settings.get('timers').find((t) => t.id === body?.id);
      if (!timer) throw new HttpError(404, 'Timer nicht gefunden');
      if (!ctx.getUser()) throw new HttpError(401, 'Nicht bei Twitch eingeloggt');
      await fire(timer, 'von Hand');
    });

    /** Vorschau einer Nachricht mit eingesetzten Variablen (sendet nichts) */
    ctx.api.post('/preview', async ({ body }) => ({ text: await ctx.chat.render(String(body?.message ?? '')) }));

    /** Spiele suchen (für "nur bei Spiel") */
    ctx.api.get('/games/search', async ({ query }) => {
      const q = String(query.get('q') ?? '').trim();
      if (!q) return [];
      const res = await ctx.twitch.request<{ data: { id: string; name: string; box_art_url: string }[] }>('GET', '/search/categories', {
        query: { query: q, first: '12' },
      });
      return res.data.map((g) => ({ id: g.id, name: g.name, image: g.box_art_url.replace('{width}', '52').replace('{height}', '72') }));
    });
  },
};
