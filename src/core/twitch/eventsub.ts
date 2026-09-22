import WebSocket from 'ws';
import type { EventBus } from '../eventBus';
import type { Logger } from '../log';
import type { TwitchApi } from './api';
import type { TwitchAuth } from './auth';
import { normalizeEvent } from './events';

const EVENTSUB_URL = 'wss://eventsub.wss.twitch.tv/ws';

export type EventSubStatus = 'disconnected' | 'connecting' | 'connected';

/** Welche Twitch-Events die Suite abonniert. */
function subscriptionsFor(userId: string) {
  const broadcaster = { broadcaster_user_id: userId };
  return [
    { type: 'channel.channel_points_custom_reward_redemption.add', version: '1', condition: broadcaster },
    { type: 'channel.follow', version: '2', condition: { ...broadcaster, moderator_user_id: userId } },
    { type: 'channel.subscribe', version: '1', condition: broadcaster },
    { type: 'channel.subscription.gift', version: '1', condition: broadcaster },
    { type: 'channel.subscription.message', version: '1', condition: broadcaster },
    { type: 'channel.cheer', version: '1', condition: broadcaster },
    { type: 'channel.raid', version: '1', condition: { to_broadcaster_user_id: userId } },
    { type: 'channel.chat.message', version: '1', condition: { ...broadcaster, user_id: userId } },
    { type: 'channel.update', version: '2', condition: broadcaster },
    { type: 'stream.online', version: '1', condition: broadcaster },
    { type: 'stream.offline', version: '1', condition: broadcaster },
    { type: 'channel.chat.message_delete', version: '1', condition: { ...broadcaster, user_id: userId } },
    { type: 'channel.chat.clear', version: '1', condition: { ...broadcaster, user_id: userId } },
    { type: 'channel.chat.clear_user_messages', version: '1', condition: { ...broadcaster, user_id: userId } },
    { type: 'channel.poll.begin', version: '1', condition: broadcaster },
    { type: 'channel.poll.progress', version: '1', condition: broadcaster },
    { type: 'channel.poll.end', version: '1', condition: broadcaster },
  ];
}

interface EventSubMessage {
  metadata: { message_id: string; message_type: string };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any;
}

/**
 * Verbindung zu Twitch EventSub per WebSocket.
 * Doku: https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
 */
export class EventSubClient {
  status: EventSubStatus = 'disconnected';

  private ws: WebSocket | null = null;
  private stopped = true;
  private keepaliveSeconds = 30;
  private keepaliveTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private retryDelay = 1000;
  private seenIds = new Set<string>();

  constructor(
    private auth: TwitchAuth,
    private api: TwitchApi,
    private bus: EventBus,
    private log: Logger,
  ) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect(EVENTSUB_URL, false);
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.status = 'disconnected';
  }

  private connect(url: string, isReconnect: boolean): void {
    const ws = new WebSocket(url);
    if (!isReconnect) {
      this.ws = ws;
      this.status = 'connecting';
    }

    ws.on('message', (raw) => {
      let msg: EventSubMessage;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      this.handleMessage(ws, msg, isReconnect).catch((err) => this.log.error('Fehler beim Verarbeiten:', err));
    });

    ws.on('close', (code) => {
      // Alte Verbindungen (nach einem Reconnect) einfach ignorieren
      if (ws !== this.ws) return;
      this.ws = null;
      this.status = 'disconnected';
      this.clearTimers();
      if (this.stopped) return;
      this.log.warn(`Verbindung getrennt (Code ${code}) – neuer Versuch in ${this.retryDelay / 1000}s`);
      this.status = 'connecting';
      this.reconnectTimer = setTimeout(() => {
        if (!this.stopped) this.connect(EVENTSUB_URL, false);
      }, this.retryDelay);
      this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
    });

    ws.on('error', (err) => this.log.warn('WebSocket-Fehler:', err.message));
  }

  private async handleMessage(ws: WebSocket, msg: EventSubMessage, isReconnect: boolean): Promise<void> {
    switch (msg.metadata.message_type) {
      case 'session_welcome': {
        const session = msg.payload.session;
        this.keepaliveSeconds = session.keepalive_timeout_seconds ?? 30;
        if (this.ws !== ws) {
          // Reconnect: neue Verbindung übernimmt, alte wird geschlossen
          const old = this.ws;
          this.ws = ws;
          old?.close();
        }
        this.resetKeepalive(ws);
        this.retryDelay = 1000;
        if (!isReconnect) await this.subscribeAll(session.id);
        this.status = 'connected';
        this.log.info(isReconnect ? 'Verbindung nahtlos gewechselt' : 'Mit Twitch EventSub verbunden');
        break;
      }
      case 'session_keepalive':
        this.resetKeepalive(ws);
        break;
      case 'notification': {
        this.resetKeepalive(ws);
        if (this.isDuplicate(msg.metadata.message_id)) return;
        const event = normalizeEvent(msg.payload.subscription.type, msg.payload.event);
        if (event) this.bus.emit(event);
        break;
      }
      case 'session_reconnect':
        this.log.info('Twitch verlangt einen Serverwechsel…');
        this.connect(msg.payload.session.reconnect_url, true);
        break;
      case 'revocation':
        this.log.warn(`Abo von Twitch beendet: ${msg.payload.subscription.type} (${msg.payload.subscription.status})`);
        break;
    }
  }

  private async subscribeAll(sessionId: string): Promise<void> {
    const user = this.auth.user;
    if (!user) throw new Error('Kein Nutzer eingeloggt');
    const subs = subscriptionsFor(user.id);
    const results = await Promise.allSettled(
      subs.map((sub) =>
        this.api.request('POST', '/eventsub/subscriptions', {
          body: { ...sub, transport: { method: 'websocket', session_id: sessionId } },
        }),
      ),
    );
    results.forEach((result, i) => {
      if (result.status === 'rejected') this.log.warn(`Abo „${subs[i].type}“ fehlgeschlagen:`, result.reason);
    });
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    this.log.info(`${ok}/${subs.length} Event-Arten abonniert`);
  }

  private resetKeepalive(ws: WebSocket): void {
    if (ws !== this.ws) return;
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    this.keepaliveTimer = setTimeout(() => {
      this.log.warn('Keine Antwort von Twitch – verbinde neu');
      ws.terminate();
    }, (this.keepaliveSeconds + 10) * 1000);
  }

  private isDuplicate(id: string): boolean {
    if (this.seenIds.has(id)) return true;
    this.seenIds.add(id);
    if (this.seenIds.size > 500) this.seenIds.delete(this.seenIds.values().next().value!);
    return false;
  }

  private clearTimers(): void {
    if (this.keepaliveTimer) clearTimeout(this.keepaliveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.keepaliveTimer = null;
    this.reconnectTimer = null;
  }
}
