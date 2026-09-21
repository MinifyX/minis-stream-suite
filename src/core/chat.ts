import { createLogger } from './log';
import type { TwitchApi } from './twitch/api';
import type { TwitchAuth } from './twitch/auth';

/**
 * Chat-Nachrichten senden (für alle Addons gemeinsam) und Variablen in Texten einsetzen.
 *
 * Alle Nachrichten laufen durch EINE Warteschlange mit Mindestabstand, damit Commands,
 * Timer & Co. zusammen nie Twitchs Limit reißen.
 */

const log = createLogger('Chat');
const MIN_GAP_MS = 1100;
const MAX_QUEUE = 15;

export class ChatService {
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private lastSend = 0;
  /** IDs unserer eigenen Nachrichten – die kommen als Chat-Event zurück und dürfen nichts auslösen */
  private sentIds = new Set<string>();

  constructor(
    private auth: TwitchAuth,
    private api: TwitchApi,
  ) {}

  /** Nachricht mit dem eingeloggten Account in den eigenen Chat schicken */
  send(message: string, replyTo?: string): Promise<void> {
    const text = message.replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, 500);
    if (!text) return Promise.resolve();
    if (this.queued >= MAX_QUEUE) {
      log.warn('Zu viele Nachrichten auf einmal – eine wird übersprungen');
      return Promise.resolve();
    }
    this.queued++;
    const job = this.queue
      .then(async () => {
        const user = this.auth.user;
        if (!user) throw new Error('Nicht bei Twitch eingeloggt');
        const wait = this.lastSend + MIN_GAP_MS - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastSend = Date.now();
        const res = await this.api.request<{ data: { message_id: string; is_sent: boolean; drop_reason?: { message: string } | null }[] }>(
          'POST',
          '/chat/messages',
          { body: { broadcaster_id: user.id, sender_id: user.id, message: text, ...(replyTo ? { reply_parent_message_id: replyTo } : {}) } },
        );
        const result = res.data[0];
        if (result?.message_id) {
          this.sentIds.add(result.message_id);
          if (this.sentIds.size > 300) this.sentIds.delete(this.sentIds.values().next().value!);
        }
        if (result && !result.is_sent) throw new Error(`Twitch hat die Nachricht nicht gesendet: ${result.drop_reason?.message ?? 'unbekannt'}`);
      })
      .finally(() => {
        this.queued--;
      });
    this.queue = job.catch(() => {});
    return job;
  }

  /** Stammt diese Chat-Nachricht von der Suite selbst? */
  isOwnMessage(messageId: string): boolean {
    return this.sentIds.has(messageId);
  }
}

// ------------------------------------------------------------------ Variablen

export interface TemplateContext {
  /** Wer die Nachricht ausgelöst hat (für {user}, {touser}, {followage}) */
  user?: { id: string; name: string };
  /** Wörter nach dem Command ({args}, {arg1} …) */
  args?: string[];
  /** Zusätzliche feste Werte, z.B. { count: '5', commands: '!a !b' } */
  values?: Record<string, string>;
}

function duration(ms: number): string {
  const min = Math.floor(ms / 60_000);
  const days = Math.floor(min / 1440);
  const hours = Math.floor((min % 1440) / 60);
  const mins = min % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days} ${days === 1 ? 'Tag' : 'Tage'}`);
  if (hours) parts.push(`${hours} Std.`);
  if (mins || !parts.length) parts.push(`${mins} Min.`);
  return parts.join(' ');
}

function since(date: Date): string {
  const now = new Date();
  let months = (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());
  if (now.getDate() < date.getDate()) months--;
  const years = Math.floor(months / 12);
  months %= 12;
  if (!years && !months) {
    const days = Math.floor((now.getTime() - date.getTime()) / 86_400_000);
    return `${days} ${days === 1 ? 'Tag' : 'Tagen'}`;
  }
  const parts: string[] = [];
  if (years) parts.push(`${years} ${years === 1 ? 'Jahr' : 'Jahren'}`);
  if (months) parts.push(`${months} ${months === 1 ? 'Monat' : 'Monaten'}`);
  return parts.join(' und ');
}

const VAR_RE = /\{(\w+)(?::([^}]*))?\}/g;

/**
 * Setzt {Variablen} in einen Text ein. Daten von Twitch (Spiel, Uptime, Follow) werden nur
 * geholt, wenn der Text sie auch braucht.
 */
export async function renderTemplate(template: string, api: TwitchApi, auth: TwitchAuth, context: TemplateContext = {}): Promise<string> {
  const broadcaster = auth.user;
  const needed = new Set([...template.matchAll(VAR_RE)].map((m) => m[1].toLowerCase()));
  const args = context.args ?? [];
  const chatter = context.user ?? (broadcaster ? { id: broadcaster.id, name: broadcaster.displayName } : { id: '0', name: '' });

  const channelInfo = async () => {
    if (!broadcaster) return null;
    const res = await api.request<{ data: { game_name: string; title: string }[] }>('GET', '/channels', { query: { broadcaster_id: broadcaster.id } });
    return res.data[0] ?? null;
  };
  const uptime = async () => {
    if (!broadcaster) return 'unbekannt';
    const res = await api.request<{ data: { started_at: string }[] }>('GET', '/streams', { query: { user_id: broadcaster.id } });
    const started = res.data[0]?.started_at;
    return started ? duration(Date.now() - new Date(started).getTime()) : 'gerade offline';
  };
  const followage = async () => {
    if (!broadcaster) return 'unbekannt';
    if (chatter.id === broadcaster.id) return 'schon immer (das ist der Kanal selbst)';
    const res = await api.request<{ data: { followed_at: string }[] }>('GET', '/channels/followers', {
      query: { broadcaster_id: broadcaster.id, user_id: chatter.id },
    });
    const followed = res.data[0]?.followed_at;
    return followed ? since(new Date(followed)) : 'gar nicht';
  };

  const [info, up, follow] = await Promise.all([
    needed.has('game') || needed.has('title') ? channelInfo().catch(() => null) : null,
    needed.has('uptime') ? uptime().catch(() => 'unbekannt') : null,
    needed.has('followage') ? followage().catch(() => 'unbekannt') : null,
  ]);
  const touser = (args[0] ?? '').replace(/^@/, '') || chatter.name;

  return template.replace(VAR_RE, (match, rawKey: string, param?: string) => {
    const key = rawKey.toLowerCase();
    if (context.values && key in context.values) return context.values[key];
    const argMatch = /^arg([1-9])$/.exec(key);
    if (argMatch) return args[Number(argMatch[1]) - 1] ?? '';
    switch (key) {
      case 'user': return chatter.name;
      case 'touser': return touser;
      case 'args': return args.join(' ');
      case 'channel': return broadcaster?.displayName ?? '';
      case 'game': return info?.game_name || 'keine Kategorie';
      case 'title': return info?.title ?? '';
      case 'uptime': return up ?? '';
      case 'followage': return follow ?? '';
      case 'random': {
        const [min, max] = (param ?? '1-100').split('-').map((n) => Math.round(Number(n)));
        if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return match;
        return String(min + Math.floor(Math.random() * (max - min + 1)));
      }
      case 'pick': {
        const options = (param ?? '').split('|').map((s) => s.trim()).filter(Boolean);
        return options.length ? options[Math.floor(Math.random() * options.length)] : match;
      }
      default: return match;
    }
  }).slice(0, 500);
}
