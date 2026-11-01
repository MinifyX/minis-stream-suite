import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StreamEvent } from '../../core/twitch/events';

/**
 * Weiterleitung an den UwUClip-Server (ohne Electron, damit es sich testen lässt).
 *
 * Events landen in einer Warteschlange, die als JSON-Datei gespeichert wird (überlebt einen Neustart).
 * Alle paar Sekunden geht ein Paket (max. 1000 Events) signiert an POST <server>/api/hooks/suite.
 * Ist der Server nicht erreichbar, wird mit wachsendem Abstand (bis 5 Min.) erneut versucht.
 * Bei 401/403 (falscher Schlüssel, nicht eingerichtet) pausiert die Weiterleitung, bis jemand
 * die Einstellungen ändert oder „Erneut versuchen“ drückt.
 */

export const SOURCE = 'minis-stream-suite';
export const HOOK_PATH = '/api/hooks/suite';
export const MAX_BATCH = 1000;
export const MAX_OUTBOX = 10_000;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const SEND_INTERVAL_MS = 2000;
export const BACKOFF_START_MS = 2000;
export const BACKOFF_MAX_MS = 5 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 10_000;

export interface SuiteEffect {
  group: string;
  foreign: boolean;
}

export interface SuiteEvent {
  /** Zufällige UUID, bleibt bei erneutem Senden gleich (der Server erkennt Doppelte) */
  id: string;
  /** Wann die Suite das Event bekommen hat (bei alert_shown: wann der Alert erschien) */
  at: number;
  type: string;
  /** Nur bei Einlösungen: Kanalpunkte-Gruppe der Belohnung, null = in keiner Gruppe */
  effect?: SuiteEffect | null;
  /** alert_shown: ID des weitergeleiteten Events, dessen Alert erschien */
  ref?: string | null;
  /** alert_shown: Name der Alert-Variante */
  variant?: string | null;
  data: Record<string, unknown>;
}

export interface SuiteBatch {
  source: typeof SOURCE;
  version: string;
  events: SuiteEvent[];
}

// ------------------------------------------------------------------ Was wird weitergeleitet?

/** Event-Arten, die weitergehen. Chat, Löschungen und erledigte Einlösungen bleiben in der Suite. */
export const FORWARDED_TYPES: ReadonlySet<string> = new Set([
  'redemption', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'follow', 'poll', 'prediction', 'hypetrain',
  'adbreak', 'shoutout', 'streamonline', 'streamoffline', 'channelupdate',
]);

export function shouldForward(event: StreamEvent): boolean {
  if (event.test || !FORWARDED_TYPES.has(event.type)) return false;
  // Umfragen und Vorhersagen nur Start und Ende, keine Zwischenstände
  if (event.type === 'poll' || event.type === 'prediction') return event.phase === 'begin' || event.phase === 'end';
  // Hype Train nur, wenn er vorbei ist: UwUClip nutzt nur beendete, der Fortschritt kommt sehr oft
  if (event.type === 'hypetrain') return event.phase === 'end';
  return true;
}

export function toSuiteEvent(event: StreamEvent, meta: { id: string; at: number; effect?: SuiteEffect | null }): SuiteEvent {
  const { type, test: _test, ...data } = event;
  // Wer beim Hype Train am meisten gegeben hat, braucht UwUClip nicht (weniger Namen, kleinere Pakete)
  if (type === 'hypetrain') delete (data as Record<string, unknown>).topContributions;
  const out: SuiteEvent = { id: meta.id, at: meta.at, type, data };
  if (type === 'redemption') out.effect = meta.effect ?? null;
  return out;
}

export function alertShownEvent(meta: { id: string; at: number; ref: string | null; variant: string | null; event: StreamEvent; category?: string }): SuiteEvent {
  return {
    id: meta.id,
    at: meta.at,
    type: 'alert_shown',
    ref: meta.ref,
    variant: meta.variant,
    data: { eventType: meta.event.type, category: meta.category ?? null },
  };
}

/**
 * Merkt sich, welche ID ein Event bekommen hat – damit alert_shown auf das richtige Event zeigt.
 * Normalerweise reicht das Event-Objekt selbst (die Alerts bekommen dasselbe Objekt). Für „Nochmal
 * abspielen“ aus dem Verlauf (kann eine Kopie sein) gibt es zusätzlich einen Schlüssel aus den Daten.
 */
export class EventIds {
  private byObject = new WeakMap<object, string>();
  private byKey = new Map<string, string>();

  constructor(private max = 500) {}

  remember(event: StreamEvent, id: string): void {
    this.byObject.set(event, id);
    const key = eventKey(event);
    if (!key) return;
    this.byKey.delete(key);
    this.byKey.set(key, id);
    if (this.byKey.size > this.max) this.byKey.delete(this.byKey.keys().next().value!);
  }

  find(event: StreamEvent): string | null {
    const direct = this.byObject.get(event);
    if (direct) return direct;
    const key = eventKey(event);
    return key ? this.byKey.get(key) ?? null : null;
  }
}

/** Schlüssel, der ein Event wiedererkennt, auch wenn es eine Kopie ist (null = nicht eindeutig genug) */
export function eventKey(event: StreamEvent): string | null {
  const who = 'user' in event ? event.user?.id ?? 'anon' : '';
  switch (event.type) {
    case 'redemption': return `redemption:${event.redemptionId}`;
    case 'follow': return `follow:${who}`;
    case 'sub': return `sub:${who}:${event.tier}:${event.isGift}`;
    case 'resub': return `resub:${who}:${event.months}`;
    case 'giftsub': return `giftsub:${who}:${event.count}:${event.tier}`;
    case 'cheer': return `cheer:${who}:${event.bits}:${event.message}`;
    case 'raid': return `raid:${who}:${event.viewers}`;
    case 'hypetrain': return `hypetrain:${event.phase}:${event.level}:${event.total}`;
    default: return null;
  }
}

// ------------------------------------------------------------------ Signatur & Adresse

/** X-UwUClip-Signature: "sha256=" + HMAC-SHA256(secret, "<timestamp>.<body>") als Hex */
export function sign(secret: string, timestamp: number, body: string): string {
  return `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

export function signedHeaders(secret: string, timestamp: number, body: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-UwUClip-Timestamp': String(timestamp),
    'X-UwUClip-Signature': sign(secret, timestamp, body),
  };
}

/** Server-Adresse prüfen: nur http(s), ohne Zugangsdaten, ohne / am Ende. Leer bleibt leer. */
export function normalizeServerUrl(input: string): string {
  const text = input.trim();
  if (!text) return '';
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error('Ungültige Server-Adresse');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Die Server-Adresse muss mit http:// oder https:// beginnen');
  if (url.username || url.password) throw new Error('Die Server-Adresse darf keine Zugangsdaten enthalten');
  if (url.search || url.hash) throw new Error('Die Server-Adresse darf kein ? oder # enthalten');
  return `${url.origin}${url.pathname}`.replace(/\/+$/, '');
}

export function backoffDelay(failures: number): number {
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** Math.max(0, failures - 1));
}

/** Verständliche Meldung zu einer Antwort des Servers */
export function describeStatus(status: number): string {
  if (status === 401) return 'Abgelehnt (401): Schlüssel falsch oder die Uhr dieses PCs geht falsch.';
  if (status === 403) return 'Abgelehnt (403): Die Stream-Suite ist auf dem UwUClip-Server nicht eingerichtet.';
  if (status === 400) return 'Abgelehnt (400): Der Server versteht die Daten nicht.';
  if (status === 413) return 'Abgelehnt (413): Zu viele Daten auf einmal.';
  return `Server antwortet mit Fehler ${status}`;
}

function describeNetworkError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  if (name === 'TimeoutError' || name === 'AbortError') return 'Keine Antwort vom Server (Zeitüberschreitung)';
  if (/redirect/i.test(String((err as { cause?: { message?: string } })?.cause?.message ?? ''))) {
    return 'Der Server leitet um – bitte die genaue Adresse eintragen (z.B. mit https://)';
  }
  const cause = (err as { cause?: { code?: string } })?.cause?.code;
  return `Server nicht erreichbar${cause ? ` (${cause})` : ''}`;
}

// ------------------------------------------------------------------ Weiterleitung

export interface ForwarderConfig {
  serverUrl: string;
  secret: string;
}

export type ForwarderState = 'off' | 'idle' | 'connected' | 'retrying' | 'paused';

export interface ForwarderStatus {
  state: ForwarderState;
  queued: number;
  lastSentAt: number | null;
  lastError: string | null;
  nextAttemptAt: number | null;
  /** Events, die weggefallen sind (zu alt, Warteschlange voll, vom Server abgelehnt) */
  dropped: number;
}

export type TestResult =
  | { ok: true; status: number; accepted: number; dropped: number }
  | { ok: false; status: number | null; error: string };

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

export interface ForwarderDeps {
  /** Datei für die Warteschlange */
  file: string;
  /** Version der Suite */
  version: string;
  /** Aktuelle Verbindung – null = aus oder nicht eingerichtet */
  config(): ForwarderConfig | null;
  now?: () => number;
  fetch?: typeof fetch;
  log?: Logger;
}

type PostResult = { status: number; body: Record<string, unknown> | null };

function isSuiteEvent(value: unknown): value is SuiteEvent {
  const e = value as SuiteEvent;
  return !!e && typeof e === 'object' && typeof e.id === 'string' && typeof e.type === 'string'
    && typeof e.at === 'number' && !!e.data && typeof e.data === 'object';
}

export class Forwarder {
  private queue: SuiteEvent[] = [];
  private dirty = false;
  private sending: Promise<void> | null = null;
  private paused = false;
  private failures = 0;
  private nextAttemptAt = 0;
  private batchLimit = MAX_BATCH;
  private lastSentAt: number | null = null;
  private lastError: string | null = null;
  private dropped = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private now: () => number;
  private fetchFn: typeof fetch;

  constructor(private deps: ForwarderDeps) {
    this.now = deps.now ?? Date.now;
    this.fetchFn = deps.fetch ?? fetch;
    this.load();
  }

  /** Regelmäßig senden (Timer hält die App nicht am Leben) */
  start(intervalMs = SEND_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  /** Timer stoppen und die Warteschlange speichern */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.save();
  }

  enqueue(event: SuiteEvent): void {
    this.queue.push(event);
    if (this.queue.length > MAX_OUTBOX) this.drop(this.queue.length - MAX_OUTBOX);
    this.dirty = true;
  }

  /** Nach geänderten Einstellungen oder per Knopf: Pause und Wartezeit aufheben */
  resume(): void {
    this.paused = false;
    this.failures = 0;
    this.nextAttemptAt = 0;
    this.lastError = null;
  }

  clear(): void {
    this.queue = [];
    this.dirty = true;
    this.save();
  }

  status(): ForwarderStatus {
    const configured = this.deps.config() !== null;
    let state: ForwarderState = 'idle';
    if (!configured) state = 'off';
    else if (this.paused) state = 'paused';
    else if (this.failures > 0) state = 'retrying';
    else if (this.lastSentAt !== null) state = 'connected';
    return {
      state,
      queued: this.queue.length,
      lastSentAt: this.lastSentAt,
      lastError: this.lastError,
      nextAttemptAt: state === 'retrying' ? this.nextAttemptAt : null,
      dropped: this.dropped,
    };
  }

  /** Wartende Events senden (läuft nie doppelt). Fehler landen im Status, nie als Exception. */
  flush(): Promise<void> {
    this.sending ??= this.sendAll().finally(() => {
      this.sending = null;
      this.save();
    });
    return this.sending;
  }

  /** Leeres, signiertes Paket schicken – zeigt, ob Adresse und Schlüssel stimmen */
  async test(override?: Partial<ForwarderConfig>): Promise<TestResult> {
    const base = this.deps.config();
    const cfg = { serverUrl: override?.serverUrl || base?.serverUrl || '', secret: override?.secret || base?.secret || '' };
    if (!cfg.serverUrl) return { ok: false, status: null, error: 'Keine Server-Adresse eingetragen' };
    if (!cfg.secret) return { ok: false, status: null, error: 'Kein Schlüssel eingetragen' };
    try {
      const res = await this.post(cfg, []);
      if (res.status >= 200 && res.status < 300) {
        return { ok: true, status: res.status, accepted: Number(res.body?.accepted) || 0, dropped: Number(res.body?.dropped) || 0 };
      }
      return { ok: false, status: res.status, error: describeStatus(res.status) };
    } catch (err) {
      return { ok: false, status: null, error: describeNetworkError(err) };
    }
  }

  // ---------------------------------------------------------------- intern

  private async sendAll(): Promise<void> {
    const now = this.now();
    this.expire(now);
    const cfg = this.deps.config();
    if (!cfg || this.paused || now < this.nextAttemptAt) return;
    while (this.queue.length) {
      const batch = this.queue.slice(0, this.batchLimit);
      let res: PostResult;
      try {
        res = await this.post(cfg, batch);
      } catch (err) {
        this.fail(describeNetworkError(err));
        return;
      }
      const { status } = res;
      if (status >= 200 && status < 300) {
        const sent = new Set(batch.map((e) => e.id));
        this.queue = this.queue.filter((e) => !sent.has(e.id));
        this.dirty = true;
        if (this.failures > 0 || this.lastError) this.deps.log?.info('UwUClip ist wieder erreichbar');
        this.failures = 0;
        this.nextAttemptAt = 0;
        this.lastError = null;
        this.lastSentAt = this.now();
        this.batchLimit = Math.min(MAX_BATCH, this.batchLimit * 2);
        continue;
      }
      if (status === 401 || status === 403) {
        this.paused = true;
        this.lastError = describeStatus(status);
        this.deps.log?.warn(`Weiterleitung pausiert: ${this.lastError}`);
        return;
      }
      if (status === 400 || status === 413) {
        // Kleinere Pakete probieren; ein einzelnes abgelehntes Event fällt weg, damit nichts hängen bleibt
        this.lastError = describeStatus(status);
        if (batch.length > 1) {
          this.batchLimit = Math.max(1, Math.floor(batch.length / 2));
          continue;
        }
        this.deps.log?.warn(`Event (${batch[0].type}) vom Server abgelehnt (${status}), wird verworfen`);
        this.queue = this.queue.filter((e) => e.id !== batch[0].id);
        this.dropped++;
        this.dirty = true;
        continue;
      }
      this.fail(describeStatus(status));
      return;
    }
  }

  private fail(message: string): void {
    if (this.failures === 0) this.deps.log?.warn(`UwUClip: ${message} – versuche es später nochmal`);
    this.failures++;
    this.lastError = message;
    this.nextAttemptAt = this.now() + backoffDelay(this.failures);
  }

  private async post(cfg: ForwarderConfig, events: SuiteEvent[]): Promise<PostResult> {
    const batch: SuiteBatch = { source: SOURCE, version: this.deps.version, events };
    const body = JSON.stringify(batch);
    const res = await this.fetchFn(`${cfg.serverUrl}${HOOK_PATH}`, {
      method: 'POST',
      headers: signedHeaders(cfg.secret, this.now(), body),
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    });
    const parsed = await res.json().catch(() => null);
    return { status: res.status, body: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null };
  }

  private expire(now: number): void {
    const before = this.queue.length;
    this.queue = this.queue.filter((e) => e.at >= now - MAX_AGE_MS);
    if (this.queue.length !== before) {
      this.dropped += before - this.queue.length;
      this.dirty = true;
    }
  }

  private drop(count: number): void {
    this.queue.splice(0, count);
    this.dropped += count;
  }

  private load(): void {
    try {
      const stored = JSON.parse(fs.readFileSync(this.deps.file, 'utf8'));
      this.queue = Array.isArray(stored?.events) ? stored.events.filter(isSuiteEvent) : [];
    } catch {
      this.queue = []; // noch keine Datei (oder kaputt) → leer anfangen
    }
    this.expire(this.now());
    if (this.queue.length > MAX_OUTBOX) this.drop(this.queue.length - MAX_OUTBOX);
  }

  private save(): void {
    if (!this.dirty) return;
    try {
      fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
      const tmp = `${this.deps.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ events: this.queue }));
      fs.renameSync(tmp, this.deps.file);
      this.dirty = false;
    } catch (err) {
      this.deps.log?.warn('Warteschlange konnte nicht gespeichert werden:', err);
    }
  }
}
