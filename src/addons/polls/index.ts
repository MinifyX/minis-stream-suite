import { randomUUID } from 'node:crypto';
import type { Addon, AddonContext } from '../../core/addons';
import { duration, parseRole, ROLE_LEVEL, roleLevel, type Role } from '../../core/chat';
import { HttpError } from '../../core/server';
import type { EventOfType } from '../../core/twitch/events';

/**
 * Umfragen-Addon. Zwei Arten:
 *  - Chat-Umfrage: Zuschauer stimmen im Chat ab („!vote 2“ oder einfach „2“). Geht in jedem Kanal,
 *    bis zu 10 Antworten, beliebig lang.
 *  - Twitch-Umfrage: die echte Umfrage von Twitch (oben im Chat, optional mit Kanalpunkten).
 *    Nur für Affiliates/Partner, max. 5 Antworten und 30 Minuten.
 * Beide erscheinen live im OBS-Overlay. Auch Umfragen, die du direkt bei Twitch startest, zeigt das Overlay an.
 */

// ------------------------------------------------------------------ Datenmodell

type Mode = 'chat' | 'twitch';

interface Choice {
  title: string;
  votes: number;
}

interface ActivePoll {
  id: string;
  mode: Mode;
  title: string;
  choices: Choice[];
  startedAt: number;
  endsAt: number;
  /** Chat: wer hat was gewählt (Nutzer-ID → Index der Antwort) */
  voters: Map<string, number>;
  allowChange: boolean;
  permission: Role;
  /** Twitch: ID der echten Umfrage + IDs der Antworten */
  twitchId: string | null;
  twitchChoiceIds: string[];
  /** Direkt bei Twitch gestartet (nicht über die Suite) */
  external: boolean;
  startedBy: string;
}

interface PollResult {
  id: string;
  mode: Mode;
  title: string;
  choices: Choice[];
  total: number;
  /** Indizes der Gewinner (bei Gleichstand mehrere) */
  winners: number[];
  startedAt: number;
  endedAt: number;
  /** false = vorzeitig abgebrochen (keine Ergebnis-Nachricht) */
  completed: boolean;
  /** Einstellungen, um sie mit „Nochmal“ neu zu starten */
  durationSeconds: number;
  allowChange: boolean;
  permission: Role;
}

interface Settings {
  defaults: {
    mode: Mode;
    durationSeconds: number;
    allowChange: boolean;
    permission: Role;
    /** Twitch-Umfrage: Zusatzstimmen mit Kanalpunkten */
    channelPoints: boolean;
    channelPointsPerVote: number;
  };
  chat: {
    /** Command zum Abstimmen, ohne "!" */
    voteCommand: string;
    /** Eine Zahl allein im Chat („2“) zählt als Stimme */
    numberVotes: boolean;
    /** Nachrichten (leer = keine) */
    announceStartChat: string;
    announceStartTwitch: string;
    announceReminder: string;
    /** Erinnerung zur Halbzeit (nur Chat-Umfragen ab 60 s) */
    reminder: boolean;
    announceEnd: string;
    /** Kurze Antwort an den Zuschauer, wenn seine Stimme gezählt wurde? (leer = nein, Standard) */
    confirmVote: string;
  };
  /** Umfragen per Chat starten/beenden (für Mods) */
  modCommands: {
    enabled: boolean;
    pollCommand: string;
    endCommand: string;
    permission: Role;
  };
  overlay: {
    accent: string;
    textColor: string;
    background: string;
    backgroundOpacity: number;
    fontSize: number;
    width: number;
    /** So lange bleibt das Ergebnis nach dem Ende stehen (Sekunden) */
    showResultSeconds: number;
    showVotes: boolean;
    showTimer: boolean;
    /** „!vote 1“-Hinweise bei Chat-Umfragen */
    showHowTo: boolean;
  };
  history: PollResult[];
}

const DEFAULTS: Settings = {
  defaults: { mode: 'chat', durationSeconds: 120, allowChange: true, permission: 'everyone', channelPoints: false, channelPointsPerVote: 100 },
  chat: {
    voteCommand: 'vote',
    numberVotes: true,
    announceStartChat: '📊 Umfrage: {title} – Stimmt ab mit {command} und der Zahl: {options} (noch {duration})',
    announceStartTwitch: '📊 Umfrage: {title} – stimmt oben im Chat ab! (noch {duration})',
    announceReminder: '⏳ Noch {left} für die Umfrage „{title}“: {options}',
    reminder: true,
    announceEnd: '🏆 Umfrage „{title}“ beendet: {winner} gewinnt mit {percent} ({votes} von {total} Stimmen)',
    confirmVote: '',
  },
  modCommands: { enabled: true, pollCommand: 'poll', endCommand: 'endpoll', permission: 'moderator' },
  overlay: {
    accent: '#9147ff',
    textColor: '#ffffff',
    background: '#18181b',
    backgroundOpacity: 85,
    fontSize: 22,
    width: 520,
    showResultSeconds: 15,
    showVotes: true,
    showTimer: true,
    showHowTo: true,
  },
  history: [],
};

const LIMITS = {
  chat: { choices: 10, title: 100, choice: 50, minSeconds: 10, maxSeconds: 3600 },
  twitch: { choices: 5, title: 60, choice: 25, minSeconds: 15, maxSeconds: 1800 },
};
const MAX_HISTORY = 30;
const CMD_RE = /^[\p{L}\p{N}_-]{1,30}$/u;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// ------------------------------------------------------------------ Helfer

const int = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, max);
const cmdName = (v: unknown) => String(v ?? '').trim().replace(/^!+/, '').toLowerCase();

function winnersOf(choices: Choice[]): number[] {
  const max = Math.max(0, ...choices.map((c) => c.votes));
  if (max === 0) return [];
  return choices.map((c, i) => (c.votes === max ? i : -1)).filter((i) => i >= 0);
}

const percent = (votes: number, total: number) => (total ? `${Math.round((votes / total) * 100)}%` : '0%');

// ------------------------------------------------------------------ Addon

export const pollsAddon: Addon = {
  id: 'polls',
  name: 'Umfragen',
  icon: '📊',
  version: '0.1.0',
  author: 'Mini',
  description: 'Umfragen im Chat (!vote 1) oder als echte Twitch-Umfrage, mit Live-Overlay für OBS. Mods können per !poll starten.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);
    let active: ActivePoll | null = null;
    /** Letztes Ergebnis fürs Overlay (bleibt kurz stehen) */
    let lastResult: PollResult | null = null;
    let endTimer: NodeJS.Timeout | null = null;
    let reminderTimer: NodeJS.Timeout | null = null;
    let broadcastTimer: NodeJS.Timeout | null = null;
    let broadcasterType: string | null = null;

    const clearTimers = () => {
      if (endTimer) clearTimeout(endTimer);
      if (reminderTimer) clearTimeout(reminderTimer);
      endTimer = reminderTimer = null;
    };
    ctx.onDispose(() => {
      clearTimers();
      if (broadcastTimer) clearTimeout(broadcastTimer);
    });

    const say = (text: string) => {
      if (!text) return;
      ctx.chat.send(text).catch((err) => ctx.log.warn('Chat-Nachricht fehlgeschlagen:', err));
    };

    // -------------------------------------------------------- Zustand fürs Overlay / die Oberfläche

    const publicPoll = (p: ActivePoll) => ({
      id: p.id,
      mode: p.mode,
      title: p.title,
      choices: p.choices,
      total: p.choices.reduce((sum, c) => sum + c.votes, 0),
      startedAt: p.startedAt,
      endsAt: p.endsAt,
      external: p.external,
      startedBy: p.startedBy,
      allowChange: p.allowChange,
      permission: p.permission,
    });

    const overlayState = () => ({
      kind: 'state' as const,
      now: Date.now(),
      poll: active ? publicPoll(active) : null,
      result: lastResult && Date.now() - lastResult.endedAt < settings.get('overlay').showResultSeconds * 1000 ? lastResult : null,
      overlay: settings.get('overlay'),
      voteCommand: settings.get('chat').voteCommand,
      numberVotes: settings.get('chat').numberVotes,
    });

    /** Ans Overlay schicken – bei vielen Stimmen höchstens 3x pro Sekunde */
    const broadcast = (immediate = false) => {
      if (immediate) {
        if (broadcastTimer) clearTimeout(broadcastTimer);
        broadcastTimer = null;
        ctx.overlay.broadcast(overlayState());
        return;
      }
      broadcastTimer ??= setTimeout(() => {
        broadcastTimer = null;
        ctx.overlay.broadcast(overlayState());
      }, 330);
    };

    // -------------------------------------------------------- Chat-Texte

    const values = (p: { title: string; choices: Choice[]; endsAt?: number }, extra: Record<string, string> = {}) => {
      return {
        title: p.title,
        options: p.choices.map((c, i) => `${i + 1}) ${c.title}`).join(' · '),
        command: `!${settings.get('chat').voteCommand}`,
        left: p.endsAt ? duration(Math.max(60_000, p.endsAt - Date.now())) : '',
        ...extra,
      };
    };

    /** Einfache Variablen: {title}, {options} … (keine Twitch-Abfragen nötig) */
    const fill = (template: string, vals: Record<string, string>) =>
      template.replace(/\{(\w+)\}/g, (m, key: string) => (key.toLowerCase() in vals ? vals[key.toLowerCase()] : m));

    const secondsText = (s: number) => (s < 60 ? `${s} Sek.` : duration(s * 1000));

    // -------------------------------------------------------- Starten

    interface StartInput {
      title: string;
      choices: string[];
      durationSeconds: number;
      mode: Mode;
      allowChange: boolean;
      permission: Role;
      channelPoints: boolean;
      channelPointsPerVote: number;
      startedBy: string;
    }

    const validateStart = (body: Record<string, unknown>, startedBy: string): StartInput => {
      const d = settings.get('defaults');
      const mode: Mode = body.mode === 'twitch' || body.mode === 'chat' ? body.mode : d.mode;
      const lim = LIMITS[mode];
      const title = oneLine(body.title, 500);
      if (!title) throw new HttpError(400, 'Die Umfrage braucht eine Frage.');
      if (title.length > lim.title) throw new HttpError(400, `Die Frage darf höchstens ${lim.title} Zeichen haben${mode === 'twitch' ? ' (Twitch-Grenze)' : ''}.`);
      const choices = (Array.isArray(body.choices) ? body.choices : []).map((c) => oneLine(c, 500)).filter(Boolean);
      if (choices.length < 2) throw new HttpError(400, 'Mindestens zwei Antworten sind nötig.');
      if (choices.length > lim.choices) throw new HttpError(400, `Höchstens ${lim.choices} Antworten${mode === 'twitch' ? ' (Twitch-Grenze)' : ''}.`);
      const tooLong = choices.find((c) => c.length > lim.choice);
      if (tooLong) throw new HttpError(400, `„${tooLong}“ ist zu lang (max. ${lim.choice} Zeichen${mode === 'twitch' ? ', Twitch-Grenze' : ''}).`);
      const dupe = choices.find((c, i) => choices.findIndex((x) => x.toLowerCase() === c.toLowerCase()) !== i);
      if (dupe) throw new HttpError(400, `Die Antwort „${dupe}“ gibt es doppelt.`);
      return {
        title,
        choices,
        mode,
        durationSeconds: int(body.durationSeconds ?? d.durationSeconds, lim.minSeconds, lim.maxSeconds),
        allowChange: typeof body.allowChange === 'boolean' ? body.allowChange : d.allowChange,
        permission: parseRole(body.permission, d.permission),
        channelPoints: typeof body.channelPoints === 'boolean' ? body.channelPoints : d.channelPoints,
        channelPointsPerVote: int(body.channelPointsPerVote ?? d.channelPointsPerVote, 1, 1_000_000),
        startedBy,
      };
    };

    const start = async (input: StartInput): Promise<ActivePoll> => {
      if (active) throw new HttpError(409, 'Es läuft schon eine Umfrage. Beende sie zuerst.');
      const me = ctx.getUser();
      if (!me) throw new HttpError(401, 'Nicht bei Twitch eingeloggt.');
      const now = Date.now();
      const poll: ActivePoll = {
        id: randomUUID(),
        mode: input.mode,
        title: input.title,
        choices: input.choices.map((title) => ({ title, votes: 0 })),
        startedAt: now,
        endsAt: now + input.durationSeconds * 1000,
        voters: new Map(),
        allowChange: input.allowChange,
        permission: input.permission,
        twitchId: null,
        twitchChoiceIds: [],
        external: false,
        startedBy: input.startedBy,
      };

      if (input.mode === 'twitch') {
        try {
          const res = await ctx.twitch.request<{ data: { id: string; choices: { id: string }[]; ends_at?: string }[] }>('POST', '/polls', {
            body: {
              broadcaster_id: me.id,
              title: input.title,
              choices: input.choices.map((title) => ({ title })),
              duration: input.durationSeconds,
              channel_points_voting_enabled: input.channelPoints,
              ...(input.channelPoints ? { channel_points_per_vote: input.channelPointsPerVote } : {}),
            },
          });
          const created = res.data[0];
          poll.twitchId = created.id;
          poll.twitchChoiceIds = created.choices.map((c) => c.id);
        } catch (err) {
          const msg = (err as Error).message;
          if (msg.includes('403')) throw new HttpError(403, 'Twitch-Umfragen gibt es nur für Affiliates und Partner. Nimm eine Chat-Umfrage.');
          if (msg.includes('401')) throw new HttpError(401, 'Der Suite fehlt das Recht für Umfragen. Bitte in der Übersicht neu mit Twitch verbinden.');
          throw new HttpError(400, `Twitch: ${msg}`);
        }
      }

      active = poll;
      lastResult = null;
      clearTimers();
      // Chat-Umfragen beendet die Suite selbst. Bei Twitch-Umfragen kommt das Ende per EventSub,
      // zur Sicherheit wird kurz danach nachgefragt.
      endTimer = setTimeout(() => {
        if (active?.id !== poll.id) return;
        if (poll.mode === 'chat') finish(true);
        else void syncTwitchPoll(poll, true);
      }, poll.endsAt - now + (poll.mode === 'twitch' ? 5000 : 0));

      const chat = settings.get('chat');
      const vals = values(poll, { duration: secondsText(input.durationSeconds) });
      say(fill(poll.mode === 'chat' ? chat.announceStartChat : chat.announceStartTwitch, vals));
      if (poll.mode === 'chat' && chat.reminder && chat.announceReminder && input.durationSeconds >= 60) {
        reminderTimer = setTimeout(() => {
          if (active?.id === poll.id) say(fill(chat.announceReminder, values(poll)));
        }, (input.durationSeconds * 1000) / 2);
      }
      ctx.log.info(`Umfrage gestartet (${poll.mode === 'chat' ? 'Chat' : 'Twitch'}): „${poll.title}“`);
      broadcast(true);
      return poll;
    };

    // -------------------------------------------------------- Beenden

    /** Umfrage abschließen, Ergebnis speichern und (falls gewünscht) im Chat verkünden */
    const finish = (completed: boolean) => {
      const poll = active;
      if (!poll) return null;
      active = null;
      clearTimers();
      const total = poll.choices.reduce((sum, c) => sum + c.votes, 0);
      const winners = winnersOf(poll.choices);
      const result: PollResult = {
        id: poll.id,
        mode: poll.mode,
        title: poll.title,
        choices: poll.choices.map((c) => ({ ...c })),
        total,
        winners,
        startedAt: poll.startedAt,
        endedAt: Date.now(),
        completed,
        durationSeconds: Math.round((poll.endsAt - poll.startedAt) / 1000),
        allowChange: poll.allowChange,
        permission: poll.permission,
      };
      lastResult = result;
      settings.set('history', [result, ...settings.get('history').filter((h) => h.id !== result.id)].slice(0, MAX_HISTORY));

      if (completed) {
        const template = settings.get('chat').announceEnd;
        if (template) {
          if (!total) {
            say(`📊 Umfrage „${poll.title}“ beendet – leider hat niemand abgestimmt.`);
          } else {
            const top = poll.choices[winners[0]];
            say(fill(template, {
              ...values(poll),
              winner: winners.map((i) => poll.choices[i].title).join(' & ') + (winners.length > 1 ? ' (Gleichstand)' : ''),
              votes: String(top.votes),
              percent: percent(top.votes, total),
              total: String(total),
              results: poll.choices.map((c) => `${c.title} ${percent(c.votes, total)}`).join(' · '),
            }));
          }
        }
      }
      ctx.log.info(`Umfrage ${completed ? 'beendet' : 'abgebrochen'}: „${poll.title}“ (${total} Stimmen)`);
      broadcast(true);
      // Nach der Anzeigezeit das Overlay ausblenden
      setTimeout(() => {
        if (!active) broadcast(true);
      }, settings.get('overlay').showResultSeconds * 1000 + 200);
      return result;
    };

    /** Stand einer Twitch-Umfrage direkt abfragen (falls EventSub mal hakt) */
    const syncTwitchPoll = async (poll: ActivePoll, finalCheck: boolean) => {
      const me = ctx.getUser();
      if (!me || !poll.twitchId) return;
      try {
        const res = await ctx.twitch.request<{ data: { status: string; choices: { id: string; votes: number }[] }[] }>('GET', '/polls', {
          query: { broadcaster_id: me.id, id: poll.twitchId },
        });
        const data = res.data[0];
        if (!data || active?.id !== poll.id) return;
        applyTwitchVotes(poll, data.choices);
        if (data.status !== 'ACTIVE') finish(data.status === 'COMPLETED' || data.status === 'TERMINATED');
        else if (finalCheck) endTimer = setTimeout(() => void syncTwitchPoll(poll, true), 5000);
      } catch (err) {
        ctx.log.warn('Stand der Twitch-Umfrage konnte nicht geladen werden:', err);
        if (finalCheck && active?.id === poll.id) finish(true);
      }
    };

    const applyTwitchVotes = (poll: ActivePoll, choices: { id: string; votes: number }[]) => {
      for (const c of choices) {
        const i = poll.twitchChoiceIds.indexOf(c.id);
        if (i >= 0) poll.choices[i].votes = c.votes ?? 0;
      }
    };

    /** Laufende Umfrage beenden. cancel = abbrechen (ohne Ergebnis im Chat, bei Twitch ausgeblendet) */
    const end = async (cancel: boolean) => {
      const poll = active;
      if (!poll) throw new HttpError(400, 'Es läuft gerade keine Umfrage.');
      if (poll.mode === 'twitch' && poll.twitchId) {
        const me = ctx.getUser();
        if (me) {
          try {
            await ctx.twitch.request('PATCH', '/polls', {
              body: { broadcaster_id: me.id, id: poll.twitchId, status: cancel ? 'ARCHIVED' : 'TERMINATED' },
            });
          } catch (err) {
            ctx.log.warn('Twitch-Umfrage konnte nicht beendet werden:', err);
          }
        }
      }
      return finish(!cancel);
    };

    // -------------------------------------------------------- Twitch-Umfragen live (EventSub)

    ctx.events.on('poll', (e: EventOfType<'poll'>) => {
      if (e.test) return;
      // Direkt bei Twitch gestartet → übernehmen, damit das Overlay sie zeigt
      if (e.phase === 'begin' && !active) {
        const now = Date.now();
        active = {
          id: randomUUID(),
          mode: 'twitch',
          title: e.title,
          choices: e.choices.map((c) => ({ title: c.title, votes: c.votes })),
          startedAt: now,
          endsAt: e.endsAt ? new Date(e.endsAt).getTime() : now + 60_000,
          voters: new Map(),
          allowChange: false,
          permission: 'everyone',
          twitchId: e.pollId,
          twitchChoiceIds: e.choices.map((c) => c.id),
          external: true,
          startedBy: 'Twitch',
        };
        lastResult = null;
        clearTimers();
        const poll = active;
        endTimer = setTimeout(() => void syncTwitchPoll(poll, true), poll.endsAt - now + 5000);
        broadcast(true);
        return;
      }
      if (!active || active.twitchId !== e.pollId) return;
      applyTwitchVotes(active, e.choices);
      if (e.phase === 'end') {
        // "archived" = ausgeblendet/abgebrochen → kein Ergebnis im Chat
        finish(e.status !== 'archived');
      } else {
        broadcast();
      }
    });

    // -------------------------------------------------------- Chat: Abstimmen + Mod-Commands

    const findChoice = (poll: ActivePoll, text: string): number => {
      const t = text.trim().toLowerCase();
      if (/^\d{1,2}$/.test(t)) {
        const i = Number(t) - 1;
        return i >= 0 && i < poll.choices.length ? i : -1;
      }
      return poll.choices.findIndex((c) => c.title.toLowerCase() === t);
    };

    const vote = (poll: ActivePoll, userId: string, choice: number): 'new' | 'changed' | 'same' | 'locked' => {
      const before = poll.voters.get(userId);
      if (before === choice) return 'same';
      if (before !== undefined && !poll.allowChange) return 'locked';
      if (before !== undefined) poll.choices[before].votes--;
      poll.choices[choice].votes++;
      poll.voters.set(userId, choice);
      broadcast();
      return before === undefined ? 'new' : 'changed';
    };

    /** "!poll 90 Frage | A | B" → Umfrage per Chat starten */
    const parseChatPoll = (rest: string) => {
      const parts = rest.split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length < 3) return null;
      let title = parts[0];
      let seconds: number | undefined;
      const m = /^(\d{1,4})\s*(s|sek|m|min)?\s+(.+)$/i.exec(title);
      if (m) {
        seconds = Number(m[1]) * (m[2] && /^m/i.test(m[2]) ? 60 : 1);
        title = m[3];
      }
      return { title, choices: parts.slice(1), durationSeconds: seconds };
    };

    ctx.events.on('chat', async (event: EventOfType<'chat'>) => {
      if (ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(event.user.id)) return;
      const text = event.message.trim();
      const me = ctx.getUser();
      const level = roleLevel(event.badges, event.user.id === me?.id);

      if (text.startsWith('!')) {
        const [first, ...restWords] = text.slice(1).split(/\s+/);
        const cmd = (first ?? '').toLowerCase();
        const rest = restWords.join(' ');
        const mods = settings.get('modCommands');
        const chat = settings.get('chat');

        if (mods.enabled && level >= ROLE_LEVEL[mods.permission]) {
          if (cmd === mods.pollCommand) {
            const parsed = parseChatPoll(rest);
            if (!parsed) {
              say(`@${event.user.name} So geht's: !${mods.pollCommand} [Sekunden] Frage | Antwort 1 | Antwort 2`);
              return;
            }
            try {
              await start(validateStart(parsed, event.user.name));
            } catch (err) {
              say(`@${event.user.name} ${(err as Error).message}`);
            }
            return;
          }
          if (cmd === mods.endCommand) {
            if (active) await end(false).catch((err) => ctx.log.warn(err));
            return;
          }
        }

        if (cmd === chat.voteCommand && active?.mode === 'chat') {
          const choice = findChoice(active, rest);
          if (choice >= 0 && level >= ROLE_LEVEL[active.permission]) {
            const r = vote(active, event.user.id, choice);
            if ((r === 'new' || r === 'changed') && chat.confirmVote) {
              say(fill(chat.confirmVote, { user: event.user.name, choice: active.choices[choice].title, number: String(choice + 1) }));
            }
          }
        }
        return;
      }

      // Nur eine Zahl → zählt als Stimme
      if (active?.mode === 'chat' && settings.get('chat').numberVotes && /^\d{1,2}$/.test(text)) {
        const choice = findChoice(active, text);
        if (choice >= 0 && level >= ROLE_LEVEL[active.permission]) vote(active, event.user.id, choice);
      }
    });

    // -------------------------------------------------------- API

    const broadcasterInfo = async () => {
      const me = ctx.getUser();
      if (!me) return null;
      if (broadcasterType === null) {
        try {
          const res = await ctx.twitch.request<{ data: { broadcaster_type: string }[] }>('GET', '/users', { query: { id: me.id } });
          broadcasterType = res.data[0]?.broadcaster_type ?? '';
        } catch {
          return null;
        }
      }
      return broadcasterType;
    };

    ctx.api.get('/state', async () => ({
      settings: { ...settings.all(), history: undefined },
      history: settings.get('history'),
      active: active ? { ...publicPoll(active), voters: active.voters.size } : null,
      now: Date.now(),
      /** '' = normaler Kanal, 'affiliate', 'partner'; null = unbekannt */
      broadcasterType: await broadcasterInfo(),
      limits: LIMITS,
    }));

    ctx.api.get('/overlay-state', () => overlayState());

    ctx.api.post('/start', async ({ body }) => {
      const poll = await start(validateStart(body ?? {}, 'Dashboard'));
      return publicPoll(poll);
    });

    ctx.api.post('/end', async ({ body }) => end(body?.cancel === true));

    /** Zum Testen: Stimme von einem Fake-Zuschauer */
    ctx.api.post('/test-vote', ({ body }) => {
      if (!active || active.mode !== 'chat') throw new HttpError(400, 'Test-Stimmen gehen nur bei einer laufenden Chat-Umfrage.');
      const choice = int(body?.choice, 0, active.choices.length - 1);
      vote(active, `test-${randomUUID()}`, choice);
    });

    /** Overlay mit einer Beispiel-Umfrage testen (ändert nichts im Chat) */
    ctx.api.post('/overlay/test', () => {
      const now = Date.now();
      ctx.overlay.broadcast({
        ...overlayState(),
        poll: {
          id: 'demo', mode: 'chat', title: 'Welches Spiel als Nächstes?', startedAt: now, endsAt: now + 30_000, external: false,
          startedBy: 'Test', allowChange: true, permission: 'everyone',
          choices: [{ title: 'Minecraft', votes: 12 }, { title: 'Phasmophobia', votes: 21 }, { title: 'Mario Kart', votes: 7 }],
          total: 40,
        },
        result: null,
        demo: true,
      });
    });

    ctx.api.post('/settings', ({ body }) => {
      const s = settings.all();
      if (body?.defaults) {
        const d = body.defaults;
        s.defaults = {
          mode: d.mode === 'twitch' ? 'twitch' : 'chat',
          durationSeconds: int(d.durationSeconds, 10, 3600),
          allowChange: d.allowChange !== false,
          permission: parseRole(d.permission),
          channelPoints: d.channelPoints === true,
          channelPointsPerVote: int(d.channelPointsPerVote, 1, 1_000_000),
        };
      }
      if (body?.chat) {
        const c = body.chat;
        const voteCommand = cmdName(c.voteCommand);
        if (!CMD_RE.test(voteCommand)) throw new HttpError(400, 'Ungültiger Abstimm-Command.');
        s.chat = {
          voteCommand,
          numberVotes: c.numberVotes !== false,
          announceStartChat: oneLine(c.announceStartChat, 500),
          announceStartTwitch: oneLine(c.announceStartTwitch, 500),
          announceReminder: oneLine(c.announceReminder, 500),
          reminder: c.reminder !== false,
          announceEnd: oneLine(c.announceEnd, 500),
          confirmVote: oneLine(c.confirmVote, 500),
        };
      }
      if (body?.modCommands) {
        const m = body.modCommands;
        const pollCommand = cmdName(m.pollCommand);
        const endCommand = cmdName(m.endCommand);
        if (!CMD_RE.test(pollCommand) || !CMD_RE.test(endCommand)) throw new HttpError(400, 'Ungültiger Command-Name.');
        if (pollCommand === endCommand) throw new HttpError(400, 'Start- und End-Command müssen verschieden sein.');
        s.modCommands = { enabled: m.enabled !== false, pollCommand, endCommand, permission: parseRole(m.permission, 'moderator') };
      }
      if (body?.overlay) {
        const o = body.overlay;
        s.overlay = {
          accent: COLOR_RE.test(o.accent) ? o.accent : DEFAULTS.overlay.accent,
          textColor: COLOR_RE.test(o.textColor) ? o.textColor : DEFAULTS.overlay.textColor,
          background: COLOR_RE.test(o.background) ? o.background : DEFAULTS.overlay.background,
          backgroundOpacity: int(o.backgroundOpacity, 0, 100),
          fontSize: int(o.fontSize, 12, 60),
          width: int(o.width, 250, 1920),
          showResultSeconds: int(o.showResultSeconds, 0, 300),
          showVotes: o.showVotes !== false,
          showTimer: o.showTimer !== false,
          showHowTo: o.showHowTo !== false,
        };
      }
      settings.update({ defaults: s.defaults, chat: s.chat, modCommands: s.modCommands, overlay: s.overlay });
      broadcast(true);
      return { ...settings.all(), history: undefined };
    });

    ctx.api.post('/history/delete', ({ body }) => {
      settings.set('history', settings.get('history').filter((h) => h.id !== body?.id));
    });

    ctx.api.post('/history/clear', () => {
      settings.set('history', []);
    });

    // Falls die Suite neu gestartet wurde, während bei Twitch eine Umfrage läuft → übernehmen
    let tries = 0;
    let startup: NodeJS.Timeout | null = null;
    const adoptRunning = async () => {
      const me = ctx.getUser();
      if (!me) {
        if (++tries < 30) startup = setTimeout(adoptRunning, 2000);
        return;
      }
      if ((await broadcasterInfo()) === '') return; // kein Affiliate → keine Twitch-Umfragen
      try {
        const res = await ctx.twitch.request<{ data: { id: string; title: string; status: string; started_at: string; duration: number; choices: { id: string; title: string; votes: number }[] }[] }>(
          'GET', '/polls', { query: { broadcaster_id: me.id, first: '1' } });
        const p = res.data[0];
        if (!p || p.status !== 'ACTIVE' || active) return;
        const startedAt = new Date(p.started_at).getTime();
        ctx.events.emit({
          type: 'poll', phase: 'begin', pollId: p.id, title: p.title, status: 'active',
          choices: p.choices.map((c) => ({ id: c.id, title: c.title, votes: c.votes ?? 0 })),
          endsAt: new Date(startedAt + p.duration * 1000).toISOString(),
        });
      } catch {
        // z.B. Recht fehlt noch → egal
      }
    };
    startup = setTimeout(adoptRunning, 1500);
    ctx.onDispose(() => {
      if (startup) clearTimeout(startup);
    });
  },
};
