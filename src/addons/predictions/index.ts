import { randomUUID } from 'node:crypto';
import type { Addon, AddonContext } from '../../core/addons';
import { duration, parseRole, ROLE_LEVEL, roleLevel, type Role } from '../../core/chat';
import { HttpError } from '../../core/server';
import type { EventOfType, PredictionOutcome } from '../../core/twitch/events';

/**
 * Vorhersagen-Addon – das Gegenstück zu den Umfragen, aber mit Kanalpunkten.
 * Zuschauer setzen ihre Kanalpunkte auf eine Antwort, du wählst am Ende den Gewinner,
 * und Twitch verteilt die Punkte. Gibt es nur für Affiliates und Partner.
 *
 *  - Starten aus der Oberfläche oder per Mod-Command (!predict 120 Frage | A | B)
 *  - Live-Ansicht und OBS-Overlay (auch für Vorhersagen, die du direkt bei Twitch startest)
 *  - Sperren, Gewinner wählen, Abbrechen (Punkte zurück)
 *  - Optionale Chat-Nachrichten bei Start, Sperre und Ergebnis
 */

// ------------------------------------------------------------------ Datenmodell

type Outcome = PredictionOutcome;

interface ActivePrediction {
  /** Twitch-ID der Vorhersage (bei Tests eine eigene ID) */
  id: string;
  title: string;
  outcomes: Outcome[];
  /** active = Tipps möglich, locked = gesperrt, wartet auf den Gewinner */
  status: 'active' | 'locked';
  startedAt: number;
  locksAt: number;
  /** Direkt bei Twitch gestartet (nicht über die Suite) */
  external: boolean;
  startedBy: string;
  /** Vom Test-Button der Übersicht – nur in der Suite und im Overlay, nicht bei Twitch */
  test: boolean;
}

interface PredictionResult {
  id: string;
  title: string;
  outcomes: Outcome[];
  /** resolved = Gewinner steht fest, canceled = abgebrochen (Punkte zurück) */
  status: 'resolved' | 'canceled';
  /** Index des Gewinners, -1 bei Abbruch */
  winner: number;
  totalUsers: number;
  totalPoints: number;
  startedAt: number;
  endedAt: number;
  /** Tipp-Zeit in Sekunden, um sie mit „Nochmal“ neu zu starten */
  windowSeconds: number;
  test: boolean;
}

interface Message {
  enabled: boolean;
  text: string;
}

interface Settings {
  defaults: {
    windowSeconds: number;
  };
  /** Chat-Nachrichten – schreibt dein Bot, falls verknüpft */
  messages: {
    start: Message;
    lock: Message;
    result: Message;
    cancel: Message;
  };
  /** Vorhersagen per Chat steuern (für Mods) */
  modCommands: {
    enabled: boolean;
    startCommand: string;
    lockCommand: string;
    resolveCommand: string;
    cancelCommand: string;
    permission: Role;
  };
  overlay: {
    /** Twitch-Farben: blau (1. Antwort bzw. alle bei mehr als 2) und pink (2. Antwort) */
    blue: string;
    pink: string;
    textColor: string;
    background: string;
    backgroundOpacity: number;
    fontSize: number;
    width: number;
    /** So lange bleibt das Ergebnis nach dem Ende stehen (Sekunden) */
    showResultSeconds: number;
    /** Tipper und Kanalpunkte pro Antwort zeigen */
    showStats: boolean;
    showTimer: boolean;
  };
  history: PredictionResult[];
}

const DEFAULTS: Settings = {
  defaults: { windowSeconds: 120 },
  messages: {
    start: { enabled: true, text: '🔮 Vorhersage: {title} – setzt eure Kanalpunkte oben im Chat! {outcomes} (noch {duration})' },
    lock: { enabled: true, text: '🔒 Nichts geht mehr! „{title}“ ist gesperrt – {users} Leute haben {points} Kanalpunkte gesetzt.' },
    result: { enabled: true, text: '🏆 „{title}“: {winner} gewinnt! {winnerusers} Leute teilen sich {points} Kanalpunkte.' },
    cancel: { enabled: true, text: '↩ Die Vorhersage „{title}“ wurde abgebrochen – alle bekommen ihre Kanalpunkte zurück.' },
  },
  modCommands: {
    enabled: true,
    startCommand: 'predict',
    lockCommand: 'lock',
    resolveCommand: 'resolve',
    cancelCommand: 'cancelpredict',
    permission: 'moderator',
  },
  overlay: {
    blue: '#387aff',
    pink: '#f5009b',
    textColor: '#ffffff',
    background: '#18181b',
    backgroundOpacity: 85,
    fontSize: 22,
    width: 520,
    showResultSeconds: 15,
    showStats: true,
    showTimer: true,
  },
  history: [],
};

/** Grenzen von Twitch */
const LIMITS = { outcomes: 10, title: 45, outcome: 25, minSeconds: 30, maxSeconds: 1800 };
const MAX_HISTORY = 30;
const CMD_RE = /^[\p{L}\p{N}_-]{1,30}$/u;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// ------------------------------------------------------------------ Helfer

const int = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, max);
const cmdName = (v: unknown) => String(v ?? '').trim().replace(/^!+/, '').toLowerCase();
const num = (n: number) => n.toLocaleString('de-DE');
const percent = (part: number, total: number) => (total ? `${Math.round((part / total) * 100)}%` : '0%');
const sumUsers = (outcomes: Outcome[]) => outcomes.reduce((s, o) => s + o.users, 0);
const sumPoints = (outcomes: Outcome[]) => outcomes.reduce((s, o) => s + o.channelPoints, 0);

/** Antwort von Twitch (Helix) */
interface HelixPrediction {
  id: string;
  title: string;
  status: string;
  winning_outcome_id: string | null;
  prediction_window: number;
  created_at: string;
  outcomes: { id: string; title: string; color: string; users: number | null; channel_points: number | null }[];
}

const fromHelix = (outcomes: HelixPrediction['outcomes']): Outcome[] =>
  outcomes.map((o) => ({
    id: o.id,
    title: o.title,
    color: String(o.color || 'blue').toLowerCase(),
    users: o.users ?? 0,
    channelPoints: o.channel_points ?? 0,
  }));

/** Twitch-Fehler in verständliches Deutsch übersetzen */
function twitchError(err: unknown, action: string): HttpError {
  const msg = (err as Error).message ?? String(err);
  const lower = msg.toLowerCase();
  if (msg.includes('403')) return new HttpError(403, 'Vorhersagen gibt es nur für Affiliates und Partner.');
  if (msg.includes('401')) return new HttpError(401, 'Der Suite fehlt das Recht für Vorhersagen. Bitte in der Übersicht neu mit Twitch verbinden.');
  if (msg.includes('429')) return new HttpError(429, 'Twitch sagt: zu viele Anfragen. Warte kurz und versuch es nochmal.');
  if (lower.includes('active') && lower.includes('prediction')) {
    return new HttpError(409, 'Bei Twitch läuft schon eine Vorhersage. Beende sie zuerst (hier oder im Twitch-Dashboard).');
  }
  if (lower.includes('not found') || msg.includes('404')) return new HttpError(404, 'Twitch kennt diese Vorhersage nicht mehr – sie ist wohl schon beendet.');
  return new HttpError(400, `${action} hat nicht geklappt. Twitch: ${msg}`);
}

// ------------------------------------------------------------------ Addon

export const predictionsAddon: Addon = {
  id: 'predictions',
  name: 'Vorhersagen',
  icon: '🔮',
  version: '0.1.0',
  author: 'Mini',
  description: 'Twitch-Vorhersagen mit Kanalpunkten starten, sperren und auflösen – mit Live-Overlay für OBS. Mods können per !predict starten.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);
    let active: ActivePrediction | null = null;
    /** Letztes Ergebnis fürs Overlay (bleibt kurz stehen) */
    let lastResult: PredictionResult | null = null;
    /** Während die Suite bei Twitch startet: das Begin-Event nicht als „fremde“ Vorhersage übernehmen */
    let starting = false;
    let lockTimer: NodeJS.Timeout | null = null;
    let syncTimer: NodeJS.Timeout | null = null;
    let broadcastTimer: NodeJS.Timeout | null = null;
    let hideTimer: NodeJS.Timeout | null = null;
    let broadcasterType: string | null = null;

    const clearTimers = () => {
      if (lockTimer) clearTimeout(lockTimer);
      if (syncTimer) clearInterval(syncTimer);
      lockTimer = syncTimer = null;
    };
    ctx.onDispose(() => {
      clearTimers();
      if (broadcastTimer) clearTimeout(broadcastTimer);
      if (hideTimer) clearTimeout(hideTimer);
    });

    const say = (text: string) => {
      if (!text) return;
      ctx.chat.send(text).catch((err) => ctx.log.warn('Chat-Nachricht fehlgeschlagen:', err));
    };

    // -------------------------------------------------------- Zustand fürs Overlay / die Oberfläche

    const publicPrediction = (p: ActivePrediction) => ({
      id: p.id,
      title: p.title,
      outcomes: p.outcomes,
      status: p.status,
      startedAt: p.startedAt,
      locksAt: p.locksAt,
      external: p.external,
      startedBy: p.startedBy,
      test: p.test,
      totalUsers: sumUsers(p.outcomes),
      totalPoints: sumPoints(p.outcomes),
    });

    const overlayState = () => ({
      kind: 'state' as const,
      now: Date.now(),
      prediction: active ? publicPrediction(active) : null,
      result: lastResult && Date.now() - lastResult.endedAt < settings.get('overlay').showResultSeconds * 1000 ? lastResult : null,
      overlay: settings.get('overlay'),
    });

    /** Ans Overlay schicken – bei vielen Tipps höchstens 3x pro Sekunde */
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

    const values = (p: { title: string; outcomes: Outcome[] }, extra: Record<string, string> = {}) => ({
      title: p.title,
      outcomes: p.outcomes.map((o, i) => `${i + 1}) ${o.title}`).join(' · '),
      users: num(sumUsers(p.outcomes)),
      points: num(sumPoints(p.outcomes)),
      ...extra,
    });

    /** Einfache Variablen: {title}, {outcomes} … (keine Twitch-Abfragen nötig) */
    const fill = (template: string, vals: Record<string, string>) =>
      template.replace(/\{(\w+)\}/g, (m, key: string) => (key.toLowerCase() in vals ? vals[key.toLowerCase()] : m));

    const secondsText = (s: number) => (s < 60 ? `${s} Sek.` : duration(s * 1000));

    /** Nachricht schicken, falls eingeschaltet (nie bei Test-Vorhersagen) */
    const announce = (kind: keyof Settings['messages'], p: ActivePrediction | PredictionResult, extra: Record<string, string> = {}) => {
      if (p.test) return;
      const m = settings.get('messages')[kind];
      if (m.enabled && m.text) say(fill(m.text, values(p, extra)));
    };

    // -------------------------------------------------------- Laufende Vorhersage verwalten

    /** Neue Zahlen übernehmen (Twitch schickt immer alle Antworten mit) */
    const applyOutcomes = (p: ActivePrediction, outcomes: Outcome[]) => {
      if (!outcomes.length) return;
      // Gesetzte Punkte werden nur mehr – ein älterer Stand (verspätetes Event, alte Antwort) wird ignoriert
      const sameOutcomes = outcomes.length === p.outcomes.length && outcomes.every((o, i) => o.id === p.outcomes[i].id);
      if (sameOutcomes && sumPoints(outcomes) < sumPoints(p.outcomes)) return;
      p.outcomes = outcomes.map((o) => ({ ...o, color: String(o.color || 'blue').toLowerCase() }));
    };

    /** Vorhersage übernehmen und Timer aufsetzen */
    const setActive = (p: ActivePrediction) => {
      clearTimers();
      active = p;
      lastResult = null;
      if (hideTimer) clearTimeout(hideTimer);
      scheduleLock(p);
      // Zur Sicherheit alle 30 Sekunden bei Twitch nachsehen (falls EventSub mal hakt)
      if (!p.test) syncTimer = setInterval(() => void syncWithTwitch(p), 30_000);
      broadcast(true);
    };

    /** Zum Sperrzeitpunkt: Test-Vorhersagen selbst sperren, echte bei Twitch nachfragen */
    const scheduleLock = (p: ActivePrediction) => {
      if (lockTimer) clearTimeout(lockTimer);
      lockTimer = null;
      if (p.status !== 'active') return;
      const wait = Math.max(0, p.locksAt - Date.now()) + (p.test ? 0 : 5000);
      lockTimer = setTimeout(() => {
        if (active?.id !== p.id || p.status !== 'active') return;
        if (p.test) markLocked(p);
        else void syncWithTwitch(p);
      }, wait);
    };

    /** Keine Tipps mehr – Nachricht nur beim ersten Mal */
    const markLocked = (p: ActivePrediction) => {
      if (p.status === 'locked') return;
      p.status = 'locked';
      if (lockTimer) clearTimeout(lockTimer);
      lockTimer = null;
      ctx.log.info(`Vorhersage gesperrt: „${p.title}“`);
      announce('lock', p);
      broadcast(true);
    };

    /** Vorhersage abschließen, Ergebnis speichern und (falls gewünscht) im Chat verkünden */
    const finish = (status: 'resolved' | 'canceled', winningOutcomeId: string | null) => {
      const p = active;
      if (!p) return null;
      active = null;
      clearTimers();
      const winner = status === 'resolved' ? p.outcomes.findIndex((o) => o.id === winningOutcomeId) : -1;
      const result: PredictionResult = {
        id: p.id,
        title: p.title,
        outcomes: p.outcomes.map((o) => ({ ...o })),
        status: winner >= 0 ? 'resolved' : 'canceled',
        winner,
        totalUsers: sumUsers(p.outcomes),
        totalPoints: sumPoints(p.outcomes),
        startedAt: p.startedAt,
        endedAt: Date.now(),
        windowSeconds: int((p.locksAt - p.startedAt) / 1000, LIMITS.minSeconds, LIMITS.maxSeconds),
        test: p.test,
      };
      lastResult = result;
      if (!p.test) settings.set('history', [result, ...settings.get('history').filter((h) => h.id !== result.id)].slice(0, MAX_HISTORY));

      if (result.status === 'resolved') {
        const w = result.outcomes[winner];
        if (!result.totalUsers) {
          if (!p.test && settings.get('messages').result.enabled) say(`🔮 Vorhersage „${p.title}“ beendet – leider hat niemand getippt.`);
        } else {
          announce('result', result, {
            winner: w.title,
            winnerusers: num(w.users),
            winnerpoints: num(w.channelPoints),
            percent: percent(w.channelPoints, result.totalPoints),
            results: result.outcomes.map((o) => `${o.title} ${percent(o.channelPoints, result.totalPoints)}`).join(' · '),
          });
        }
      } else {
        announce('cancel', result);
      }
      ctx.log.info(`Vorhersage ${result.status === 'resolved' ? `aufgelöst („${result.outcomes[winner].title}“ gewinnt)` : 'abgebrochen'}: „${p.title}“`);
      broadcast(true);
      // Nach der Anzeigezeit das Overlay ausblenden
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (!active) broadcast(true);
      }, settings.get('overlay').showResultSeconds * 1000 + 200);
      return result;
    };

    /** Stand direkt bei Twitch abfragen */
    const syncWithTwitch = async (p: ActivePrediction) => {
      const me = ctx.getUser();
      if (!me || p.test) return;
      try {
        const res = await ctx.twitch.request<{ data: HelixPrediction[] }>('GET', '/predictions', { query: { broadcaster_id: me.id, id: p.id } });
        if (active?.id !== p.id) return;
        const data = res.data[0];
        if (!data) {
          // Gibt es bei Twitch nicht (mehr) → nicht ewig anzeigen
          finish('canceled', null);
          return;
        }
        applyOutcomes(p, fromHelix(data.outcomes));
        if (data.status === 'RESOLVED') finish('resolved', data.winning_outcome_id);
        else if (data.status === 'CANCELED') finish('canceled', null);
        else if (data.status === 'LOCKED') markLocked(p);
        else {
          // Noch offen, obwohl die Zeit um ist? In ein paar Sekunden nochmal schauen
          if (Date.now() > p.locksAt) {
            if (lockTimer) clearTimeout(lockTimer);
            lockTimer = setTimeout(() => void syncWithTwitch(p), 10_000);
          }
          broadcast();
        }
      } catch (err) {
        ctx.log.warn('Stand der Vorhersage konnte nicht geladen werden:', err);
      }
    };

    // -------------------------------------------------------- Starten

    interface StartInput {
      title: string;
      outcomes: string[];
      windowSeconds: number;
      startedBy: string;
    }

    const validateStart = (body: Record<string, unknown>, startedBy: string): StartInput => {
      const title = oneLine(body.title, 500);
      if (!title) throw new HttpError(400, 'Die Vorhersage braucht eine Frage.');
      if (title.length > LIMITS.title) throw new HttpError(400, `Die Frage darf höchstens ${LIMITS.title} Zeichen haben (Twitch-Grenze).`);
      const outcomes = (Array.isArray(body.outcomes) ? body.outcomes : []).map((c) => oneLine(c, 500)).filter(Boolean);
      if (outcomes.length < 2) throw new HttpError(400, 'Mindestens zwei Antworten sind nötig.');
      if (outcomes.length > LIMITS.outcomes) throw new HttpError(400, `Höchstens ${LIMITS.outcomes} Antworten (Twitch-Grenze).`);
      const tooLong = outcomes.find((c) => c.length > LIMITS.outcome);
      if (tooLong) throw new HttpError(400, `„${tooLong}“ ist zu lang (max. ${LIMITS.outcome} Zeichen, Twitch-Grenze).`);
      const dupe = outcomes.find((c, i) => outcomes.findIndex((x) => x.toLowerCase() === c.toLowerCase()) !== i);
      if (dupe) throw new HttpError(400, `Die Antwort „${dupe}“ gibt es doppelt.`);
      return {
        title,
        outcomes,
        windowSeconds: int(body.windowSeconds ?? settings.get('defaults').windowSeconds, LIMITS.minSeconds, LIMITS.maxSeconds),
        startedBy,
      };
    };

    const start = async (input: StartInput): Promise<ActivePrediction> => {
      if (active && !active.test) throw new HttpError(409, 'Es läuft schon eine Vorhersage. Löse sie zuerst auf oder brich sie ab.');
      if (starting) throw new HttpError(409, 'Die Vorhersage wird gerade gestartet …');
      const me = ctx.getUser();
      if (!me) throw new HttpError(401, 'Nicht bei Twitch eingeloggt.');

      starting = true;
      let created: HelixPrediction;
      try {
        const res = await ctx.twitch.request<{ data: HelixPrediction[] }>('POST', '/predictions', {
          body: {
            broadcaster_id: me.id,
            title: input.title,
            outcomes: input.outcomes.map((title) => ({ title })),
            prediction_window: input.windowSeconds,
          },
        });
        created = res.data[0];
      } catch (err) {
        throw twitchError(err, 'Das Starten');
      } finally {
        starting = false;
      }

      const startedAt = created.created_at ? new Date(created.created_at).getTime() : Date.now();
      const p: ActivePrediction = {
        id: created.id,
        title: created.title || input.title,
        outcomes: fromHelix(created.outcomes),
        status: 'active',
        startedAt,
        locksAt: startedAt + (created.prediction_window || input.windowSeconds) * 1000,
        external: false,
        startedBy: input.startedBy,
        test: false,
      };
      setActive(p);
      announce('start', p, { duration: secondsText(input.windowSeconds) });
      ctx.log.info(`Vorhersage gestartet: „${p.title}“`);
      return p;
    };

    // -------------------------------------------------------- Sperren / Auflösen / Abbrechen

    const requireActive = (): ActivePrediction => {
      if (!active) throw new HttpError(400, 'Es läuft gerade keine Vorhersage.');
      return active;
    };

    /** Status bei Twitch ändern. Gibt die aktuelle Vorhersage von Twitch zurück (falls mitgeschickt). */
    const patch = async (p: ActivePrediction, body: Record<string, unknown>, action: string) => {
      const me = ctx.getUser();
      if (!me) throw new HttpError(401, 'Nicht bei Twitch eingeloggt.');
      try {
        const res = await ctx.twitch.request<{ data?: HelixPrediction[] }>('PATCH', '/predictions', { body: { broadcaster_id: me.id, id: p.id, ...body } });
        const data = res?.data?.[0];
        if (data && active?.id === p.id) applyOutcomes(p, fromHelix(data.outcomes));
      } catch (err) {
        throw twitchError(err, action);
      }
    };

    const lock = async () => {
      const p = requireActive();
      if (p.status === 'locked') throw new HttpError(400, 'Die Vorhersage ist schon gesperrt.');
      if (!p.test) await patch(p, { status: 'LOCKED' }, 'Das Sperren');
      if (active?.id === p.id) markLocked(p);
    };

    /** Gewinner festlegen – per Index (0, 1 …) oder Twitch-ID der Antwort */
    const resolve = async (outcome: unknown) => {
      const p = requireActive();
      const index = typeof outcome === 'number' ? outcome : p.outcomes.findIndex((o) => o.id === outcome);
      const winner = p.outcomes[index];
      if (!winner) throw new HttpError(400, 'Diese Antwort gibt es nicht.');
      if (!p.test) await patch(p, { status: 'RESOLVED', winning_outcome_id: winner.id }, 'Das Auflösen');
      return active?.id === p.id ? finish('resolved', winner.id) : lastResult;
    };

    const cancel = async () => {
      const p = requireActive();
      if (!p.test) await patch(p, { status: 'CANCELED' }, 'Das Abbrechen');
      return active?.id === p.id ? finish('canceled', null) : lastResult;
    };

    // -------------------------------------------------------- Twitch-Vorhersagen live (EventSub)

    /** Vorhersage aus einem Event übernehmen (direkt bei Twitch gestartet, nach Neustart oder Test) */
    const adopt = (e: EventOfType<'prediction'>, external: boolean) => {
      const now = Date.now();
      const locksAt = e.locksAt ? new Date(e.locksAt).getTime() : now + 60_000;
      const p: ActivePrediction = {
        id: e.test ? `test-${randomUUID()}` : e.predictionId,
        title: e.title,
        outcomes: [],
        status: e.phase === 'lock' ? 'locked' : 'active',
        // Twitch schickt keinen Startzeitpunkt mit – für den Fortschrittsbalken reicht eine Schätzung
        startedAt: Math.min(now, locksAt - LIMITS.minSeconds * 1000),
        locksAt,
        external,
        startedBy: e.test ? 'Test' : 'Twitch',
        test: !!e.test,
      };
      applyOutcomes(p, e.outcomes);
      setActive(p);
      return p;
    };

    ctx.events.on('prediction', (e: EventOfType<'prediction'>) => {
      // Test-Button der Übersicht: nur zeigen, wenn nicht gerade eine echte Vorhersage läuft
      if (e.test) {
        if (active && !active.test) return;
        const p = adopt(e, false);
        if (e.phase === 'end') finish(e.winningOutcomeId ? 'resolved' : 'canceled', e.winningOutcomeId);
        else ctx.log.info(`Test-Vorhersage angezeigt: „${p.title}“`);
        return;
      }
      // Die Suite startet gerade selbst → das übernimmt start()
      if (starting) return;

      let p = active && active.id === e.predictionId ? active : null;
      if (!p) {
        if (e.phase === 'end') return; // schon abgeschlossen (z.B. über die Suite)
        if (active && !active.test) {
          ctx.log.warn(`Unbekannte Vorhersage „${e.title}“ – eine andere wird gerade angezeigt.`);
          return;
        }
        // Direkt bei Twitch gestartet (oder die Suite hat den Start verpasst) → übernehmen
        p = adopt(e, true);
        if (e.phase === 'begin') {
          const left = Math.round((p.locksAt - Date.now()) / 1000);
          announce('start', p, { duration: secondsText(Math.max(0, left)) });
          ctx.log.info(`Vorhersage bei Twitch gestartet: „${p.title}“`);
        }
        return;
      }

      applyOutcomes(p, e.outcomes);
      if (e.locksAt && p.status === 'active') {
        const locksAt = new Date(e.locksAt).getTime();
        if (Math.abs(locksAt - p.locksAt) > 2000) {
          p.locksAt = locksAt;
          scheduleLock(p);
        }
      }
      if (e.phase === 'lock') markLocked(p);
      else if (e.phase === 'end') finish(e.status === 'resolved' ? 'resolved' : 'canceled', e.winningOutcomeId);
      else broadcast();
    });

    // -------------------------------------------------------- Mod-Commands im Chat

    /** "!predict 90 Frage | A | B" → Vorhersage per Chat starten */
    const parseChatPrediction = (rest: string) => {
      const parts = rest.split('|').map((s) => s.trim()).filter(Boolean);
      if (parts.length < 3) return null;
      let title = parts[0];
      let seconds: number | undefined;
      const m = /^(\d{1,4})\s*(s|sek|m|min)?\s+(.+)$/i.exec(title);
      if (m) {
        seconds = Number(m[1]) * (m[2] && /^m/i.test(m[2]) ? 60 : 1);
        title = m[3];
      }
      return { title, outcomes: parts.slice(1), windowSeconds: seconds };
    };

    /** "1" oder der Text einer Antwort → Index */
    const findOutcome = (p: ActivePrediction, text: string): number => {
      const t = text.trim().toLowerCase();
      if (/^\d{1,2}$/.test(t)) {
        const i = Number(t) - 1;
        return i >= 0 && i < p.outcomes.length ? i : -1;
      }
      return p.outcomes.findIndex((o) => o.title.toLowerCase() === t);
    };

    ctx.events.on('chat', async (event: EventOfType<'chat'>) => {
      if (ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(event.user.id)) return;
      const text = event.message.trim();
      if (!text.startsWith('!')) return;
      const mods = settings.get('modCommands');
      if (!mods.enabled) return;
      const me = ctx.getUser();
      if (roleLevel(event.badges, event.user.id === me?.id) < ROLE_LEVEL[mods.permission]) return;

      const [first, ...restWords] = text.slice(1).split(/\s+/);
      const cmd = (first ?? '').toLowerCase();
      const rest = restWords.join(' ');
      const reply = (msg: string) => say(`@${event.user.name} ${msg}`);
      const run = async (fn: () => Promise<unknown>) => {
        try {
          await fn();
        } catch (err) {
          reply((err as Error).message);
        }
      };

      if (cmd === mods.startCommand) {
        const parsed = parseChatPrediction(rest);
        if (!parsed) {
          reply(`So geht's: !${mods.startCommand} [Sekunden] Frage | Antwort 1 | Antwort 2`);
          return;
        }
        await run(() => start(validateStart(parsed, event.user.name)));
      } else if (cmd === mods.lockCommand) {
        if (active?.status === 'active') await run(lock);
      } else if (cmd === mods.resolveCommand) {
        if (!active) return;
        const index = findOutcome(active, rest);
        if (index < 0) {
          reply(`Wer hat gewonnen? !${mods.resolveCommand} 1 bis ${active.outcomes.length} – ${values(active).outcomes}`);
          return;
        }
        await run(() => resolve(index));
      } else if (cmd === mods.cancelCommand) {
        if (active) await run(cancel);
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

    const publicSettings = () => ({ ...settings.all(), history: undefined });

    ctx.api.get('/state', async () => ({
      settings: publicSettings(),
      history: settings.get('history'),
      active: active ? publicPrediction(active) : null,
      now: Date.now(),
      /** '' = normaler Kanal, 'affiliate', 'partner'; null = unbekannt */
      broadcasterType: await broadcasterInfo(),
      limits: LIMITS,
    }));

    ctx.api.get('/overlay-state', () => overlayState());

    ctx.api.post('/start', async ({ body }) => publicPrediction(await start(validateStart(body ?? {}, 'Dashboard'))));
    ctx.api.post('/lock', async () => {
      await lock();
    });
    ctx.api.post('/resolve', async ({ body }) => resolve(typeof body?.index === 'number' ? body.index : body?.outcomeId));
    ctx.api.post('/cancel', async () => cancel());

    /** Overlay mit einer Beispiel-Vorhersage testen (ändert nichts bei Twitch oder im Chat) */
    ctx.api.post('/overlay/test', () => {
      const now = Date.now();
      const outcomes: Outcome[] = [
        { id: 'a', title: 'Ja, locker', color: 'blue', users: 14, channelPoints: 5200 },
        { id: 'b', title: 'Niemals', color: 'pink', users: 19, channelPoints: 8100 },
      ];
      ctx.overlay.broadcast({
        ...overlayState(),
        prediction: {
          id: 'demo', title: 'Schaffe ich den Boss beim ersten Versuch?', outcomes, status: 'active',
          startedAt: now, locksAt: now + 12_000, external: false, startedBy: 'Test', test: true,
          totalUsers: sumUsers(outcomes), totalPoints: sumPoints(outcomes),
        },
        result: null,
        demo: true,
      });
    });

    ctx.api.post('/settings', ({ body }) => {
      const s = settings.all();
      if (body?.defaults) {
        s.defaults = { windowSeconds: int(body.defaults.windowSeconds, LIMITS.minSeconds, LIMITS.maxSeconds) };
      }
      if (body?.messages) {
        const msg = (m: { enabled?: unknown; text?: unknown } | undefined, fallback: Message): Message =>
          m ? { enabled: m.enabled !== false, text: oneLine(m.text, 500) } : fallback;
        s.messages = {
          start: msg(body.messages.start, s.messages.start),
          lock: msg(body.messages.lock, s.messages.lock),
          result: msg(body.messages.result, s.messages.result),
          cancel: msg(body.messages.cancel, s.messages.cancel),
        };
      }
      if (body?.modCommands) {
        const m = body.modCommands;
        const names = [cmdName(m.startCommand), cmdName(m.lockCommand), cmdName(m.resolveCommand), cmdName(m.cancelCommand)];
        if (names.some((n) => !CMD_RE.test(n))) throw new HttpError(400, 'Ungültiger Command-Name (nur Buchstaben, Zahlen, _ und -).');
        if (new Set(names).size !== names.length) throw new HttpError(400, 'Die vier Commands müssen verschieden sein.');
        const [startCommand, lockCommand, resolveCommand, cancelCommand] = names;
        s.modCommands = { enabled: m.enabled !== false, startCommand, lockCommand, resolveCommand, cancelCommand, permission: parseRole(m.permission, 'moderator') };
      }
      if (body?.overlay) {
        const o = body.overlay;
        const color = (v: unknown, fallback: string) => (typeof v === 'string' && COLOR_RE.test(v) ? v : fallback);
        s.overlay = {
          blue: color(o.blue, DEFAULTS.overlay.blue),
          pink: color(o.pink, DEFAULTS.overlay.pink),
          textColor: color(o.textColor, DEFAULTS.overlay.textColor),
          background: color(o.background, DEFAULTS.overlay.background),
          backgroundOpacity: int(o.backgroundOpacity, 0, 100),
          fontSize: int(o.fontSize, 12, 60),
          width: int(o.width, 250, 1920),
          showResultSeconds: int(o.showResultSeconds, 0, 300),
          showStats: o.showStats !== false,
          showTimer: o.showTimer !== false,
        };
      }
      settings.update({ defaults: s.defaults, messages: s.messages, modCommands: s.modCommands, overlay: s.overlay });
      broadcast(true);
      return publicSettings();
    });

    ctx.api.post('/history/delete', ({ body }) => {
      settings.set('history', settings.get('history').filter((h) => h.id !== body?.id));
    });

    ctx.api.post('/history/clear', () => {
      settings.set('history', []);
    });

    // Falls die Suite neu gestartet wurde, während bei Twitch eine Vorhersage läuft → übernehmen
    let tries = 0;
    let startup: NodeJS.Timeout | null = null;
    const adoptRunning = async () => {
      const me = ctx.getUser();
      if (!me) {
        if (++tries < 30) startup = setTimeout(adoptRunning, 2000);
        return;
      }
      if ((await broadcasterInfo()) === '') return; // kein Affiliate → keine Vorhersagen
      try {
        const res = await ctx.twitch.request<{ data: HelixPrediction[] }>('GET', '/predictions', { query: { broadcaster_id: me.id, first: '1' } });
        const d = res.data[0];
        if (!d || (d.status !== 'ACTIVE' && d.status !== 'LOCKED') || (active && !active.test)) return;
        const startedAt = new Date(d.created_at).getTime();
        setActive({
          id: d.id,
          title: d.title,
          outcomes: fromHelix(d.outcomes),
          status: d.status === 'LOCKED' ? 'locked' : 'active',
          startedAt,
          locksAt: startedAt + d.prediction_window * 1000,
          external: true,
          startedBy: 'Twitch',
          test: false,
        });
        ctx.log.info(`Laufende Vorhersage übernommen: „${d.title}“`);
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
