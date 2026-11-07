import { safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Addon } from '../../core/addons';
import { ConfigStore } from '../../core/config';
import { HttpError } from '../../core/server';
import { buildReport, enqueue, INTERVAL_MINUTES, linkCode, normalizeUrl, type Report } from './report';

/**
 * Watchtime-Addon: Meldet während des Streams alle 5 Minuten, wer im Chat verbunden ist, an einen Server
 * wie den Discord-Bot Mello. Twitch kennt keine echte Watchtime, das hier ist ein guter Näherungswert.
 * Nur wer dort sein Konto verknüpft hat, bekommt etwas dafür.
 */

interface Settings {
  enabled: boolean;
  serverUrl: string;
}

const DEFAULTS: Settings = { enabled: false, serverUrl: '' };
const ROUTE = '/api/suite/watchtime';

export const watchtimeAddon: Addon = {
  id: 'watchtime',
  name: 'Watchtime',
  icon: '⏱️',
  version: '0.1.0',
  author: 'Mini',
  description: 'Meldet während des Streams, wer im Chat verbunden ist, und verknüpft Twitch-Konten mit !verknuepfen. Für XP im Discord-Bot.',
  settingsPage: 'index.html',

  activate(ctx) {
    const settings = ctx.settings<Settings>(DEFAULTS);

    // Token verschlüsselt unter secrets/, wie beim UwUClip-Addon
    const secrets = new ConfigStore<{ token: string | null }>('secrets/watchtime', { token: null });
    const readToken = (): string => {
      const stored = secrets.get('token');
      if (!stored) return '';
      try {
        return stored.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')) : stored;
      } catch {
        return '';
      }
    };
    let token = readToken();
    const writeToken = (value: string) => {
      token = value;
      secrets.set('token', safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(value).toString('base64')}` : value);
    };

    let queue: Report[] = [];
    let links: Report['links'] = [];
    let live = false;
    let lastOk: number | null = null;
    let lastError: string | null = null;

    const ready = () => settings.get('enabled') && !!settings.get('serverUrl') && !!token;

    const post = async (report: Report) => {
      const res = await fetch(settings.get('serverUrl') + ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(report),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Server antwortet ${res.status}`);
      const body = (await res.json().catch(() => ({}))) as { linked?: unknown };
      for (const login of Array.isArray(body.linked) ? body.linked : []) {
        if (typeof login !== 'string' || !/^\w{1,25}$/.test(login)) continue;
        ctx.chat.send(`@${login} ✅ Dein Twitch ist jetzt mit Discord verknüpft.`, { overlay: false }).catch((err) => ctx.log.warn('Bestätigung nicht gesendet:', err));
      }
    };

    const flush = async () => {
      while (queue[0] && ready()) {
        try {
          await post(queue[0]);
          queue = queue.slice(1);
          lastOk = Date.now();
          lastError = null;
        } catch (err) {
          lastError = (err as Error).message;
          ctx.log.warn(`Watchtime nicht zugestellt: ${lastError}`);
          return;
        }
      }
    };

    /** Alle Seiten der Helix-Antwort. Liest nur Logins, keine Inhalte. */
    const chatters = async (): Promise<string[]> => {
      const me = ctx.getUser();
      if (!me) return [];
      const logins: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await ctx.twitch.request<{ data: { user_login: string }[]; pagination?: { cursor?: string } }>('GET', '/chat/chatters', {
          query: { broadcaster_id: me.id, moderator_id: me.id, first: '1000', ...(cursor ? { after: cursor } : {}) },
        });
        logins.push(...page.data.map((c) => c.user_login));
        cursor = page.pagination?.cursor;
      } while (cursor);
      return logins;
    };

    const tick = async () => {
      if (!ready() || !live) return;
      try {
        queue = enqueue(queue, buildReport(randomUUID(), await chatters(), links));
        links = [];
      } catch (err) {
        lastError = (err as Error).message;
        ctx.log.warn(`Chatliste nicht lesbar: ${lastError}`);
      }
      await flush();
    };

    ctx.events.on('streamonline', () => {
      live = true;
    });
    ctx.events.on('streamoffline', () => {
      live = false;
    });
    ctx.events.on('chat', (event) => {
      const code = linkCode(event.message);
      if (!code || !ready()) return;
      links.push({ login: event.user.login, code });
      // Der Code läuft ab, deshalb sofort melden und nicht erst beim nächsten Takt
      queue = enqueue(queue, buildReport(randomUUID(), [], links));
      links = [];
      void flush();
    });

    // Lief der Stream schon, als die Suite gestartet ist?
    const checkLive = async () => {
      const me = ctx.getUser();
      if (!me) return;
      const r = await ctx.twitch.request<{ data: unknown[] }>('GET', '/streams', { query: { user_id: me.id } });
      live = r.data.length > 0;
    };
    void checkLive().catch((err) => ctx.log.warn(`Live-Status: ${(err as Error).message}`));

    const timer = setInterval(() => void tick(), INTERVAL_MINUTES * 60_000);
    ctx.onDispose(() => clearInterval(timer));

    // ------------------------------------------------------------ API für die Einstellungsseite

    const state = () => ({
      settings: { ...settings.all(), hasToken: !!token },
      status: { live, queued: queue.length, lastOk, lastError },
    });

    ctx.api.get('/state', state);

    ctx.api.post('/settings', ({ body }) => {
      const patch: Partial<Settings> = {};
      if (typeof body?.enabled === 'boolean') patch.enabled = body.enabled;
      if (typeof body?.serverUrl === 'string') {
        try {
          patch.serverUrl = body.serverUrl.trim() ? normalizeUrl(body.serverUrl.slice(0, 500)) : '';
        } catch (err) {
          throw new HttpError(400, (err as Error).message);
        }
      }
      settings.update(patch);
      if (typeof body?.token === 'string' && body.token.trim()) writeToken(body.token.trim().slice(0, 500));
      void flush();
      return state();
    });

    /** Schickt einen leeren Bericht mit den gespeicherten Werten. */
    ctx.api.post('/test', async () => {
      if (!settings.get('serverUrl') || !token) throw new HttpError(400, 'Adresse und Token fehlen');
      try {
        await post(buildReport(randomUUID(), [], []));
        lastOk = Date.now();
        lastError = null;
      } catch (err) {
        lastError = (err as Error).message;
        throw new HttpError(502, lastError);
      }
      return state();
    });
  },
};
