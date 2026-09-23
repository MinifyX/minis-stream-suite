import type { Addon, AddonContext } from '../../core/addons';
import { roleLevel } from '../../core/chat';
import { HttpError } from '../../core/server';
import type { EventOfType } from '../../core/twitch/events';
import {
  DEFAULT_SETTINGS,
  LEVEL,
  RULE_IDS,
  RULE_NAMES,
  RepeatTracker,
  ROLES,
  StrikeTracker,
  checkMessage,
  countsAsStrike,
  decide,
  exemptReason,
  formatSeconds,
  normalizeSettings,
  type ActionKind,
  type Decision,
  type Hit,
  type ModSettings,
  type Role,
  type RuleId,
} from './rules';

/**
 * Spam-Schutz: löscht Links, Großbuchstaben-Geschrei, verbotene Wörter und Spam aus dem Chat –
 * auf Wunsch mit Timeout und Warnung. Die eigentliche Prüfung steckt in rules.ts.
 *
 * Gehandelt wird mit deinem eigenen Account (du bist im eigenen Kanal automatisch Mod).
 * Dauerhafte Banns gibt es hier absichtlich nicht – nur Timeouts, die man rückgängig machen kann.
 */

// ------------------------------------------------------------------ Protokoll

interface LogEntry {
  id: number;
  time: number;
  userId: string;
  login: string;
  name: string;
  rule: RuleId;
  reason: string;
  /** Anfang der Nachricht */
  excerpt: string;
  action: ActionKind;
  seconds: number;
  /** Wievielter Verstoß (nur mit Eskalation) */
  strike: number;
  /** „Nur testen“ war an: es ist nichts passiert */
  dryRun: boolean;
  /** Text der Warnung im Chat ('' = keine gesendet) */
  warning: string;
  /** Fehler von Twitch, falls die Aktion nicht geklappt hat */
  error: string;
  /** Timeout wurde rückgängig gemacht */
  undone: boolean;
}

const MAX_LOG = 200;
/** Mehr Twitch-Aufrufe auf einmal werden übersprungen (z.B. bei einer Spam-Welle) */
const MAX_PENDING = 25;
/** Dieselbe Person bekommt höchstens so oft eine Warnung */
const WARN_PER_USER_MS = 60_000;

const fill = (template: string, vals: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (m, key: string) => (key.toLowerCase() in vals ? vals[key.toLowerCase()] : m));

/** Einstellungen zusammenführen: nur das ändern, was mitgeschickt wurde (auch einzelne Regeln) */
function mergeSettings(current: ModSettings, patch: Record<string, unknown>): ModSettings {
  const rulesPatch = (patch.rules ?? {}) as Record<string, object>;
  const rules = Object.fromEntries(RULE_IDS.map((id) => [id, { ...current.rules[id], ...(rulesPatch[id] ?? {}) }]));
  return normalizeSettings({
    ...current,
    ...patch,
    permit: { ...current.permit, ...((patch.permit as object) ?? {}) },
    escalation: { ...current.escalation, ...((patch.escalation as object) ?? {}) },
    rules,
  });
}

// ------------------------------------------------------------------ Addon

export const modguardAddon: Addon = {
  id: 'modguard',
  name: 'Spam-Schutz',
  icon: '🛡️',
  version: '0.1.0',
  author: 'Mini',
  description: 'Löscht Links, Caps-Geschrei, verbotene Wörter und Spam – mit Timeouts, Warnungen, !permit und Test-Modus.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const store = ctx.settings<ModSettings>(DEFAULT_SETTINGS);
    // Alte oder unvollständige Einstellungen reparieren (der Speicher füllt nur eine Ebene auf)
    let s = normalizeSettings(store.all());
    store.update(s);

    const log: LogEntry[] = [];
    let nextId = 1;
    const repeats = new RepeatTracker();
    const strikes = new StrikeTracker();
    /** !permit: login → erlaubt bis */
    const permits = new Map<string, number>();
    /** Wer gerade von uns getimeoutet wurde (keine doppelten Aktionen): userId → bis */
    const timedOut = new Map<string, number>();
    let lastWarn = 0;
    const lastWarnUser = new Map<string, number>();
    /** Eigene Merker für den Test-Bereich (berühren den echten Chat nicht) */
    const testRepeats = new RepeatTracker();
    const testStrikes = new StrikeTracker();

    const escalationMs = () => s.escalation.windowMinutes * 60_000;
    const repeatMs = () => s.rules.repeat.windowSeconds * 1000;

    // -------------------------------------------------------- Twitch (eine Aktion nach der anderen)

    let queue: Promise<void> = Promise.resolve();
    let pending = 0;
    const enqueue = (job: () => Promise<unknown>): Promise<void> => {
      if (pending >= MAX_PENDING) return Promise.reject(new Error('Zu viele Aktionen auf einmal – übersprungen'));
      pending++;
      const run = queue.then(job).then(() => {}).finally(() => {
        pending--;
      });
      queue = run.catch(() => {});
      return run;
    };

    const deleteMessage = (broadcasterId: string, messageId: string) =>
      ctx.twitch.request('DELETE', '/moderation/chat', {
        query: { broadcaster_id: broadcasterId, moderator_id: broadcasterId, message_id: messageId },
      });

    const timeoutUser = (broadcasterId: string, userId: string, seconds: number, reason: string) =>
      ctx.twitch.request('POST', '/moderation/bans', {
        query: { broadcaster_id: broadcasterId, moderator_id: broadcasterId },
        body: { data: { user_id: userId, duration: seconds, reason: reason.slice(0, 500) } },
      });

    /** Hebt Timeouts (und Banns) auf */
    const unbanUser = (broadcasterId: string, userId: string) =>
      ctx.twitch.request('DELETE', '/moderation/bans', {
        query: { broadcaster_id: broadcasterId, moderator_id: broadcasterId, user_id: userId },
      });

    // -------------------------------------------------------- Warnungen (sparsam, damit der Schutz nicht selbst spammt)

    const warningText = (hit: Hit, decision: Decision, name: string) => {
      const template = s.rules[hit.rule].message;
      if (!template || !decision.warn) return '';
      return fill(template, {
        user: name,
        rule: RULE_NAMES[hit.rule],
        seconds: decision.seconds ? formatSeconds(decision.seconds) : '',
      });
    };

    const mayWarn = (userId: string, now: number) =>
      now - lastWarn >= s.warnGapSeconds * 1000 && now - (lastWarnUser.get(userId) ?? 0) >= WARN_PER_USER_MS;

    // -------------------------------------------------------- Protokoll

    const addLog = (entry: Omit<LogEntry, 'id' | 'time' | 'error' | 'undone'>): LogEntry => {
      const full: LogEntry = { id: nextId++, time: Date.now(), error: '', undone: false, ...entry };
      log.push(full);
      if (log.length > MAX_LOG) log.shift();
      return full;
    };

    // -------------------------------------------------------- !permit

    /** Gibt true zurück, wenn die Nachricht ein !permit war */
    const handlePermit = (text: string): boolean => {
      const [first, target] = text.trim().split(/\s+/);
      if (first?.toLowerCase() !== `!${s.permit.command}`) return false;
      const login = (target ?? '').replace(/^@/, '').toLowerCase();
      if (!/^\w{1,25}$/.test(login)) return true;
      permits.set(login, Date.now() + s.permit.seconds * 1000);
      ctx.log.info(`!permit für ${login} (${s.permit.seconds} s)`);
      if (s.permit.message && !s.dryRun) {
        const reply = fill(s.permit.message, { user: (target ?? '').replace(/^@/, ''), seconds: String(s.permit.seconds) });
        ctx.chat.send(reply).catch((err) => ctx.log.warn('Permit-Nachricht fehlgeschlagen:', err));
      }
      return true;
    };

    // -------------------------------------------------------- Chat prüfen

    ctx.events.on('chat', (event: EventOfType<'chat'>) => {
      // Test-Events aus der Oberfläche nie echt moderieren
      if (event.test) return;
      const me = ctx.getUser();
      if (!me) return;
      const now = Date.now();
      const user = event.user;
      const level = roleLevel(event.badges, user.id === me.id);

      if (level >= LEVEL.moderator && handlePermit(event.message)) return;

      const exempt = exemptReason(s, {
        login: user.login,
        level,
        isBroadcaster: user.id === me.id,
        isSuite: ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(user.id),
      });
      if (exempt) return;
      // Schon getimeoutet? Dann sind die Nachrichten sowieso weg.
      if ((timedOut.get(user.id) ?? 0) > now) return;

      const count = s.rules.repeat.enabled ? repeats.add(user.id, event.message, repeatMs(), now) : 0;
      const permitted = (permits.get(user.login.toLowerCase()) ?? 0) > now;
      const { hit, usedPermit } = checkMessage(s, { message: event.message, fragments: event.fragments, level, permitted, repeats: count });
      if (usedPermit) permits.delete(user.login.toLowerCase());
      if (!hit) return;

      const strike = countsAsStrike(s, hit) ? strikes.add(user.id, escalationMs(), now) : 0;
      const decision = decide(s, hit, strike);
      let warning = warningText(hit, decision, user.name);
      if (warning && !mayWarn(user.id, now)) warning = '';

      const entry = addLog({
        userId: user.id,
        login: user.login,
        name: user.name,
        rule: hit.rule,
        reason: hit.reason,
        excerpt: event.message.slice(0, 150),
        action: decision.action,
        seconds: decision.seconds,
        strike: decision.strike,
        dryRun: s.dryRun,
        warning,
      });
      if (s.dryRun) return;

      const fail = (err: unknown) => {
        entry.error = (err as Error).message ?? String(err);
        ctx.log.warn(`Aktion gegen ${user.name} (${RULE_NAMES[hit.rule]}) fehlgeschlagen:`, err);
      };
      if (decision.action === 'timeout') {
        timedOut.set(user.id, now + decision.seconds * 1000);
        enqueue(() => timeoutUser(me.id, user.id, decision.seconds, `Spam-Schutz: ${RULE_NAMES[hit.rule]} – ${hit.reason}`)).catch((err) => {
          timedOut.delete(user.id);
          fail(err);
        });
      } else if (decision.action === 'delete') {
        enqueue(() => deleteMessage(me.id, event.messageId)).catch(fail);
      }
      if (warning) {
        lastWarn = now;
        lastWarnUser.set(user.id, now);
        ctx.chat.send(warning).catch((err) => ctx.log.warn('Warnung konnte nicht gesendet werden:', err));
      }
    });

    // Alte Merker regelmäßig aufräumen
    const cleanup = setInterval(() => {
      const now = Date.now();
      repeats.prune(repeatMs(), now);
      strikes.prune(escalationMs(), now);
      for (const [k, until] of permits) if (until <= now) permits.delete(k);
      for (const [k, until] of timedOut) if (until <= now) timedOut.delete(k);
      for (const [k, t] of lastWarnUser) if (now - t > WARN_PER_USER_MS) lastWarnUser.delete(k);
    }, 60_000);
    ctx.onDispose(() => clearInterval(cleanup));

    // -------------------------------------------------------- API

    const publicLog = () => [...log].reverse();

    ctx.api.get('/state', () => ({ settings: s, log: publicLog(), now: Date.now() }));
    ctx.api.get('/log', () => ({ log: publicLog(), dryRun: s.dryRun, now: Date.now() }));

    ctx.api.post('/settings', ({ body }) => {
      if (!body || typeof body !== 'object') throw new HttpError(400, 'Keine Einstellungen mitgeschickt');
      const before = s;
      s = mergeSettings(s, body as Record<string, unknown>);
      store.update(s);
      if (before.dryRun !== s.dryRun) ctx.log.info(s.dryRun ? '„Nur testen“ ist an – es wird nichts gelöscht.' : 'Spam-Schutz ist scharf geschaltet.');
      return { settings: s };
    });

    /** Trockenlauf aus dem Test-Bereich: sendet nichts, ruft Twitch nicht auf */
    ctx.api.post('/test', ({ body }) => {
      const message = String(body?.message ?? '').slice(0, 500);
      if (!message.trim()) throw new HttpError(400, 'Bitte eine Nachricht eingeben.');
      const role: Role = ROLES.includes(body?.role) ? body.role : 'everyone';
      const name = String(body?.user ?? '').trim().replace(/^@/, '').slice(0, 25) || 'TestUser';
      const login = name.toLowerCase();
      const level = LEVEL[role];

      const exempt = exemptReason(s, { login, level, isBroadcaster: role === 'broadcaster', isSuite: false });
      if (exempt) return { exempt, hit: null };
      const count = s.rules.repeat.enabled ? testRepeats.add(login, message, repeatMs()) : 0;
      const { hit, usedPermit } = checkMessage(s, { message, level, permitted: body?.permit === true, repeats: count });
      if (!hit) return { exempt: null, hit: null, usedPermit, repeats: count };
      const strike = countsAsStrike(s, hit) ? testStrikes.add(login, escalationMs()) : 0;
      const decision = decide(s, hit, strike);
      return {
        exempt: null,
        hit: { ...hit, ruleName: RULE_NAMES[hit.rule] },
        decision,
        warning: warningText(hit, decision, name),
        repeats: count,
        dryRun: s.dryRun,
      };
    });

    ctx.api.post('/test/reset', () => {
      testRepeats.clear();
      testStrikes.clear();
    });

    /** Timeout aus dem Protokoll rückgängig machen */
    ctx.api.post('/undo', async ({ body }) => {
      const entry = log.find((e) => e.id === Number(body?.id));
      if (!entry) throw new HttpError(404, 'Eintrag nicht gefunden (vielleicht schon aus dem Protokoll gefallen).');
      if (entry.action !== 'timeout' || entry.dryRun) throw new HttpError(400, 'Hier gab es keinen Timeout.');
      if (entry.undone) throw new HttpError(400, 'Schon aufgehoben.');
      const me = ctx.getUser();
      if (!me) throw new HttpError(400, 'Nicht bei Twitch eingeloggt.');
      try {
        await unbanUser(me.id, entry.userId);
      } catch (err) {
        const msg = (err as Error).message;
        // Timeout ist schon abgelaufen oder wurde woanders aufgehoben → trotzdem als erledigt markieren
        if (!/not banned/i.test(msg)) throw new HttpError(502, `Twitch: ${msg}`);
      }
      for (const e of log) if (e.userId === entry.userId && e.action === 'timeout') e.undone = true;
      timedOut.delete(entry.userId);
      strikes.forget(entry.userId);
      ctx.log.info(`Timeout von ${entry.name} aufgehoben`);
      return { log: publicLog() };
    });

    /** Zuschauer auf die Erlaubt-Liste setzen (z.B. nach einem Fehlalarm) */
    ctx.api.post('/allow', ({ body }) => {
      const login = String(body?.login ?? '').trim().replace(/^@/, '').toLowerCase();
      if (!/^\w{1,25}$/.test(login)) throw new HttpError(400, 'Ungültiger Name.');
      if (!s.allowUsers.includes(login)) {
        s = normalizeSettings({ ...s, allowUsers: [...s.allowUsers, login] });
        store.update(s);
      }
      return { settings: s };
    });

    ctx.api.post('/log/clear', () => {
      log.length = 0;
      return { log: [] };
    });
  },
};
