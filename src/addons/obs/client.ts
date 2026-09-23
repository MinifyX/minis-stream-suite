import { createHash, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import type { Logger } from '../../core/log';

/**
 * Kleiner Client für obs-websocket v5 (ist ab OBS 28 eingebaut).
 * Doku: https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md
 *
 * Ablauf: OBS schickt „Hello“ (evtl. mit Passwort-Aufgabe) → wir antworten mit „Identify“
 * → OBS bestätigt mit „Identified“. Danach laufen Anfragen (Request/RequestResponse)
 * mit einer requestId und Events, die OBS von sich aus schickt.
 */

export type ObsState = 'disconnected' | 'connecting' | 'connected';

export interface ObsConnection {
  host: string;
  port: number;
  password: string;
}

export interface ObsStatus {
  state: ObsState;
  /** Letzter Fehler auf Deutsch (oder null) */
  error: string | null;
  obsVersion: string | null;
  wsVersion: string | null;
  /** Adresse, mit der wir verbunden sind / es versuchen */
  address: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Data = Record<string, any>;

/** Op-Codes aus dem Protokoll */
const OP = { Hello: 0, Identify: 1, Identified: 2, Event: 5, Request: 6, RequestResponse: 7 } as const;

/** Welche Event-Gruppen wir von OBS haben wollen (Bitmaske) */
const EVENTS = {
  General: 1 << 0,
  Config: 1 << 1,
  Scenes: 1 << 2,
  Inputs: 1 << 3,
  Filters: 1 << 5,
  SceneItems: 1 << 7,
};
const EVENT_SUBSCRIPTIONS = EVENTS.General | EVENTS.Config | EVENTS.Scenes | EVENTS.Inputs | EVENTS.Filters | EVENTS.SceneItems;

/** Close-Codes von OBS, bei denen ein neuer Versuch nichts bringt */
const FATAL_CLOSE: Record<number, string> = {
  4009: 'Falsches Passwort. Prüf das Passwort in OBS unter Werkzeuge → WebSocket-Server-Einstellungen.',
  4010: 'Diese OBS-Version wird nicht unterstützt. Bitte OBS auf Version 28 oder neuer aktualisieren.',
};

const REQUEST_TIMEOUT = 5000;
const IDENTIFY_TIMEOUT = 10_000;
const PING_INTERVAL = 15_000;
const MAX_RETRY_DELAY = 30_000;

/** base64(sha256(base64(sha256(passwort + salt)) + challenge)) */
export function authString(password: string, salt: string, challenge: string): string {
  const secret = createHash('sha256').update(password + salt).digest('base64');
  return createHash('sha256').update(secret + challenge).digest('base64');
}

interface Pending {
  resolve: (data: Data) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class ObsClient {
  private ws: WebSocket | null = null;
  private conn: ObsConnection | null = null;
  private stopped = true;
  private state: ObsState = 'disconnected';
  private error: string | null = null;
  private obsVersion: string | null = null;
  private wsVersion: string | null = null;
  private pending = new Map<string, Pending>();
  private retryDelay = 2000;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private identifyTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private alive = true;
  /** Damit der Log nicht bei jedem Versuch voll läuft */
  private loggedFailure = false;

  private eventHandlers = new Set<(type: string, data: Data) => void>();
  private stateHandlers = new Set<(status: ObsStatus) => void>();

  constructor(private log: Logger) {}

  get connected(): boolean {
    return this.state === 'connected';
  }

  status(): ObsStatus {
    return {
      state: this.state,
      error: this.error,
      obsVersion: this.obsVersion,
      wsVersion: this.wsVersion,
      address: this.conn ? `${this.conn.host}:${this.conn.port}` : null,
    };
  }

  /** OBS-Event abonnieren, z.B. ("SceneCreated", { sceneName }) */
  onEvent(handler: (type: string, data: Data) => void): () => void {
    this.eventHandlers.add(handler);
    return () => this.eventHandlers.delete(handler);
  }

  /** Verbindungsstatus hat sich geändert */
  onState(handler: (status: ObsStatus) => void): () => void {
    this.stateHandlers.add(handler);
    return () => this.stateHandlers.delete(handler);
  }

  /** Verbinden (und bei Abbruch automatisch neu verbinden, bis stop() kommt) */
  start(conn: ObsConnection): void {
    this.stop();
    this.conn = { ...conn };
    this.stopped = false;
    this.error = null;
    this.retryDelay = 2000;
    this.loggedFailure = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();
    }
    this.rejectAll('Verbindung zu OBS wurde getrennt.');
    // Absichtlich getrennt → kein Fehler anzeigen
    this.error = null;
    this.setState('disconnected');
  }

  /** Anfrage an OBS schicken. Wirft einen Fehler mit deutscher Beschreibung, wenn es nicht klappt. */
  request<T extends Data = Data>(requestType: string, requestData?: Data, timeoutMs = REQUEST_TIMEOUT): Promise<T> {
    const ws = this.ws;
    if (!ws || this.state !== 'connected') return Promise.reject(new Error('OBS ist nicht verbunden.'));
    const requestId = randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`OBS hat nicht rechtzeitig geantwortet (${requestType}).`));
      }, timeoutMs);
      this.pending.set(requestId, { resolve: resolve as (data: Data) => void, reject, timer });
      this.send(ws, OP.Request, { requestType, requestId, ...(requestData ? { requestData } : {}) });
    });
  }

  // -------------------------------------------------------------- intern

  private connect(): void {
    if (!this.conn || this.stopped) return;
    const { host, port } = this.conn;
    const url = `ws://${host.includes(':') ? `[${host}]` : host}:${port}`;
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, 'obswebsocket.json', { handshakeTimeout: 5000 });
    } catch (err) {
      this.fail(`Ungültige Adresse: ${(err as Error).message}`, true);
      return;
    }
    this.ws = ws;
    this.alive = true;

    ws.on('open', () => {
      // Wenn OBS sich nicht meldet, stimmt etwas nicht (z.B. falscher Port, anderes Programm)
      this.identifyTimer = setTimeout(() => {
        this.error = 'OBS hat sich nicht gemeldet. Stimmt der Port?';
        ws.terminate();
      }, IDENTIFY_TIMEOUT);
    });

    ws.on('message', (raw) => {
      let msg: { op: number; d: Data };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleMessage(ws, msg);
    });

    ws.on('pong', () => {
      this.alive = true;
    });

    ws.on('error', (err: NodeJS.ErrnoException) => {
      if (ws !== this.ws) return;
      this.error = explainSocketError(err, host, port);
    });

    ws.on('close', (code, reason) => {
      if (ws !== this.ws) return;
      this.ws = null;
      this.clearTimers();
      const wasConnected = this.state === 'connected';
      this.rejectAll('Verbindung zu OBS wurde getrennt.');
      const fatal = FATAL_CLOSE[code];
      if (fatal) {
        this.fail(fatal, true);
        return;
      }
      if (wasConnected) {
        this.log.warn(`Verbindung zu OBS getrennt (Code ${code}${reason.length ? `: ${reason.toString()}` : ''}) – neuer Versuch läuft automatisch.`);
        this.error = 'Verbindung zu OBS getrennt – versuche es erneut…';
        this.loggedFailure = true;
      }
      this.fail(this.error ?? `Verbindung zu OBS nicht möglich (Code ${code}).`, false);
    });
  }

  private handleMessage(ws: WebSocket, msg: { op: number; d: Data }): void {
    const d = msg.d ?? {};
    switch (msg.op) {
      case OP.Hello: {
        this.wsVersion = d.obsWebSocketVersion ?? null;
        const identify: Data = { rpcVersion: 1, eventSubscriptions: EVENT_SUBSCRIPTIONS };
        if (d.authentication) {
          const password = this.conn?.password ?? '';
          if (!password) {
            // Ohne Passwort ist jeder weitere Versuch sinnlos
            this.fail('OBS verlangt ein Passwort. Trag es hier ein (steht in OBS unter Werkzeuge → WebSocket-Server-Einstellungen → Verbindungsinformationen anzeigen).', true);
            return;
          }
          identify.authentication = authString(password, d.authentication.salt, d.authentication.challenge);
        }
        this.send(ws, OP.Identify, identify);
        break;
      }
      case OP.Identified: {
        if (this.identifyTimer) clearTimeout(this.identifyTimer);
        this.identifyTimer = null;
        this.retryDelay = 2000;
        this.error = null;
        this.loggedFailure = false;
        this.startPing(ws);
        this.setState('connected');
        this.log.info(`Mit OBS verbunden (${this.conn?.host}:${this.conn?.port})`);
        // Versionsnummer nur zur Anzeige
        this.request('GetVersion')
          .then((v) => {
            this.obsVersion = v.obsVersion ?? null;
            this.wsVersion = v.obsWebSocketVersion ?? this.wsVersion;
            this.emitState();
          })
          .catch(() => undefined);
        break;
      }
      case OP.Event: {
        for (const handler of this.eventHandlers) {
          try {
            handler(String(d.eventType), d.eventData ?? {});
          } catch (err) {
            this.log.warn('Fehler beim Verarbeiten eines OBS-Events:', err);
          }
        }
        break;
      }
      case OP.RequestResponse: {
        const pending = this.pending.get(d.requestId);
        if (!pending) return;
        this.pending.delete(d.requestId);
        clearTimeout(pending.timer);
        const status = d.requestStatus ?? {};
        if (status.result) pending.resolve(d.responseData ?? {});
        else pending.reject(new Error(explainRequestError(d.requestType, status.code, status.comment)));
        break;
      }
    }
  }

  /** Verbindung ist weg: Fehler merken und (außer bei fatalen Fehlern) später neu versuchen */
  private fail(message: string, fatal: boolean): void {
    this.error = message;
    const ws = this.ws;
    this.ws = null;
    this.clearTimers();
    if (ws) {
      ws.removeAllListeners();
      ws.on('error', () => undefined);
      ws.terminate();
    }
    this.rejectAll('Verbindung zu OBS wurde getrennt.');
    if (fatal) {
      this.stopped = true;
      this.log.warn(message);
      this.setState('disconnected');
      return;
    }
    if (!this.loggedFailure) {
      this.log.warn(`${message} Neuer Versuch läuft automatisch.`);
      this.loggedFailure = true;
    }
    if (this.stopped) {
      this.setState('disconnected');
      return;
    }
    this.setState('connecting');
    this.reconnectTimer = setTimeout(() => this.connect(), this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_DELAY);
  }

  /** Regelmäßig anpingen, damit eine tote Verbindung (z.B. zweiter PC aus) auffällt */
  private startPing(ws: WebSocket): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.alive = true;
    this.pingTimer = setInterval(() => {
      if (!this.alive) {
        this.error = 'OBS antwortet nicht mehr.';
        ws.terminate();
        return;
      }
      this.alive = false;
      try {
        ws.ping();
      } catch {
        // Verbindung ist eh gerade weg
      }
    }, PING_INTERVAL);
  }

  private send(ws: WebSocket, op: number, d: Data): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ op, d }));
  }

  private rejectAll(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.identifyTimer) clearTimeout(this.identifyTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.reconnectTimer = this.identifyTimer = this.pingTimer = null;
  }

  private setState(state: ObsState): void {
    const changed = state !== this.state;
    this.state = state;
    if (state !== 'connected') this.obsVersion = null;
    if (changed) this.emitState();
  }

  private emitState(): void {
    const status = this.status();
    for (const handler of this.stateHandlers) {
      try {
        handler(status);
      } catch (err) {
        this.log.warn('Fehler im OBS-Status-Handler:', err);
      }
    }
  }
}

function explainSocketError(err: NodeJS.ErrnoException, host: string, port: number): string {
  switch (err.code) {
    case 'ECONNREFUSED':
      return `OBS ist unter ${host}:${port} nicht erreichbar. Läuft OBS und ist der WebSocket-Server eingeschaltet?`;
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Den Rechner „${host}“ gibt es nicht. Prüf die Adresse.`;
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `Keine Antwort von ${host}:${port}. Ist der andere PC an und lässt die Windows-Firewall den Port durch?`;
    default:
      return `Verbindung zu OBS fehlgeschlagen: ${err.message}`;
  }
}

/** Häufige Fehlercodes von OBS verständlich machen */
function explainRequestError(requestType: string, code: number, comment?: string): string {
  const detail = comment ? ` (${comment})` : '';
  switch (code) {
    case 600:
      return `Nicht in OBS gefunden${detail}`;
    case 601:
      return `Existiert in OBS schon${detail}`;
    case 602:
    case 603:
    case 604:
    case 605:
      return `OBS kann das mit dieser Quelle nicht machen${detail}`;
    case 207:
      return 'OBS ist gerade nicht bereit (lädt noch?).';
    default:
      return `OBS-Fehler bei ${requestType}: Code ${code}${detail}`;
  }
}
