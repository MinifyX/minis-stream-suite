import type { Addon, AddonContext } from '../../core/addons';
import { duration } from '../../core/chat';
import { HttpError } from '../../core/server';
import type { EventOfType } from '../../core/twitch/events';

/**
 * Lurk-Addon: Zuschauer sagen mit !lurk Bescheid, dass sie nur nebenbei zuschauen.
 * Schreiben sie danach wieder etwas in den Chat, erkennt die Suite das automatisch und
 * begrüßt sie zurück. Wie lange und wie oft jemand gelurkt hat, wird gespeichert (!lurkstats, !toplurker).
 * Lurken geht NUR über den Command – es wird nichts automatisch „erraten“.
 */

// ------------------------------------------------------------------ Datenmodell

interface LurkerStats {
  id: string;
  login: string;
  name: string;
  count: number;
  totalMs: number;
  longestMs: number;
  lastLurkAt: number;
}

interface ActiveLurk {
  id: string;
  login: string;
  name: string;
  since: number;
  /** Text nach !lurk, z.B. „bin kochen“ */
  message: string;
}

interface Settings {
  enabled: boolean;
  /** Command-Namen ohne "!" – leer = aus */
  commands: { lurk: string; unlurk: string; stats: string; top: string };
  messages: {
    lurk: string;
    lurkAgain: string;
    back: string;
    stats: string;
    statsNone: string;
    top: string;
  };
  /** „Willkommen zurück“ erst, wenn der Lurk so lange ging (kürzere Lurks enden still) */
  backMinMinutes: number;
  /** Beim Streamende alle Lurks beenden (ohne Nachricht) */
  endOnStreamEnd: boolean;
  /** Längere Lurks werden auf diese Dauer gekürzt (z.B. Suite war beim Streamende aus) */
  maxLurkHours: number;
  /** Abklingzeit für !lurkstats / !toplurker (Sekunden, pro Zuschauer) */
  statsCooldown: number;
  stats: Record<string, LurkerStats>;
  active: Record<string, ActiveLurk>;
}

const DEFAULTS: Settings = {
  enabled: true,
  commands: { lurk: 'lurk', unlurk: 'unlurk', stats: 'lurkstats', top: 'toplurker' },
  messages: {
    lurk: '{user} geht in den Lurk-Modus 👀 Danke, dass du trotzdem da bist! 💜',
    lurkAgain: '{user}, du lurkst doch schon seit {duration} 😄',
    back: 'Willkommen zurück, {user}! 👋 Du hast {duration} gelurkt.',
    stats: '{user} hat schon {count}x gelurkt, insgesamt {total} (längster Lurk: {longest}).',
    statsNone: '{user} hat noch nie gelurkt.',
    top: '🏆 Top-Lurker: {top}',
  },
  backMinMinutes: 1,
  endOnStreamEnd: true,
  maxLurkHours: 12,
  statsCooldown: 30,
  stats: {},
  active: {},
};

const CMD_RE = /^[\p{L}\p{N}_-]{1,30}$/u;
const int = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, max);
const fill = (template: string, vals: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (m, key: string) => (key.toLowerCase() in vals ? vals[key.toLowerCase()] : m));

interface Chatter {
  id: string;
  login: string;
  name: string;
}

// ------------------------------------------------------------------ Addon

export const lurkAddon: Addon = {
  id: 'lurk',
  name: 'Lurk',
  icon: '👀',
  version: '0.1.0',
  author: 'Mini',
  description: '!lurk mit automatischem „Willkommen zurück“, sobald jemand wieder schreibt. Mit Lurk-Statistik (!lurkstats, !toplurker).',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);
    const lastStats = new Map<string, number>();
    /** Lurks aus dem Test-Bereich der Oberfläche (werden nie gespeichert) */
    const testLurks = new Map<string, ActiveLurk>();

    // -------------------------------------------------------- Lurk starten/beenden

    const startLurk = (user: Chatter, message: string, now = Date.now()) => {
      settings.set('active', { ...settings.get('active'), [user.id]: { id: user.id, login: user.login, name: user.name, since: now, message } });
    };

    /** Lurk beenden und in die Statistik schreiben. Gibt die Dauer zurück (oder null, wenn gar nicht gelurkt wurde). */
    const endLurk = (userId: string, now = Date.now()): { lurk: ActiveLurk; ms: number } | null => {
      const all = settings.get('active');
      const lurk = all[userId];
      if (!lurk) return null;
      const ms = Math.min(Math.max(0, now - lurk.since), settings.get('maxLurkHours') * 3_600_000);
      const rest = { ...all };
      delete rest[userId];
      const old = settings.get('stats')[userId];
      const stats: LurkerStats = {
        id: userId,
        login: lurk.login,
        name: lurk.name,
        count: (old?.count ?? 0) + 1,
        totalMs: (old?.totalMs ?? 0) + ms,
        longestMs: Math.max(old?.longestMs ?? 0, ms),
        lastLurkAt: lurk.since,
      };
      settings.update({ active: rest, stats: { ...settings.get('stats'), [userId]: stats } });
      return { lurk, ms };
    };

    const statsText = (who: { id?: string; login?: string; name: string }) => {
      const isWho = (x: { id: string; login: string }) => (who.id && x.id === who.id) || (who.login && x.login.toLowerCase() === who.login.toLowerCase());
      const s = Object.values(settings.get('stats')).find(isWho);
      // Läuft gerade ein Lurk? Dann den laufenden mitzählen (auch beim allerersten Lurk).
      const running = Object.values(settings.get('active')).find(isWho);
      const m = settings.get('messages');
      if (!s && !running) return fill(m.statsNone, { user: who.name });
      const runningMs = running ? Math.max(0, Date.now() - running.since) : 0;
      return fill(m.stats, {
        user: s?.name ?? running!.name,
        count: String((s?.count ?? 0) + (running ? 1 : 0)),
        total: duration((s?.totalMs ?? 0) + runningMs),
        longest: duration(Math.max(s?.longestMs ?? 0, runningMs)),
        lurking: running ? 'ja' : 'nein',
      });
    };

    const topText = () => {
      const list = Object.values(settings.get('stats')).sort((a, b) => b.totalMs - a.totalMs).slice(0, 5);
      if (!list.length) return 'Noch niemand hat gelurkt 👀';
      return fill(settings.get('messages').top, { top: list.map((s, i) => `${i + 1}. ${s.name} (${duration(s.totalMs)})`).join(' · ') });
    };

    /**
     * Eine Chat-Nachricht verarbeiten. Gibt zurück, was in den Chat geschrieben würde.
     * test = Test in der Oberfläche: nichts senden, nichts in die Statistik. Test-Lurks liegen
     * nur im Arbeitsspeicher; minutesAgo lässt einen Test-Lurk „schon länger“ laufen.
     */
    const handle = (user: Chatter, text: string, test?: { minutesAgo: number }): string[] => {
      const dryRun = !!test;
      if (!settings.get('enabled')) return [];
      const out: string[] = [];
      const now = Date.now();
      const trimmed = text.trim();
      const [first, ...rest] = trimmed.startsWith('!') ? trimmed.slice(1).split(/\s+/) : [''];
      const cmd = (first ?? '').toLowerCase();
      const commands = settings.get('commands');
      const messages = settings.get('messages');
      const statsCooldown = settings.get('statsCooldown');
      const active = test ? testLurks.get(user.id) : settings.get('active')[user.id];

      if (cmd && cmd === commands.lurk) {
        if (active) {
          out.push(fill(messages.lurkAgain, { user: user.name, duration: duration(now - active.since), message: active.message }));
        } else {
          const message = oneLine(rest.join(' '), 200);
          if (test) testLurks.set(user.id, { id: user.id, login: user.login, name: user.name, since: now - test.minutesAgo * 60_000, message });
          else startLurk(user, message, now);
          out.push(fill(messages.lurk, { user: user.name, message }));
        }
        return out;
      }
      if (cmd && cmd === commands.stats) {
        const last = lastStats.get(user.id) ?? 0;
        if (!dryRun && now - last < statsCooldown * 1000) return out;
        if (!dryRun) lastStats.set(user.id, now);
        const target = rest[0]?.replace(/^@/, '');
        out.push(target ? statsText({ login: target, name: target }) : statsText({ id: user.id, name: user.name }));
        return out;
      }
      if (cmd && cmd === commands.top) {
        const last = lastStats.get(`top:${user.id}`) ?? 0;
        if (!dryRun && now - last < statsCooldown * 1000) return out;
        if (!dryRun) lastStats.set(`top:${user.id}`, now);
        out.push(topText());
        return out;
      }

      // Jede andere Nachricht (auch !unlurk) = wieder da
      if (active) {
        let ended: { lurk: ActiveLurk; ms: number } | null;
        if (test) {
          testLurks.delete(user.id);
          ended = { lurk: active, ms: now - active.since };
        } else {
          ended = endLurk(user.id, now);
        }
        if (ended && ended.ms >= settings.get('backMinMinutes') * 60_000) {
          out.push(fill(messages.back, { user: user.name, duration: duration(ended.ms), message: ended.lurk.message }));
        }
      }
      return out;
    };

    ctx.events.on('chat', (event: EventOfType<'chat'>) => {
      if (event.test || ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(event.user.id)) return;
      for (const text of handle(event.user, event.message)) {
        ctx.chat.send(text).catch((err) => ctx.log.warn('Chat-Nachricht fehlgeschlagen:', err));
      }
    });

    /** Alle laufenden Lurks still beenden (zählt bis jetzt) */
    const endAll = () => {
      const ids = Object.keys(settings.get('active'));
      const now = Date.now();
      for (const id of ids) endLurk(id, now);
      return ids.length;
    };

    ctx.events.on('streamoffline', (e) => {
      if (e.test || !settings.get('endOnStreamEnd')) return;
      const n = endAll();
      if (n) ctx.log.info(`Stream beendet: ${n} Lurk(s) beendet`);
    });

    // -------------------------------------------------------- API

    const publicState = () => {
      const now = Date.now();
      return {
        settings: { ...settings.all(), stats: undefined, active: undefined },
        active: Object.values(settings.get('active'))
          .sort((a, b) => a.since - b.since)
          .map((l) => ({ ...l, ms: now - l.since })),
        stats: Object.values(settings.get('stats')).sort((a, b) => b.totalMs - a.totalMs),
        now,
      };
    };

    ctx.api.get('/state', publicState);

    ctx.api.post('/settings', ({ body }) => {
      const s = settings.all();
      if (typeof body?.enabled === 'boolean') s.enabled = body.enabled;
      if (body?.commands) {
        const c = body.commands;
        const clean = (v: unknown) => String(v ?? '').trim().replace(/^!+/, '').toLowerCase();
        const commands = { lurk: clean(c.lurk), unlurk: clean(c.unlurk), stats: clean(c.stats), top: clean(c.top) };
        if (!CMD_RE.test(commands.lurk)) throw new HttpError(400, 'Der Lurk-Command braucht einen gültigen Namen.');
        for (const [key, name] of Object.entries(commands)) {
          if (name && !CMD_RE.test(name)) throw new HttpError(400, `Ungültiger Command-Name: „${name}“.`);
          if (name && Object.entries(commands).some(([k, n]) => k !== key && n === name)) throw new HttpError(400, `„!${name}“ ist doppelt vergeben.`);
        }
        s.commands = commands;
      }
      if (body?.messages) {
        const m = body.messages;
        s.messages = {
          lurk: oneLine(m.lurk, 500),
          lurkAgain: oneLine(m.lurkAgain, 500),
          back: oneLine(m.back, 500),
          stats: oneLine(m.stats, 500),
          statsNone: oneLine(m.statsNone, 500),
          top: oneLine(m.top, 500),
        };
      }
      if (body?.backMinMinutes !== undefined) s.backMinMinutes = int(body.backMinMinutes, 0, 600);
      if (typeof body?.endOnStreamEnd === 'boolean') s.endOnStreamEnd = body.endOnStreamEnd;
      if (body?.maxLurkHours !== undefined) s.maxLurkHours = int(body.maxLurkHours, 1, 48);
      if (body?.statsCooldown !== undefined) s.statsCooldown = int(body.statsCooldown, 0, 3600);
      settings.update({
        enabled: s.enabled,
        commands: s.commands,
        messages: s.messages,
        backMinMinutes: s.backMinMinutes,
        endOnStreamEnd: s.endOnStreamEnd,
        maxLurkHours: s.maxLurkHours,
        statsCooldown: s.statsCooldown,
      });
      return publicState();
    });

    /** Trockenlauf: Was würde die Suite antworten? Speichert nichts, sendet nichts. */
    ctx.api.post('/test', ({ body }) => {
      const name = oneLine(body?.user, 25) || 'TestUser';
      const user = { id: `test:${name.toLowerCase()}`, login: name.toLowerCase(), name };
      const replies = handle(user, String(body?.message ?? ''), { minutesAgo: int(body?.minutesAgo, 0, 24 * 60) });
      return { replies, lurking: testLurks.has(user.id) };
    });

    /** Lurk von Hand beenden (zählt bis jetzt, ohne Nachricht) */
    ctx.api.post('/end', ({ body }) => {
      if (body?.all === true) endAll();
      else endLurk(String(body?.id ?? ''));
      return publicState();
    });

    /** Lurk von Hand verwerfen (zählt NICHT in die Statistik) */
    ctx.api.post('/discard', ({ body }) => {
      const rest = { ...settings.get('active') };
      delete rest[String(body?.id ?? '')];
      settings.set('active', rest);
      return publicState();
    });

    ctx.api.post('/stats/delete', ({ body }) => {
      const rest = { ...settings.get('stats') };
      delete rest[String(body?.id ?? '')];
      settings.set('stats', rest);
      return publicState();
    });

    ctx.api.post('/stats/reset', () => {
      settings.set('stats', {});
      return publicState();
    });

    // Beim Start: Ist der Stream offline und laufen noch Lurks (Suite war beim Streamende aus)? → beenden
    let tries = 0;
    let startup: NodeJS.Timeout | null = null;
    const checkOffline = async () => {
      const me = ctx.getUser();
      if (!me) {
        if (++tries < 30) startup = setTimeout(checkOffline, 2000);
        return;
      }
      if (!settings.get('endOnStreamEnd') || !Object.keys(settings.get('active')).length) return;
      try {
        const res = await ctx.twitch.request<{ data: unknown[] }>('GET', '/streams', { query: { user_id: me.id } });
        if (!res.data.length) {
          const n = endAll();
          ctx.log.info(`Stream ist offline: ${n} alte(n) Lurk(s) beendet`);
        }
      } catch {
        // egal, nächstes Mal
      }
    };
    startup = setTimeout(checkOffline, 3000);
    ctx.onDispose(() => {
      if (startup) clearTimeout(startup);
    });
  },
};
