import type { Addon, AddonContext } from '../../core/addons';
import { HttpError } from '../../core/server';

/**
 * Werbepausen-Addon. Solange du live bist, fragt es bei Twitch nach, wann die nächste
 * automatische Werbung kommt, und warnt vorher im Chat und/oder im OBS-Overlay.
 * Läuft die Werbung (auch von Hand gestartet), zeigt das Overlay einen Countdown,
 * danach optional „Wir sind zurück!“.
 *
 * Twitch-Rechte: channel:read:ads (Zeitplan) und channel:manage:ads (verschieben, starten).
 * Werbung gibt es nur für Affiliates und Partner.
 */

// ------------------------------------------------------------------ Datenmodell

/** Eine Vorwarnung, z.B. 60 Sekunden vor der Werbung */
interface Warning {
  seconds: number;
  chat: boolean;
  message: string;
  overlay: boolean;
}

interface Announcement {
  chat: boolean;
  message: string;
  overlay: boolean;
}

type Position = 'top-left' | 'top' | 'top-right' | 'center' | 'bottom-left' | 'bottom' | 'bottom-right';
const POSITIONS: Position[] = ['top-left', 'top', 'top-right', 'center', 'bottom-left', 'bottom', 'bottom-right'];

interface OverlaySettings {
  position: Position;
  accent: string;
  textColor: string;
  background: string;
  backgroundOpacity: number;
  fontSize: number;
  width: number;
  warningTitle: string;
  runningTitle: string;
  backTitle: string;
  /** Vorwarnung so lange zeigen (Sekunden, 0 = bis die Werbung startet) */
  warningDisplaySeconds: number;
  /** „Wir sind zurück!“ so lange zeigen */
  backSeconds: number;
}

interface Settings {
  warnings: Warning[];
  start: Announcement;
  end: Announcement;
  overlay: OverlaySettings;
}

const DEFAULTS: Settings = {
  warnings: [
    { seconds: 60, chat: true, message: 'Achtung: In {seconds} Sekunden kommt Werbung. Kurz Wasser holen! 💧', overlay: true },
  ],
  start: { chat: true, message: "Werbung läuft für {duration} Sekunden. Gleich geht's weiter!", overlay: true },
  end: { chat: false, message: 'Wir sind zurück! 💜', overlay: true },
  overlay: {
    position: 'top',
    accent: '#9147ff',
    textColor: '#ffffff',
    background: '#18181b',
    backgroundOpacity: 88,
    fontSize: 26,
    width: 520,
    warningTitle: 'Gleich kommt Werbung',
    runningTitle: 'Werbung läuft',
    backTitle: 'Wir sind zurück!',
    warningDisplaySeconds: 0,
    backSeconds: 6,
  },
};

/** Was Twitch über die nächste Werbung weiß */
interface Schedule {
  /** Zeitpunkt der nächsten geplanten Werbung (ms) oder null, wenn keine geplant ist */
  nextAdAt: number | null;
  lastAdAt: number | null;
  /** Länge der nächsten Werbung in Sekunden */
  duration: number;
  /** Restliche werbefreie Zeit für neue Zuschauer (Sekunden) */
  prerollFreeTime: number;
  snoozeCount: number;
  snoozeRefreshAt: number | null;
  fetchedAt: number;
}

interface RunningAd {
  startedAt: number;
  endsAt: number;
  durationSeconds: number;
  automatic: boolean;
  test: boolean;
}

type Phase = 'idle' | 'warning' | 'running' | 'back';

interface OverlayPhase {
  phase: Phase;
  /** Bis wann der Countdown läuft (Werbung startet / endet) */
  endsAt: number;
  /** Ab wann der Countdown lief (für den Fortschrittsbalken) */
  startedAt: number;
  /** Banner ausblenden ab (0 = erst beim nächsten Wechsel) */
  hideAt: number;
}

const COMMERCIAL_LENGTHS = [30, 60, 90, 120, 150, 180];
const COLOR_RE = /^#[0-9a-f]{6}$/i;
const POLL_SLOW_MS = 30_000;
const POLL_FAST_MS = 10_000;
const POLL_OFFLINE_MS = 180_000;
const POLL_ERROR_MS = 120_000;
const LIVE_RECHECK_MS = 5 * 60_000;

// ------------------------------------------------------------------ Helfer

const int = (v: unknown, min: number, max: number, fallback = min) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};
const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, max);

/**
 * Twitch liefert Zeitpunkte je nach Feld als Unix-Sekunden (Zahl oder Text) oder als
 * RFC3339-Text. 0 oder leer heißt „keiner“.
 */
function parseTime(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n <= 0) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  const t = Date.parse(String(value));
  return Number.isFinite(t) && t > 0 ? t : null;
}

/** „5 Minuten“, „90 Sekunden“, „1 Minute“ */
function readable(seconds: number): string {
  if (seconds >= 60 && seconds % 60 === 0) {
    const m = seconds / 60;
    return `${m} ${m === 1 ? 'Minute' : 'Minuten'}`;
  }
  return `${seconds} ${seconds === 1 ? 'Sekunde' : 'Sekunden'}`;
}

/** Twitch-Fehler in verständliches Deutsch übersetzen */
function explain(err: unknown, action: 'schedule' | 'snooze' | 'commercial'): HttpError {
  const raw = (err as Error)?.message ?? String(err);
  const match = /Twitch API (\d+): (.*)/s.exec(raw);
  const status = match ? Number(match[1]) : 0;
  const text = (match ? match[2] : raw).trim();
  const lower = text.toLowerCase();

  if (lower.includes('nicht bei twitch eingeloggt')) return new HttpError(401, 'Nicht bei Twitch eingeloggt.');
  if (status === 401) {
    return new HttpError(401, 'Der Suite fehlt das Recht für Werbepausen. Bitte in der Übersicht neu mit Twitch verbinden.');
  }
  if (lower.includes('affiliate') || lower.includes('partner') || status === 403) {
    return new HttpError(403, 'Werbepausen gibt es nur für Twitch-Affiliates und -Partner.');
  }
  if (lower.includes('live') || lower.includes('streaming')) {
    return new HttpError(400, 'Das geht nur, während du live bist.');
  }
  if (action === 'snooze' && (status === 429 || lower.includes('snooze'))) {
    return new HttpError(429, 'Du hast gerade keine Verschiebungen mehr übrig. Twitch gibt dir nach und nach neue dazu.');
  }
  if (action === 'snooze' && (lower.includes('upcoming') || lower.includes('scheduled'))) {
    return new HttpError(400, 'Gerade ist keine Werbung geplant, die man verschieben könnte.');
  }
  if (action === 'commercial' && (status === 429 || lower.includes('cooldown') || lower.includes('retry'))) {
    return new HttpError(429, 'Twitch lässt gerade noch keine neue Werbung zu – nach einer Werbepause gibt es eine Wartezeit.');
  }
  return new HttpError(status >= 400 && status < 500 ? 400 : 502, `Twitch: ${text || 'unbekannter Fehler'}`);
}

function validateAnnouncement(input: unknown, fallback: Announcement): Announcement {
  const a = (input ?? {}) as Record<string, unknown>;
  return {
    chat: a.chat === undefined ? fallback.chat : a.chat === true,
    message: a.message === undefined ? fallback.message : oneLine(a.message, 500),
    overlay: a.overlay === undefined ? fallback.overlay : a.overlay === true,
  };
}

function validateWarnings(input: unknown): Warning[] {
  if (!Array.isArray(input)) throw new HttpError(400, 'Ungültige Vorwarnungen.');
  if (input.length > 5) throw new HttpError(400, 'Höchstens 5 Vorwarnungen.');
  const list = input.map((w: Record<string, unknown>) => ({
    seconds: int(w?.seconds, 10, 1800, 60),
    chat: w?.chat === true,
    message: oneLine(w?.message, 500),
    overlay: w?.overlay === true,
  }));
  const seen = new Set<number>();
  for (const w of list) {
    if (seen.has(w.seconds)) throw new HttpError(400, `Die Vorwarnung „${readable(w.seconds)} vorher“ gibt es doppelt.`);
    seen.add(w.seconds);
    if (w.chat && !w.message) throw new HttpError(400, `Die Vorwarnung „${readable(w.seconds)} vorher“ braucht einen Text für den Chat.`);
  }
  // Größte Vorlaufzeit zuerst
  return list.sort((a, b) => b.seconds - a.seconds);
}

function validateOverlay(input: unknown): OverlaySettings {
  const o = (input ?? {}) as Record<string, unknown>;
  const d = DEFAULTS.overlay;
  const color = (v: unknown, fallback: string) => (typeof v === 'string' && COLOR_RE.test(v) ? v : fallback);
  const text = (v: unknown, fallback: string) => oneLine(v, 60) || fallback;
  return {
    position: POSITIONS.includes(o.position as Position) ? (o.position as Position) : d.position,
    accent: color(o.accent, d.accent),
    textColor: color(o.textColor, d.textColor),
    background: color(o.background, d.background),
    backgroundOpacity: int(o.backgroundOpacity, 0, 100, d.backgroundOpacity),
    fontSize: int(o.fontSize, 12, 80, d.fontSize),
    width: int(o.width, 200, 1920, d.width),
    warningTitle: text(o.warningTitle, d.warningTitle),
    runningTitle: text(o.runningTitle, d.runningTitle),
    backTitle: text(o.backTitle, d.backTitle),
    warningDisplaySeconds: int(o.warningDisplaySeconds, 0, 1800, d.warningDisplaySeconds),
    backSeconds: int(o.backSeconds, 1, 60, d.backSeconds),
  };
}

// ------------------------------------------------------------------ Addon

export const adsAddon: Addon = {
  id: 'ads',
  name: 'Werbepausen',
  icon: '📺',
  version: '0.1.0',
  author: 'Mini',
  description: 'Warnt Chat und Overlay vor der nächsten Werbung, zeigt einen Countdown und lässt dich Werbung verschieben oder starten.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);

    // Laufzeit-Zustand (wird nicht gespeichert)
    let live: boolean | null = null;
    let lastLiveCheck = 0;
    let schedule: Schedule | null = null;
    let scheduleError: string | null = null;
    let running: RunningAd | null = null;
    let overlayPhase: OverlayPhase = { phase: 'idle', endsAt: 0, startedAt: 0, hideAt: 0 };
    /** Schon gesendete Vorwarnungen, Schlüssel "<nextAdAt>:<Sekunden>" */
    const firedWarnings = new Set<string>();
    /** '' = normaler Kanal, 'affiliate', 'partner'; null = unbekannt */
    let broadcasterType: string | null = null;
    let disposed = false;

    // -------------------------------------------------------- Overlay

    const overlayState = () => ({
      kind: 'state',
      now: Date.now(),
      ...overlayPhase,
      durationSeconds: running?.durationSeconds ?? schedule?.duration ?? 0,
      overlay: settings.get('overlay'),
    });
    const broadcast = () => ctx.overlay.broadcast(overlayState());

    const setPhase = (phase: Phase, endsAt = 0, startedAt = Date.now(), hideAt = 0) => {
      overlayPhase = { phase, endsAt, startedAt, hideAt };
      broadcast();
    };

    // -------------------------------------------------------- Chat

    const say = async (template: string, values: Record<string, string>) => {
      if (!template.trim() || !ctx.getUser()) return;
      try {
        await ctx.chat.send(await ctx.chat.render(template, { values }));
      } catch (err) {
        ctx.log.warn('Chat-Nachricht fehlgeschlagen:', err);
      }
    };

    // -------------------------------------------------------- Twitch abfragen

    const checkLive = async (): Promise<boolean> => {
      const me = ctx.getUser()!;
      const res = await ctx.twitch.request<{ data: unknown[] }>('GET', '/streams', { query: { user_id: me.id } });
      lastLiveCheck = Date.now();
      return res.data.length > 0;
    };

    const loadBroadcasterType = async () => {
      const me = ctx.getUser();
      if (!me || broadcasterType !== null) return;
      try {
        const res = await ctx.twitch.request<{ data: { broadcaster_type: string }[] }>('GET', '/users', { query: { id: me.id } });
        broadcasterType = res.data[0]?.broadcaster_type ?? '';
      } catch {
        // egal, dann eben unbekannt
      }
    };

    type RawSchedule = {
      next_ad_at?: unknown; last_ad_at?: unknown; duration?: unknown; preroll_free_time?: unknown;
      snooze_count?: unknown; snooze_refresh_at?: unknown;
    };

    const applySchedule = (raw: RawSchedule | undefined) => {
      const before = schedule?.nextAdAt ?? null;
      schedule = {
        nextAdAt: parseTime(raw?.next_ad_at),
        lastAdAt: parseTime(raw?.last_ad_at),
        duration: Number(raw?.duration) || 0,
        prerollFreeTime: Number(raw?.preroll_free_time) || 0,
        snoozeCount: Number(raw?.snooze_count) || 0,
        snoozeRefreshAt: parseTime(raw?.snooze_refresh_at),
        fetchedAt: Date.now(),
      };
      scheduleError = null;
      // Werbung verschoben (oder neu geplant) → eine gezeigte Vorwarnung passt nicht mehr
      if (before !== schedule.nextAdAt && overlayPhase.phase === 'warning') setPhase('idle');
    };

    const loadSchedule = async () => {
      const me = ctx.getUser()!;
      const res = await ctx.twitch.request<{ data: RawSchedule[] }>('GET', '/channels/ads', { query: { broadcaster_id: me.id } });
      applySchedule(res.data[0]);
    };

    // -------------------------------------------------------- Abfrage-Schleife

    let pollTimer: NodeJS.Timeout | null = null;
    let polling = false;

    const schedulePoll = (ms: number) => {
      if (disposed) return;
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = setTimeout(() => void poll(), ms);
    };

    /** Wann das nächste Mal nachfragen? Kurz vor der Werbung öfter. */
    const nextPollDelay = () => {
      const next = schedule?.nextAdAt;
      if (next && next - Date.now() < 3 * 60_000) return POLL_FAST_MS;
      return POLL_SLOW_MS;
    };

    const poll = async () => {
      if (disposed || polling) return;
      polling = true;
      try {
        if (!ctx.getUser()) {
          // Noch nicht eingeloggt (oder abgemeldet) → später nochmal schauen
          live = null;
          schedule = null;
          scheduleError = null;
          broadcasterType = null;
          schedulePoll(5000);
          return;
        }
        void loadBroadcasterType();
        if (live === null || (live && Date.now() - lastLiveCheck > LIVE_RECHECK_MS) || (!live && Date.now() - lastLiveCheck >= POLL_OFFLINE_MS - 1000)) {
          live = await checkLive();
        }
        if (!live) {
          schedule = null;
          scheduleError = null;
          schedulePoll(POLL_OFFLINE_MS);
          return;
        }
        try {
          await loadSchedule();
          schedulePoll(nextPollDelay());
        } catch (err) {
          scheduleError = explain(err, 'schedule').message;
          ctx.log.warn('Werbe-Zeitplan konnte nicht geladen werden:', err);
          schedulePoll(POLL_ERROR_MS);
        }
      } catch (err) {
        ctx.log.warn('Live-Status konnte nicht geladen werden:', err);
        schedulePoll(POLL_SLOW_MS);
      } finally {
        polling = false;
      }
    };

    /** Sofort neu abfragen (z.B. nach Verschieben oder Stream-Start) */
    const pollSoon = (ms = 500) => schedulePoll(ms);

    schedulePoll(1500);

    // -------------------------------------------------------- Events

    ctx.events.on('streamonline', (e) => {
      if (e.test) return;
      live = true;
      lastLiveCheck = Date.now();
      firedWarnings.clear();
      ctx.log.info('Stream ist live – Werbe-Zeitplan wird beobachtet');
      // Twitch braucht nach dem Live-Gehen kurz, bis der Zeitplan da ist
      pollSoon(5000);
    });

    ctx.events.on('streamoffline', (e) => {
      if (e.test) return;
      live = false;
      lastLiveCheck = Date.now();
      schedule = null;
      scheduleError = null;
      if (overlayPhase.phase === 'warning') setPhase('idle');
      ctx.log.info('Stream beendet – Werbe-Beobachtung pausiert');
      schedulePoll(POLL_OFFLINE_MS);
    });

    let endTimer: NodeJS.Timeout | null = null;
    let backTimer: NodeJS.Timeout | null = null;

    const adEnded = (ad: RunningAd) => {
      if (running !== ad) return;
      running = null;
      const end = settings.get('end');
      if (!ad.test && end.chat) void say(end.message, { duration: String(ad.durationSeconds) });
      if (end.overlay) {
        const now = Date.now();
        const hideAt = now + settings.get('overlay').backSeconds * 1000;
        setPhase('back', hideAt, now, hideAt);
        if (backTimer) clearTimeout(backTimer);
        backTimer = setTimeout(() => {
          if (overlayPhase.phase === 'back') setPhase('idle');
        }, hideAt - now + 100);
      } else {
        setPhase('idle');
      }
      // Nach der Werbung plant Twitch die nächste → gleich nachfragen
      if (!ad.test) pollSoon(5000);
    };

    ctx.events.on('adbreak', (e) => {
      const started = Date.parse(e.startedAt);
      const startedAt = Number.isFinite(started) && Math.abs(started - Date.now()) < 5 * 60_000 ? started : Date.now();
      const durationSeconds = Math.max(1, Math.round(e.durationSeconds || 0) || 30);
      const ad: RunningAd = { startedAt, endsAt: startedAt + durationSeconds * 1000, durationSeconds, automatic: e.automatic, test: !!e.test };
      running = ad;
      if (!e.test) {
        live = true;
        // Die geplante Werbung ist jetzt dran → ihre Vorwarnungen sind erledigt
        if (schedule?.nextAdAt) for (const w of settings.get('warnings')) firedWarnings.add(`${schedule.nextAdAt}:${w.seconds}`);
      }
      ctx.log.info(`Werbung läuft (${durationSeconds} s, ${e.automatic ? 'automatisch' : 'von Hand'}${e.test ? ', Test' : ''})`);

      const start = settings.get('start');
      if (!e.test && start.chat) void say(start.message, { duration: String(durationSeconds), time: readable(durationSeconds) });
      if (start.overlay) setPhase('running', ad.endsAt, ad.startedAt);
      else if (overlayPhase.phase !== 'idle') setPhase('idle');

      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(() => adEnded(ad), Math.max(0, ad.endsAt - Date.now()));
    });

    // -------------------------------------------------------- Vorwarnungen (jede Sekunde prüfen)

    const tick = setInterval(() => {
      const now = Date.now();

      // Vorwarnung im Overlay wieder ausblenden?
      if (overlayPhase.phase === 'warning') {
        const tooLate = now > overlayPhase.endsAt + 30_000; // Werbung kam nicht (oder Event verpasst)
        const hide = overlayPhase.hideAt && now >= overlayPhase.hideAt;
        if (tooLate || hide) setPhase('idle');
      }

      if (!live || running || !schedule?.nextAdAt) return;
      const nextAdAt = schedule.nextAdAt;
      const remaining = nextAdAt - now;
      if (remaining <= 2000) return;

      // Alle Vorwarnungen, deren Zeitpunkt erreicht ist und die noch nicht dran waren.
      // Kommen mehrere gleichzeitig dran (z.B. Suite erst kurz vorher gestartet), nur die kleinste senden.
      const due = settings.get('warnings')
        .filter((w) => w.seconds * 1000 >= remaining - 500 && !firedWarnings.has(`${nextAdAt}:${w.seconds}`))
        .sort((a, b) => a.seconds - b.seconds);
      if (!due.length) return;
      for (const w of due) firedWarnings.add(`${nextAdAt}:${w.seconds}`);
      const w = due[0];

      // Pünktlich → die eingestellte Zeit nennen (schöne runde Zahl), sonst die echte Restzeit
      const left = Math.round(remaining / 1000);
      const seconds = Math.abs(left - w.seconds) <= 2 ? w.seconds : left;
      const values = {
        seconds: String(seconds),
        minutes: String(Math.max(1, Math.round(seconds / 60))),
        time: readable(seconds),
        duration: String(schedule.duration || ''),
      };
      ctx.log.info(`Vorwarnung: Werbung in ${left} s`);
      if (w.chat) void say(w.message, values);
      if (w.overlay) {
        const display = settings.get('overlay').warningDisplaySeconds;
        setPhase('warning', nextAdAt, now, display ? now + display * 1000 : 0);
      }
      // Kurz vor der Werbung öfter nachfragen
      pollSoon(Math.min(nextPollDelay(), Math.max(1000, remaining - 1000)));
    }, 1000);

    // Aufräumen der gemerkten Vorwarnungen (alte Zeitpunkte)
    const cleanup = setInterval(() => {
      const now = Date.now();
      for (const key of firedWarnings) if (Number(key.split(':')[0]) < now - 10 * 60_000) firedWarnings.delete(key);
    }, 10 * 60_000);

    ctx.onDispose(() => {
      disposed = true;
      clearInterval(tick);
      clearInterval(cleanup);
      if (pollTimer) clearTimeout(pollTimer);
      if (endTimer) clearTimeout(endTimer);
      if (backTimer) clearTimeout(backTimer);
    });

    // -------------------------------------------------------- API

    const requireUser = () => {
      const me = ctx.getUser();
      if (!me) throw new HttpError(401, 'Nicht bei Twitch eingeloggt. Verbinde dich zuerst in der Übersicht mit Twitch.');
      return me;
    };

    const publicState = () => ({
      settings: settings.all(),
      loggedIn: !!ctx.getUser(),
      live,
      schedule,
      scheduleError,
      running,
      broadcasterType,
      overlayPhase: overlayPhase.phase,
      commercialLengths: COMMERCIAL_LENGTHS,
      now: Date.now(),
    });

    ctx.api.get('/state', () => publicState());

    /** Zeitplan sofort neu laden */
    ctx.api.post('/refresh', async () => {
      requireUser();
      live = await checkLive().catch((err) => {
        throw explain(err, 'schedule');
      });
      if (live) {
        try {
          await loadSchedule();
        } catch (err) {
          scheduleError = explain(err, 'schedule').message;
        }
      } else {
        schedule = null;
        scheduleError = null;
      }
      schedulePoll(live ? nextPollDelay() : POLL_OFFLINE_MS);
      return publicState();
    });

    /** Nächste Werbung um 5 Minuten verschieben */
    ctx.api.post('/snooze', async () => {
      const me = requireUser();
      if (live === false) throw new HttpError(400, 'Das geht nur, während du live bist.');
      try {
        const res = await ctx.twitch.request<{ data: RawSchedule[] }>('POST', '/channels/ads/schedule/snooze', { query: { broadcaster_id: me.id } });
        // Die Antwort enthält nur die neue Zeit und die Verschiebungen – der Rest bleibt, wie er war
        const d = res?.data?.[0];
        if (d && schedule) {
          const nextAdAt = parseTime(d.next_ad_at);
          if (nextAdAt !== schedule.nextAdAt && overlayPhase.phase === 'warning') setPhase('idle');
          schedule = { ...schedule, nextAdAt, snoozeCount: Number(d.snooze_count) || 0, snoozeRefreshAt: parseTime(d.snooze_refresh_at) };
        }
      } catch (err) {
        throw explain(err, 'snooze');
      }
      ctx.log.info('Nächste Werbung um 5 Minuten verschoben');
      pollSoon(3000);
      return publicState();
    });

    /** Werbung jetzt von Hand starten */
    ctx.api.post('/commercial', async ({ body }) => {
      const me = requireUser();
      const length = Number(body?.length);
      if (!COMMERCIAL_LENGTHS.includes(length)) throw new HttpError(400, 'Ungültige Länge (30 bis 180 Sekunden).');
      if (live === false) throw new HttpError(400, 'Das geht nur, während du live bist.');
      let result: { length?: number; message?: string; retry_after?: number } | undefined;
      try {
        const res = await ctx.twitch.request<{ data: { length: number; message: string; retry_after: number }[] }>('POST', '/channels/commercial', {
          body: { broadcaster_id: me.id, length },
        });
        result = res?.data?.[0];
      } catch (err) {
        throw explain(err, 'commercial');
      }
      ctx.log.info(`Werbung von Hand gestartet (${result?.length ?? length} s)`);
      pollSoon(5000);
      return { length: result?.length ?? length, retryAfter: result?.retry_after ?? 0, message: result?.message ?? '' };
    });

    ctx.api.post('/settings', ({ body }) => {
      const s = settings.all();
      if (body?.warnings !== undefined) s.warnings = validateWarnings(body.warnings);
      if (body?.start !== undefined) s.start = validateAnnouncement(body.start, s.start);
      if (body?.end !== undefined) s.end = validateAnnouncement(body.end, s.end);
      if (body?.overlay !== undefined) s.overlay = validateOverlay(body.overlay);
      settings.update({ warnings: s.warnings, start: s.start, end: s.end, overlay: s.overlay });
      broadcast();
      return settings.all();
    });

    /** Vorschau einer Nachricht mit Beispielwerten (sendet nichts) */
    ctx.api.post('/preview', async ({ body }) => ({
      text: await ctx.chat.render(oneLine(body?.message, 500), {
        values: { seconds: '60', minutes: '1', time: '60 Sekunden', duration: '90' },
      }),
    }));

    ctx.api.get('/overlay-state', () => overlayState());

    /** Overlay testen: Vorwarnung → Werbung → „zurück“ (nur im Overlay, nicht im Chat) */
    ctx.api.post('/overlay/test', () => {
      ctx.overlay.broadcast({
        kind: 'demo',
        now: Date.now(),
        overlay: settings.get('overlay'),
        warningSeconds: 10,
        runningSeconds: 15,
        showBack: settings.get('end').overlay,
      });
    });
  },
};
