import { randomUUID } from 'node:crypto';
import type { Addon, AddonContext } from '../../core/addons';
import { parseTarget, runKeys, targetProblem, type KeyTarget } from '../../core/keyActions';
import { validateSteps, type KeyStep } from '../../core/keyboard';
import { HttpError } from '../../core/server';
import type { EventOfType } from '../../core/twitch/events';

// ------------------------------------------------------------------ Datenmodell

const PERMISSIONS = ['everyone', 'subscriber', 'vip', 'moderator', 'broadcaster'] as const;
type Permission = (typeof PERMISSIONS)[number];

interface CommandKeybind {
  enabled: boolean;
  steps: KeyStep[];
  target: KeyTarget;
}

interface Command {
  id: string;
  /** ohne Präfix, klein geschrieben, z.B. "discord" */
  name: string;
  aliases: string[];
  enabled: boolean;
  /** Antwort im Chat (leer = keine Antwort, z.B. nur Keybind) */
  response: string;
  /** Als Antwort auf die Nachricht (Thread) statt normaler Nachricht */
  reply: boolean;
  permission: Permission;
  /** Sekunden, bevor der Command wieder benutzt werden kann (für alle) */
  cooldownGlobal: number;
  /** Sekunden pro Zuschauer */
  cooldownUser: number;
  /** Wie oft der Command benutzt wurde ({count}) */
  count: number;
  keybind: CommandKeybind | null;
}

interface Settings {
  prefix: string;
  /** Mods und du selbst ignorieren Cooldowns */
  modsIgnoreCooldown: boolean;
  commands: Command[];
}

const DEFAULTS: Settings = { prefix: '!', modsIgnoreCooldown: true, commands: [] };

type Result = 'ok' | 'no-permission' | 'cooldown' | 'error';

interface HistoryEntry {
  time: number;
  user: string;
  command: string;
  result: Result;
  detail: string;
}

const LEVEL: Record<Permission, number> = { everyone: 0, subscriber: 1, vip: 2, moderator: 3, broadcaster: 4 };
const NAME_RE = /^[\p{L}\p{N}_-]{1,30}$/u;

/** Berechtigungsstufe eines Chatters aus seinen Abzeichen */
function levelOf(badges: string[], isBroadcaster: boolean): number {
  if (isBroadcaster || badges.includes('broadcaster')) return LEVEL.broadcaster;
  if (badges.includes('moderator') || badges.includes('lead_moderator')) return LEVEL.moderator;
  if (badges.includes('vip')) return LEVEL.vip;
  if (badges.includes('subscriber') || badges.includes('founder')) return LEVEL.subscriber;
  return LEVEL.everyone;
}

// ------------------------------------------------------------------ Eingaben prüfen

function cleanName(value: unknown): string {
  return String(value ?? '').trim().replace(/^[!?#.$%&~]+/, '').toLowerCase();
}

function validateCommand(input: unknown, others: Command[]): Command {
  const c = (input ?? {}) as Record<string, unknown>;
  const name = cleanName(c.name);
  if (!NAME_RE.test(name)) throw new HttpError(400, 'Der Name darf nur Buchstaben, Zahlen, _ und - enthalten (max. 30 Zeichen).');
  const aliases = [...new Set((Array.isArray(c.aliases) ? c.aliases : []).map(cleanName).filter(Boolean))].filter((a) => a !== name);
  const bad = aliases.find((a) => !NAME_RE.test(a));
  if (bad) throw new HttpError(400, `Ungültiger Alias „${bad}“.`);
  const taken = new Map(others.flatMap((o) => [o.name, ...o.aliases].map((n) => [n, o.name] as const)));
  for (const n of [name, ...aliases]) {
    if (taken.has(n)) throw new HttpError(400, `„${n}“ wird schon vom Command „${taken.get(n)}“ benutzt.`);
  }
  const response = String(c.response ?? '').replace(/\s*\r?\n\s*/g, ' ').trim();
  if (response.length > 500) throw new HttpError(400, 'Die Antwort darf höchstens 500 Zeichen haben.');
  const num = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));

  let keybind: CommandKeybind | null = null;
  if (c.keybind && typeof c.keybind === 'object') {
    const k = c.keybind as Record<string, unknown>;
    try {
      keybind = { enabled: k.enabled !== false, steps: validateSteps(k.steps), target: parseTarget(k.target) };
    } catch (err) {
      throw new HttpError(400, `Keybind: ${(err as Error).message}`);
    }
  }
  if (!response && !keybind) throw new HttpError(400, 'Der Command braucht eine Antwort oder einen Keybind.');

  return {
    id: typeof c.id === 'string' && c.id ? c.id : randomUUID(),
    name,
    aliases,
    enabled: c.enabled !== false,
    response,
    reply: c.reply === true,
    permission: PERMISSIONS.includes(c.permission as Permission) ? (c.permission as Permission) : 'everyone',
    cooldownGlobal: num(c.cooldownGlobal, 86_400),
    cooldownUser: num(c.cooldownUser, 86_400),
    count: num(c.count, 1_000_000_000),
    keybind,
  };
}

// ------------------------------------------------------------------ Addon

export const commandsAddon: Addon = {
  id: 'commands',
  name: 'Chat-Commands',
  icon: '💬',
  version: '0.1.0',
  author: 'Mini',
  description: 'Eigene !commands mit Variablen, Rechten, Cooldowns und Keybinds (auch per Satellite).',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);
    const history: HistoryEntry[] = [];
    const lastGlobal = new Map<string, number>();
    const lastUser = new Map<string, number>();
    const addHistory = (entry: Omit<HistoryEntry, 'time'>) => {
      history.push({ time: Date.now(), ...entry });
      if (history.length > 50) history.shift();
    };

    /** Setzt alle {Variablen} ein (gemeinsamer Baustein im Core) */
    const render = (cmd: Command, chatter: { id: string; name: string }, args: string[]) => {
      const prefix = settings.get('prefix');
      const everyone = settings.get('commands').filter((c) => c.enabled && c.permission === 'everyone').map((c) => prefix + c.name);
      return ctx.chat.render(cmd.response, { user: chatter, args, values: { count: String(cmd.count), commands: everyone.join(' ') } });
    };

    // -------------------------------------------------------- Command-Erkennung

    const findCommand = (message: string): { cmd: Command; args: string[]; used: string } | null => {
      const prefix = settings.get('prefix');
      const text = message.trim();
      if (!text.startsWith(prefix)) return null;
      const [first, ...args] = text.slice(prefix.length).split(/\s+/);
      const used = (first ?? '').toLowerCase();
      if (!used) return null;
      const cmd = settings.get('commands').find((c) => c.enabled && (c.name === used || c.aliases.includes(used)));
      return cmd ? { cmd, args, used } : null;
    };

    /** Prüft Rechte und Cooldowns. Gibt null zurück, wenn der Command laufen darf, sonst den Grund. */
    const check = (cmd: Command, userId: string, level: number, ignoreCooldown = false): { result: Result; detail: string } | null => {
      if (level < LEVEL[cmd.permission]) return { result: 'no-permission', detail: `braucht „${cmd.permission}“` };
      if (ignoreCooldown || (settings.get('modsIgnoreCooldown') && level >= LEVEL.moderator)) return null;
      const now = Date.now();
      const g = lastGlobal.get(cmd.id) ?? 0;
      if (cmd.cooldownGlobal && now - g < cmd.cooldownGlobal * 1000) {
        return { result: 'cooldown', detail: `noch ${Math.ceil((cmd.cooldownGlobal * 1000 - (now - g)) / 1000)} s (alle)` };
      }
      const u = lastUser.get(`${cmd.id}:${userId}`) ?? 0;
      if (cmd.cooldownUser && now - u < cmd.cooldownUser * 1000) {
        return { result: 'cooldown', detail: `noch ${Math.ceil((cmd.cooldownUser * 1000 - (now - u)) / 1000)} s (pro Zuschauer)` };
      }
      return null;
    };

    ctx.events.on('chat', async (event: EventOfType<'chat'>) => {
      if (event.test || ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(event.user.id)) return;
      const found = findCommand(event.message);
      if (!found) return;
      const { cmd, args, used } = found;
      const broadcaster = ctx.getUser();
      const level = levelOf(event.badges, event.user.id === broadcaster?.id);
      const blocked = check(cmd, event.user.id, level);
      if (blocked) {
        addHistory({ user: event.user.name, command: used, ...blocked });
        return;
      }

      const now = Date.now();
      lastGlobal.set(cmd.id, now);
      lastUser.set(`${cmd.id}:${event.user.id}`, now);
      // Zähler hochzählen (vor dem Einsetzen, damit {count} schon die neue Zahl zeigt)
      const commands = settings.get('commands').map((c) => (c.id === cmd.id ? { ...c, count: c.count + 1 } : c));
      settings.set('commands', commands);
      const current = commands.find((c) => c.id === cmd.id)!;

      try {
        let text = '';
        if (current.response) {
          text = await render(current, event.user, args);
          if (text) await ctx.chat.send(text, current.reply ? event.messageId : undefined);
        }
        if (current.keybind?.enabled) {
          void runKeys(current.keybind.target, current.keybind.steps, `${settings.get('prefix')}${current.name}`).catch((err) =>
            ctx.log.warn(`Keybind von ${settings.get('prefix')}${current.name} fehlgeschlagen:`, err));
        }
        addHistory({ user: event.user.name, command: used, result: 'ok', detail: text || '(nur Keybind)' });
      } catch (err) {
        ctx.log.warn(`Command ${settings.get('prefix')}${used} fehlgeschlagen:`, err);
        addHistory({ user: event.user.name, command: used, result: 'error', detail: (err as Error).message });
      }
    });

    // -------------------------------------------------------- API

    ctx.api.get('/state', () => ({ settings: settings.all(), history: [...history].reverse() }));

    ctx.api.post('/settings', ({ body }) => {
      if (typeof body?.prefix === 'string') {
        const prefix = body.prefix.trim();
        if (!/^\S{1,3}$/.test(prefix)) throw new HttpError(400, 'Das Präfix muss 1 bis 3 Zeichen lang sein, ohne Leerzeichen.');
        settings.set('prefix', prefix);
      }
      if (typeof body?.modsIgnoreCooldown === 'boolean') settings.set('modsIgnoreCooldown', body.modsIgnoreCooldown);
      return settings.all();
    });

    ctx.api.post('/commands/save', ({ body }) => {
      const commands = settings.get('commands');
      const existing = commands.find((c) => c.id === body?.command?.id);
      const cmd = validateCommand(body?.command, commands.filter((c) => c.id !== existing?.id));
      settings.set('commands', existing ? commands.map((c) => (c.id === existing.id ? cmd : c)) : [...commands, cmd]);
      return cmd;
    });

    ctx.api.post('/commands/toggle', ({ body }) => {
      settings.set('commands', settings.get('commands').map((c) => (c.id === body?.id ? { ...c, enabled: body.enabled === true } : c)));
    });

    ctx.api.post('/commands/delete', ({ body }) => {
      settings.set('commands', settings.get('commands').filter((c) => c.id !== body?.id));
    });

    /** Trockenlauf: Was würde bei dieser Chat-Nachricht passieren? Sendet nichts, zählt nicht mit. */
    ctx.api.post('/test', async ({ body }) => {
      const message = String(body?.message ?? '');
      const role = PERMISSIONS.includes(body?.role) ? (body.role as Permission) : 'everyone';
      const found = findCommand(message);
      if (!found) return { matched: null };
      const { cmd, args } = found;
      const blocked = check(cmd, 'test-user', LEVEL[role], body?.ignoreCooldown !== false);
      if (blocked) return { matched: cmd.name, ...blocked };
      const me = ctx.getUser();
      const fake = role === 'broadcaster' && me ? { id: me.id, name: me.displayName } : { id: '0', name: 'TestUser' };
      const text = cmd.response ? await render({ ...cmd, count: cmd.count + 1 }, fake, args) : '';
      return { matched: cmd.name, result: 'ok', response: text, keybind: cmd.keybind?.enabled ? cmd.keybind : null };
    });

    /** Keybind eines Commands testen (nach kurzer Wartezeit) */
    ctx.api.post('/keybind-test', ({ body }) => {
      let steps: KeyStep[];
      try {
        steps = validateSteps(body?.steps);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      const target = parseTarget(body?.target);
      const problem = targetProblem(target);
      if (problem) throw new HttpError(400, problem);
      setTimeout(() => {
        runKeys(target, steps, 'Command-Test').catch((err) => ctx.log.warn('Keybind-Test fehlgeschlagen:', err));
      }, 3000);
    });
  },
};
