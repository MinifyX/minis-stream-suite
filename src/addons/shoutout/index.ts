import { randomUUID } from 'node:crypto';
import type { Addon, AddonContext } from '../../core/addons';
import { duration, parseRole, ROLE_LEVEL, roleLevel, type Role } from '../../core/chat';
import { HttpError } from '../../core/server';
import type { EventOfType, TwitchUserRef } from '../../core/twitch/events';

/**
 * Shoutout-Addon: „!so @name“ im Chat (oder von Hand in der Oberfläche) schreibt eine
 * Shoutout-Nachricht mit dem letzten Spiel des Kanals und gibt zusätzlich den echten
 * Twitch-Shoutout. Twitch erlaubt den nur alle 2 Minuten (und denselben Kanal nur einmal
 * pro Stunde) – blockierte Shoutouts landen in einer Warteschlange und gehen raus, sobald es geht.
 * Optional: automatischer Shoutout bei Raids und ein Clip des Kanals im OBS-Overlay.
 */

// ------------------------------------------------------------------ Datenmodell

/** Woher der Shoutout kam */
type Source = 'command' | 'raid' | 'manual' | 'twitch';
/** Was mit dem echten Twitch-Shoutout passiert ist */
type ApiStatus = 'sent' | 'queued' | 'failed' | 'off' | 'skipped';
type ClipMode = 'top' | 'random';

/** Alles, was wir über den Kanal wissen, der den Shoutout bekommt */
interface Target {
  id: string;
  login: string;
  name: string;
  avatar: string;
  /** '' = normaler Kanal, 'affiliate', 'partner' */
  broadcasterType: string;
  /** Zuletzt gespielt (Kategorie) und Stream-Titel */
  game: string;
  title: string;
}

interface ClipInfo {
  id: string;
  title: string;
  /** Länge in Sekunden */
  duration: number;
  views: number;
  thumbnail: string;
  url: string;
  createdAt: string;
  creator: string;
}

interface HistoryEntry {
  id: string;
  at: number;
  target: TwitchUserRef;
  game: string;
  source: Source;
  /** Wer ihn ausgelöst hat (Mod-Name, „Dashboard“ …), bei Raids leer */
  by: string;
  /** Chat-Nachricht geschickt? */
  chat: boolean;
  api: ApiStatus;
  /** Erklärung zum Twitch-Shoutout (z.B. „wartet noch ca. 2 Min.“) */
  apiNote: string;
  /** Titel des Clips im Overlay (oder null) */
  clip: string | null;
  viewers?: number;
}

/** Ein Twitch-Shoutout, der wegen Twitchs Sperre noch warten muss */
interface Pending {
  id: string;
  target: TwitchUserRef;
  source: Source;
  by: string;
  addedAt: number;
  /** Frühestens dann wieder versuchen */
  notBefore: number;
  /** Zugehöriger Eintrag im Verlauf (wird aktualisiert, sobald er rausgeht) */
  historyId: string;
}

/** Was das Overlay anzeigen soll */
interface OverlayShow {
  id: string;
  name: string;
  login: string;
  avatar: string;
  game: string;
  clip: ClipInfo | null;
  /** So lange bleibt es sichtbar (Sekunden) */
  seconds: number;
}

interface Settings {
  enabled: boolean;
  /** Command-Namen ohne "!", z.B. ["so", "shoutout"] */
  commands: string[];
  /** Wer den Command benutzen darf */
  permission: Role;
  /** Chat-Nachricht (leer = keine) */
  message: string;
  /** Zusätzlich den echten Twitch-Shoutout geben */
  apiShoutout: boolean;
  /** Denselben Kanal per Command erst nach so vielen Sekunden wieder (Spam-Schutz) */
  sameTargetSeconds: number;
  raid: {
    enabled: boolean;
    minViewers: number;
    delaySeconds: number;
    /** Eigene Nachricht bei Raids (leer = normale Nachricht) */
    message: string;
  };
  clip: {
    onCommand: boolean;
    onRaid: boolean;
    /** top = meistgesehener Clip, random = zufällig aus den Top X */
    mode: ClipMode;
    /** Nur Clips der letzten N Tage (0 = alle) */
    days: number;
    topCount: number;
    /** Keine Clips in den letzten N Tagen → meistgesehene aller Zeiten */
    allTimeFallback: boolean;
    /** Clips werden nach so vielen Sekunden ausgeblendet */
    maxSeconds: number;
    /** Kein Clip gefunden → nur die Karte so lange zeigen (0 = gar nichts zeigen) */
    cardSeconds: number;
    accent: string;
    showClipTitle: boolean;
  };
  history: HistoryEntry[];
}

const DEFAULTS: Settings = {
  enabled: true,
  commands: ['so', 'shoutout'],
  permission: 'moderator',
  message: 'Schaut unbedingt bei {user} vorbei! 💜 Zuletzt gespielt: {game} → twitch.tv/{login}',
  apiShoutout: true,
  sameTargetSeconds: 60,
  raid: {
    enabled: false,
    minViewers: 1,
    delaySeconds: 5,
    message: 'Danke für den Raid mit {viewers} Leuten, {user}! 💜 Schaut bei {user} vorbei, zuletzt lief {game} → twitch.tv/{login}',
  },
  clip: {
    onCommand: false,
    onRaid: true,
    mode: 'top',
    days: 30,
    topCount: 5,
    allTimeFallback: true,
    maxSeconds: 30,
    cardSeconds: 8,
    accent: '#9147ff',
    showClipTitle: true,
  },
  history: [],
};

/** Twitch-Sperren für den echten Shoutout */
const GLOBAL_COOLDOWN_MS = 2 * 60_000 + 3000;
const TARGET_COOLDOWN_MS = 60 * 60_000 + 5000;
/** Kennen wir die Sperre nicht genau (z.B. nach Neustart), so lange warten und neu versuchen */
const UNKNOWN_GLOBAL_WAIT_MS = 30_000;
const UNKNOWN_TARGET_WAIT_MS = 5 * 60_000;
const MAX_QUEUE = 20;
const MAX_HISTORY = 50;
const MAX_SHOWS = 10;
/** Zeit, bis der Twitch-Player geladen hat (kommt zur Clip-Länge dazu) */
const CLIP_LOAD_SECONDS = 2;
const CACHE_MS = 5 * 60_000;

const CMD_RE = /^[\p{L}\p{N}_-]{1,30}$/u;
const LOGIN_RE = /^[a-z0-9_]{1,25}$/;
const COLOR_RE = /^#[0-9a-f]{6}$/i;

// ------------------------------------------------------------------ Helfer

const int = (v: unknown, min: number, max: number) => Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
const oneLine = (v: unknown, max: number) => String(v ?? '').replace(/\s*\r?\n\s*/g, ' ').trim().slice(0, max);
const cmdName = (v: unknown) => String(v ?? '').trim().replace(/^!+/, '').toLowerCase();

/** "@Name", "twitch.tv/name" oder "https://www.twitch.tv/name" → "name" */
function cleanLogin(v: unknown): string {
  return String(v ?? '')
    .trim()
    .replace(/^(https?:\/\/)?(www\.|m\.)?twitch\.tv\//i, '')
    .replace(/^@+/, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
}

const waitText = (ms: number) => (ms < 60_000 ? `${Math.max(1, Math.ceil(ms / 1000))} Sek.` : `ca. ${duration(ms + 30_000)}`);

const ROLE_NAMES: Record<Role, string> = { everyone: 'alle', subscriber: 'Subs, VIPs, Mods und dich', vip: 'VIPs, Mods und dich', moderator: 'Mods und dich', broadcaster: 'dich' };

const SOURCE_LABEL: Record<Source, string> = { command: 'Command', raid: 'Raid', manual: 'Dashboard', twitch: 'direkt bei Twitch' };

type ApiErrorKind = 'cooldown' | 'cooldown-target' | 'not-live' | 'self' | 'not-allowed' | 'auth' | 'other';

/** Fehler der Twitch-API auf Deutsch erklären */
function explainApiError(err: unknown): { kind: ApiErrorKind; text: string } {
  const msg = err instanceof Error ? err.message : String(err);
  const m = /Twitch API (\d{3}): ([\s\S]*)/.exec(msg);
  const status = m ? Number(m[1]) : 0;
  const detail = m ? m[2] : msg;
  if (status === 429) {
    return /same/i.test(detail)
      ? { kind: 'cooldown-target', text: 'Twitch-Sperre: denselben Kanal nur einmal pro Stunde' }
      : { kind: 'cooldown', text: 'Twitch-Sperre: nur ein Shoutout alle 2 Minuten' };
  }
  if (status === 400 && /themsel|yourself|self/i.test(detail)) return { kind: 'self', text: 'Du kannst dir nicht selbst einen Shoutout geben' };
  if (status === 400 && /live|stream|viewer/i.test(detail)) {
    return { kind: 'not-live', text: 'Du bist gerade nicht live (oder hast keine Zuschauer) – Twitch-Shoutouts gehen nur während des Streams' };
  }
  if (status === 401) return { kind: 'auth', text: 'Der Suite fehlt das Recht für Shoutouts. Bitte in der Übersicht neu mit Twitch verbinden' };
  if (status === 403) {
    return { kind: 'not-allowed', text: 'Twitch erlaubt den Shoutout nicht. Shoutouts gibt es nur für Affiliates und Partner (oder der Kanal hat dich blockiert)' };
  }
  return { kind: 'other', text: `Twitch: ${detail}` };
}

type HelixClip = {
  id: string;
  url: string;
  title: string;
  view_count: number;
  created_at: string;
  thumbnail_url: string;
  duration: number;
  creator_name: string;
};

// ------------------------------------------------------------------ Addon

export const shoutoutAddon: Addon = {
  id: 'shoutout',
  name: 'Shoutouts',
  icon: '📣',
  version: '0.1.0',
  author: 'Mini',
  description: '!so @name mit Chat-Nachricht und echtem Twitch-Shoutout (mit Warteschlange bei Twitchs Sperre). Automatisch bei Raids, optional mit Clip im OBS-Overlay.',
  settingsPage: 'index.html',

  activate(ctx: AddonContext) {
    const settings = ctx.settings<Settings>(DEFAULTS);

    /** Twitch-Sperren: wann geht der nächste Shoutout (insgesamt / an diesen Kanal)? */
    let globalReadyAt = 0;
    const targetReadyAt = new Map<string, number>();
    /** Zuletzt von der Suite gesendet (um EventSub-Events als „unsere“ zu erkennen) */
    const sentByUs = new Map<string, number>();
    /** Spam-Schutz für den Command: Login → Zeitpunkt */
    const recentTargets = new Map<string, number>();
    const queue: Pending[] = [];
    let queueBusy = false;

    const lookupCache = new Map<string, { at: number; target: Target | null }>();
    let broadcasterType: { userId: string; type: string } | null = null;

    // Overlay
    const shows: OverlayShow[] = [];
    let showing: (OverlayShow & { until: number }) | null = null;
    let showTimer: NodeJS.Timeout | null = null;
    const raidTimers = new Set<NodeJS.Timeout>();

    const queueTimer = setInterval(() => void processQueue(), 3000);
    ctx.onDispose(() => {
      clearInterval(queueTimer);
      if (showTimer) clearTimeout(showTimer);
      raidTimers.forEach((t) => clearTimeout(t));
    });

    const say = (text: string) => {
      if (!text) return;
      ctx.chat.send(text).catch((err) => ctx.log.warn('Chat-Nachricht fehlgeschlagen:', err));
    };

    const requireUser = () => {
      const me = ctx.getUser();
      if (!me) throw new HttpError(401, 'Nicht bei Twitch eingeloggt. Bitte in der Übersicht mit Twitch verbinden.');
      return me;
    };

    // -------------------------------------------------------- Kanal-Infos von Twitch

    /** Kanal per Login oder ID nachschlagen (null = gibt es nicht). Wird 5 Minuten gemerkt. */
    const lookup = async (who: { id?: string; login?: string }): Promise<Target | null> => {
      const key = who.id ? `id:${who.id}` : `login:${who.login}`;
      const cached = lookupCache.get(key);
      if (cached && Date.now() - cached.at < CACHE_MS) return cached.target;

      const users = await ctx.twitch.request<{ data: { id: string; login: string; display_name: string; profile_image_url: string; broadcaster_type: string }[] }>(
        'GET', '/users', { query: who.id ? { id: who.id } : { login: who.login ?? '' } });
      const u = users.data[0];
      let target: Target | null = null;
      if (u) {
        const channels = await ctx.twitch.request<{ data: { game_name: string; title: string }[] }>('GET', '/channels', { query: { broadcaster_id: u.id } });
        const c = channels.data[0];
        target = {
          id: u.id,
          login: u.login,
          name: u.display_name || u.login,
          avatar: u.profile_image_url ?? '',
          broadcasterType: u.broadcaster_type ?? '',
          game: c?.game_name ?? '',
          title: c?.title ?? '',
        };
        lookupCache.set(`id:${u.id}`, { at: Date.now(), target });
        lookupCache.set(`login:${u.login}`, { at: Date.now(), target });
      } else {
        lookupCache.set(key, { at: Date.now(), target: null });
      }
      if (lookupCache.size > 200) lookupCache.delete(lookupCache.keys().next().value!);
      return target;
    };

    /** Nachschlagen für die Oberfläche: Fehler als verständliche HttpError */
    const lookupOrThrow = async (name: unknown): Promise<Target> => {
      requireUser();
      const login = cleanLogin(name);
      if (!LOGIN_RE.test(login)) throw new HttpError(400, 'Bitte einen gültigen Twitch-Namen eingeben.');
      let target: Target | null;
      try {
        target = await lookup({ login });
      } catch (err) {
        throw new HttpError(502, `Twitch nicht erreichbar: ${(err as Error).message}`);
      }
      if (!target) throw new HttpError(404, `Den Kanal „${login}“ gibt es nicht.`);
      return target;
    };

    /** Ist der eigene Kanal Affiliate/Partner? ('' = nein, null = unbekannt) */
    const ownBroadcasterType = async (): Promise<string | null> => {
      const me = ctx.getUser();
      if (!me) return null;
      if (broadcasterType?.userId === me.id) return broadcasterType.type;
      try {
        const res = await ctx.twitch.request<{ data: { broadcaster_type: string }[] }>('GET', '/users', { query: { id: me.id } });
        broadcasterType = { userId: me.id, type: res.data[0]?.broadcaster_type ?? '' };
        return broadcasterType.type;
      } catch {
        return null;
      }
    };

    // -------------------------------------------------------- Clips

    const fetchClips = async (broadcasterId: string, days: number, first: number): Promise<HelixClip[]> => {
      const query: Record<string, string> = { broadcaster_id: broadcasterId, first: String(first) };
      if (days > 0) {
        query.started_at = new Date(Date.now() - days * 86_400_000).toISOString();
        query.ended_at = new Date().toISOString();
      }
      const res = await ctx.twitch.request<{ data: HelixClip[] }>('GET', '/clips', { query });
      return res.data.filter((c) => c.duration > 0).sort((a, b) => b.view_count - a.view_count);
    };

    /** Clip nach den Einstellungen aussuchen (meistgesehen oder zufällig aus den Top X) */
    const findClip = async (broadcasterId: string): Promise<ClipInfo | null> => {
      const c = settings.get('clip');
      const first = c.mode === 'random' ? c.topCount : 1;
      let list = c.days > 0 ? await fetchClips(broadcasterId, c.days, first) : [];
      if (!list.length && (c.days === 0 || c.allTimeFallback)) list = await fetchClips(broadcasterId, 0, first);
      if (!list.length) return null;
      const clip = c.mode === 'random' ? list[Math.floor(Math.random() * list.length)] : list[0];
      return {
        id: clip.id,
        title: clip.title,
        duration: clip.duration,
        views: clip.view_count,
        thumbnail: clip.thumbnail_url,
        url: clip.url,
        createdAt: clip.created_at,
        creator: clip.creator_name,
      };
    };

    // -------------------------------------------------------- Overlay

    const overlayStyle = () => {
      const c = settings.get('clip');
      return { accent: c.accent, showClipTitle: c.showClipTitle };
    };

    const showNext = () => {
      if (showing) return;
      const next = shows.shift();
      if (!next) return;
      showing = { ...next, until: Date.now() + next.seconds * 1000 };
      ctx.overlay.broadcast({ kind: 'show', show: showing, style: overlayStyle(), now: Date.now() });
      showTimer = setTimeout(() => {
        showing = null;
        ctx.overlay.broadcast({ kind: 'hide' });
        // kurze Pause zwischen zwei Shoutouts
        showTimer = setTimeout(showNext, 1500);
      }, next.seconds * 1000);
    };

    /** Was im Overlay laufen würde (Clip oder nur die Karte) – null = nichts anzeigen */
    const prepareShow = async (target: Target): Promise<OverlayShow | null> => {
      let clip: ClipInfo | null = null;
      try {
        clip = await findClip(target.id);
      } catch (err) {
        ctx.log.warn(`Clips von ${target.name} konnten nicht geladen werden:`, err);
      }
      const c = settings.get('clip');
      if (!clip && !c.cardSeconds) return null;
      return {
        id: randomUUID(),
        name: target.name,
        login: target.login,
        avatar: target.avatar,
        game: target.game,
        clip,
        seconds: clip ? Math.min(clip.duration, c.maxSeconds) + CLIP_LOAD_SECONDS : c.cardSeconds,
      };
    };

    const enqueueShow = (show: OverlayShow) => {
      if (shows.length >= MAX_SHOWS) {
        ctx.log.warn('Zu viele Clips auf einmal – einer wird übersprungen');
        return;
      }
      shows.push(show);
      showNext();
    };

    const stopOverlay = () => {
      shows.length = 0;
      if (showTimer) clearTimeout(showTimer);
      showTimer = null;
      showing = null;
      ctx.overlay.broadcast({ kind: 'hide' });
    };

    // -------------------------------------------------------- Verlauf

    const addHistory = (entry: HistoryEntry) => {
      settings.set('history', [entry, ...settings.get('history')].slice(0, MAX_HISTORY));
    };

    const updateHistory = (id: string, patch: Partial<HistoryEntry>) => {
      settings.set('history', settings.get('history').map((e) => (e.id === id ? { ...e, ...patch } : e)));
    };

    // -------------------------------------------------------- Echter Twitch-Shoutout + Warteschlange

    /** Ab wann geht ein Shoutout an diesen Kanal wieder – und warum wartet er? */
    const readyAt = (targetId: string): { at: number; reason: string } => {
      const target = targetReadyAt.get(targetId) ?? 0;
      if (target > globalReadyAt) return { at: target, reason: 'derselbe Kanal geht nur einmal pro Stunde' };
      return { at: globalReadyAt, reason: 'nur ein Twitch-Shoutout alle 2 Minuten' };
    };

    const markSent = (targetId: string, at = Date.now()) => {
      globalReadyAt = Math.max(globalReadyAt, at + GLOBAL_COOLDOWN_MS);
      targetReadyAt.set(targetId, Math.max(targetReadyAt.get(targetId) ?? 0, at + TARGET_COOLDOWN_MS));
    };

    type Attempt = { ok: true } | { ok: false; kind: ApiErrorKind; text: string; retryAt?: number };

    /** Den echten Shoutout versuchen. Bei Twitchs Sperre kommt retryAt zurück. */
    const attemptApi = async (target: TwitchUserRef): Promise<Attempt> => {
      const me = ctx.getUser();
      if (!me) return { ok: false, kind: 'auth', text: 'Nicht bei Twitch eingeloggt' };
      if (target.id === me.id) return { ok: false, kind: 'self', text: 'Du kannst dir nicht selbst einen Shoutout geben' };
      if ((await ownBroadcasterType()) === '') {
        return { ok: false, kind: 'not-allowed', text: 'Twitch-Shoutouts gibt es nur für Affiliates und Partner' };
      }
      const now = Date.now();
      const ready = readyAt(target.id);
      if (ready.at > now) return { ok: false, kind: 'cooldown', text: `Twitch-Sperre: ${ready.reason}`, retryAt: ready.at };
      try {
        await ctx.twitch.request('POST', '/chat/shoutouts', {
          query: { from_broadcaster_id: me.id, to_broadcaster_id: target.id, moderator_id: me.id },
        });
        markSent(target.id);
        sentByUs.set(target.id, Date.now());
        return { ok: true };
      } catch (err) {
        const e = explainApiError(err);
        if (e.kind === 'cooldown') {
          // Sperre, die wir nicht kannten (z.B. Shoutout direkt bei Twitch, Suite neu gestartet)
          globalReadyAt = Math.max(globalReadyAt, Date.now() + UNKNOWN_GLOBAL_WAIT_MS);
          return { ...e, ok: false, retryAt: globalReadyAt };
        }
        if (e.kind === 'cooldown-target') {
          const at = Math.max(targetReadyAt.get(target.id) ?? 0, Date.now() + UNKNOWN_TARGET_WAIT_MS);
          targetReadyAt.set(target.id, at);
          return { ...e, ok: false, retryAt: at };
        }
        return { ...e, ok: false };
      }
    };

    const refOf = (t: Target | TwitchUserRef): TwitchUserRef => ({ id: t.id, login: t.login, name: t.name });

    /** Echten Shoutout geben – oder in die Warteschlange, wenn Twitch gerade sperrt */
    const requestApi = async (target: Target, entry: HistoryEntry): Promise<{ status: ApiStatus; note: string }> => {
      const already = queue.find((p) => p.target.id === target.id);
      if (already) return { status: 'skipped', note: 'steht schon in der Warteschlange' };
      const r = await attemptApi(target);
      if (r.ok) return { status: 'sent', note: 'gesendet' };
      if (r.retryAt) {
        if (queue.length >= MAX_QUEUE) return { status: 'failed', note: 'Warteschlange ist voll' };
        queue.push({ id: randomUUID(), target: refOf(target), source: entry.source, by: entry.by, addedAt: Date.now(), notBefore: r.retryAt, historyId: entry.id });
        return { status: 'queued', note: `wartet noch ${waitText(r.retryAt - Date.now())} (${r.text.replace(/^Twitch-Sperre: /, '')})` };
      }
      return { status: 'failed', note: r.text };
    };

    /** Nur vorhersagen (Test-Bereich, Vorschau) – schickt nichts */
    const predictApi = async (target: Target): Promise<{ status: ApiStatus; note: string }> => {
      if (!settings.get('apiShoutout')) return { status: 'off', note: 'Twitch-Shoutout ist ausgeschaltet' };
      const me = ctx.getUser();
      if (!me) return { status: 'failed', note: 'Nicht bei Twitch eingeloggt' };
      if (target.id === me.id) return { status: 'failed', note: 'Du kannst dir nicht selbst einen Shoutout geben' };
      if ((await ownBroadcasterType()) === '') return { status: 'failed', note: 'Twitch-Shoutouts gibt es nur für Affiliates und Partner' };
      if (queue.some((p) => p.target.id === target.id)) return { status: 'skipped', note: 'steht schon in der Warteschlange' };
      const ready = readyAt(target.id);
      const now = Date.now();
      if (ready.at > now) return { status: 'queued', note: `käme in die Warteschlange: noch ${waitText(ready.at - now)} (${ready.reason})` };
      return { status: 'sent', note: 'würde sofort gesendet (klappt nur, während du live bist)' };
    };

    /** Läuft alle paar Sekunden: wartende Shoutouts senden, sobald Twitch es erlaubt */
    const processQueue = async () => {
      if (queueBusy || !queue.length) return;
      const now = Date.now();
      if (now < globalReadyAt) return;
      const item = queue.find((p) => p.notBefore <= now && (targetReadyAt.get(p.target.id) ?? 0) <= now);
      if (!item) return;
      queueBusy = true;
      try {
        const r = await attemptApi(item.target);
        const remove = () => {
          const i = queue.indexOf(item);
          if (i >= 0) queue.splice(i, 1);
        };
        if (r.ok) {
          remove();
          updateHistory(item.historyId, { api: 'sent', apiNote: `nach ${duration(Date.now() - item.addedAt)} Wartezeit gesendet` });
          ctx.log.info(`Twitch-Shoutout an ${item.target.name} aus der Warteschlange gesendet`);
        } else if (r.retryAt) {
          item.notBefore = r.retryAt;
        } else {
          remove();
          updateHistory(item.historyId, { api: 'failed', apiNote: r.text });
          ctx.log.warn(`Twitch-Shoutout an ${item.target.name} (Warteschlange) fehlgeschlagen: ${r.text}`);
        }
      } finally {
        queueBusy = false;
      }
    };

    const removeFromQueue = (predicate: (p: Pending) => boolean, patch: Partial<HistoryEntry>) => {
      for (const p of queue.filter(predicate)) {
        queue.splice(queue.indexOf(p), 1);
        updateHistory(p.historyId, patch);
      }
    };

    // -------------------------------------------------------- Shoutout geben

    interface GiveOptions {
      source: Source;
      by: { id: string; name: string } | null;
      chat: boolean;
      api: boolean;
      clip: boolean;
      viewers?: number;
      /** Nur ausprobieren: nichts senden, nichts speichern */
      dryRun?: boolean;
    }

    const renderMessage = (template: string, target: Target, o: GiveOptions) =>
      ctx.chat.render(template, {
        user: o.by ?? undefined,
        values: {
          user: target.name,
          login: target.login,
          game: target.game || 'keine Kategorie',
          title: target.title,
          link: `https://twitch.tv/${target.login}`,
          by: o.by?.name ?? '',
          viewers: o.viewers !== undefined ? String(o.viewers) : '',
        },
      });

    const give = async (target: Target, o: GiveOptions) => {
      const raidMessage = o.source === 'raid' ? settings.get('raid').message : '';
      const template = raidMessage || settings.get('message');
      const entry: HistoryEntry = {
        id: randomUUID(),
        at: Date.now(),
        target: refOf(target),
        game: target.game,
        source: o.source,
        by: o.by?.name ?? '',
        chat: false,
        api: 'off',
        apiNote: settings.get('apiShoutout') ? 'nicht ausgewählt' : 'Twitch-Shoutout ist ausgeschaltet',
        clip: null,
        ...(o.viewers !== undefined ? { viewers: o.viewers } : {}),
      };
      if (!o.dryRun) addHistory(entry);

      let message = '';
      if (o.chat && template) {
        message = await renderMessage(template, target, o);
        entry.chat = !!message;
        if (!o.dryRun) say(message);
      }

      if (o.api) {
        const r = o.dryRun ? await predictApi(target) : await requestApi(target, entry);
        entry.api = r.status;
        entry.apiNote = r.note;
      }

      let clip: ClipInfo | null = null;
      let clipNote = 'kein Clip im Overlay';
      if (o.clip) {
        const show = await prepareShow(target);
        clip = show?.clip ?? null;
        entry.clip = clip?.title ?? null;
        clipNote = clip ? `Clip im Overlay: „${clip.title}“ (${Math.round(clip.duration)} Sek.)` : show ? 'kein Clip gefunden – Overlay zeigt nur die Karte' : 'kein Clip gefunden';
        if (show && !o.dryRun) enqueueShow(show);
      }

      if (!o.dryRun) {
        updateHistory(entry.id, { chat: entry.chat, api: entry.api, apiNote: entry.apiNote, clip: entry.clip });
        ctx.log.info(`Shoutout an ${target.name} (${SOURCE_LABEL[o.source]}${entry.by && o.source !== 'manual' ? ` von ${entry.by}` : ''}) – Twitch-Shoutout: ${entry.apiNote}`);
      }
      return { entry, message, clip, clipNote, target };
    };

    // -------------------------------------------------------- Chat-Command

    const isSelf = (target: Target) => target.id === ctx.getUser()?.id;

    /**
     * Eine Chat-Nachricht verarbeiten. dryRun = Test in der Oberfläche (nichts senden/speichern).
     * Gibt zurück, was in den Chat käme, plus Hinweise für den Test-Bereich.
     */
    const handleChat = async (user: { id: string; name: string }, level: number, text: string, dryRun: boolean) => {
      const replies: string[] = [];
      const notes: string[] = [];
      const reply = (t: string) => {
        replies.push(t);
        if (!dryRun) say(t);
      };
      const trimmed = text.trim();
      if (!trimmed.startsWith('!')) return { replies, notes: ['Kein Command (fängt nicht mit ! an)'] };
      const [first, ...rest] = trimmed.slice(1).split(/\s+/);
      const cmd = (first ?? '').toLowerCase();
      if (!settings.get('commands').includes(cmd)) return { replies, notes: ['Kein Shoutout-Command'] };
      if (!settings.get('enabled')) return { replies, notes: ['Shoutouts sind ausgeschaltet'] };
      const permission = settings.get('permission');
      if (level < ROLE_LEVEL[permission]) return { replies, notes: [`Keine Berechtigung – der Command ist nur für ${ROLE_NAMES[permission]}`] };

      const login = cleanLogin(rest[0]);
      if (!LOGIN_RE.test(login)) {
        reply(`@${user.name} So geht's: !${cmd} @name`);
        return { replies, notes };
      }
      const last = recentTargets.get(login) ?? 0;
      const spamMs = settings.get('sameTargetSeconds') * 1000;
      if (Date.now() - last < spamMs) {
        notes.push(`Ignoriert: ${login} hat gerade erst einen Shoutout bekommen (Spam-Schutz ${settings.get('sameTargetSeconds')} Sek.)`);
        return { replies, notes };
      }

      let target: Target | null;
      try {
        target = await lookup({ login });
      } catch (err) {
        ctx.log.warn(`Shoutout: ${login} konnte nicht nachgeschlagen werden:`, err);
        return { replies, notes: [`Twitch nicht erreichbar: ${(err as Error).message}`] };
      }
      if (!target) {
        reply(`@${user.name} Den Kanal „${login}“ gibt es nicht.`);
        return { replies, notes };
      }
      if (isSelf(target)) {
        reply(`@${user.name} Sich selbst einen Shoutout geben geht leider nicht 😄`);
        return { replies, notes };
      }
      if (!dryRun) recentTargets.set(login, Date.now());

      const r = await give(target, {
        source: 'command',
        by: user,
        chat: true,
        api: settings.get('apiShoutout'),
        clip: settings.get('clip').onCommand,
        dryRun,
      });
      if (r.message) replies.push(r.message);
      notes.push(`Twitch-Shoutout: ${r.entry.apiNote}`, r.clipNote);
      return { replies, notes };
    };

    ctx.events.on('chat', (event: EventOfType<'chat'>) => {
      if (event.test || ctx.chat.isOwnMessage(event.messageId) || ctx.chat.isBot(event.user.id)) return;
      if (!event.message.trimStart().startsWith('!')) return;
      const level = roleLevel(event.badges, event.user.id === ctx.getUser()?.id);
      handleChat(event.user, level, event.message, false).catch((err) => ctx.log.warn('Shoutout fehlgeschlagen:', err));
    });

    // -------------------------------------------------------- Raids

    const raidShoutout = async (raider: TwitchUserRef, viewers: number, dryRun: boolean) => {
      let target = await lookup({ id: raider.id }).catch(() => null);
      // Twitch nicht erreichbar → wenigstens mit Namen aus dem Raid
      target ??= { id: raider.id, login: raider.login, name: raider.name, avatar: '', broadcasterType: '', game: '', title: '' };
      return give(target, {
        source: 'raid',
        by: null,
        chat: true,
        api: settings.get('apiShoutout'),
        clip: settings.get('clip').onRaid,
        viewers,
        dryRun,
      });
    };

    ctx.events.on('raid', (e: EventOfType<'raid'>) => {
      if (e.test) return;
      const r = settings.get('raid');
      if (!settings.get('enabled') || !r.enabled) return;
      if (e.viewers < r.minViewers) {
        ctx.log.info(`Raid von ${e.user.name} mit ${e.viewers} Leuten – unter dem Minimum (${r.minViewers}), kein Auto-Shoutout`);
        return;
      }
      const timer = setTimeout(() => {
        raidTimers.delete(timer);
        raidShoutout(e.user, e.viewers, false).catch((err) => ctx.log.warn(`Raid-Shoutout an ${e.user.name} fehlgeschlagen:`, err));
      }, r.delaySeconds * 1000);
      raidTimers.add(timer);
    });

    // -------------------------------------------------------- Shoutouts, die direkt bei Twitch gegeben wurden

    ctx.events.on('shoutout', (e: EventOfType<'shoutout'>) => {
      if (e.test) return;
      markSent(e.to.id);
      const ours = Date.now() - (sentByUs.get(e.to.id) ?? 0) < 30_000;
      if (ours) return;
      // Wartet der Kanal bei uns noch? Dann ist das erledigt.
      removeFromQueue((p) => p.target.id === e.to.id, { api: 'sent', apiNote: 'inzwischen direkt bei Twitch gegeben' });
      addHistory({
        id: randomUUID(), at: Date.now(), target: e.to, game: '', source: 'twitch', by: '', chat: false,
        api: 'sent', apiNote: 'direkt bei Twitch gegeben', clip: null,
      });
    });

    ctx.events.on('streamoffline', (e) => {
      if (e.test || !queue.length) return;
      const n = queue.length;
      removeFromQueue(() => true, { api: 'skipped', apiNote: 'Stream beendet, bevor Twitch es erlaubt hat' });
      ctx.log.info(`Stream beendet: ${n} wartende(r) Twitch-Shoutout(s) verworfen`);
    });

    // -------------------------------------------------------- API

    const publicState = async () => {
      const now = Date.now();
      return {
        settings: { ...settings.all(), history: undefined },
        history: settings.get('history'),
        queue: queue.map((p) => ({ ...p, readyAt: Math.max(p.notBefore, readyAt(p.target.id).at) })),
        globalReadyAt,
        overlay: { showing: showing ? { name: showing.name, clip: showing.clip?.title ?? null, until: showing.until } : null, waiting: shows.length },
        loggedIn: !!ctx.getUser(),
        me: ctx.getUser()?.login ?? null,
        broadcasterType: await ownBroadcasterType(),
        now,
      };
    };

    ctx.api.get('/state', publicState);

    ctx.api.get('/overlay-state', () => ({
      kind: 'state',
      show: showing,
      style: overlayStyle(),
      now: Date.now(),
    }));

    /** Vorschau für „Shoutout geben“: Kanal-Infos, Clip, was mit dem Twitch-Shoutout passieren würde */
    ctx.api.get('/lookup', async ({ query }) => {
      const target = await lookupOrThrow(query.get('name'));
      const [clip, live, api] = await Promise.all([
        findClip(target.id).catch(() => null),
        ctx.twitch.request<{ data: { viewer_count: number }[] }>('GET', '/streams', { query: { user_id: target.id } })
          .then((r) => (r.data[0] ? { viewers: r.data[0].viewer_count } : null))
          .catch(() => null),
        predictApi(target),
      ]);
      const last = settings.get('history').find((e) => e.target.id === target.id && e.source !== 'twitch');
      return { target, clip, live, api, self: isSelf(target), lastAt: last?.at ?? null };
    });

    /** Shoutout von Hand geben */
    ctx.api.post('/shoutout', async ({ body }) => {
      const me = requireUser();
      const target = await lookupOrThrow(body?.name);
      if (isSelf(target)) throw new HttpError(400, 'Du kannst dir nicht selbst einen Shoutout geben.');
      const r = await give(target, {
        source: 'manual',
        by: { id: me.id, name: 'Dashboard' },
        chat: body?.chat !== false,
        api: body?.api === undefined ? settings.get('apiShoutout') : body.api === true,
        clip: body?.clip === true,
      });
      return { entry: r.entry, message: r.message, clipNote: r.clipNote, state: await publicState() };
    });

    /** Test-Bereich: Chat-Nachricht oder Raid simulieren – sendet nichts, speichert nichts */
    ctx.api.post('/test', async ({ body }) => {
      requireUser();
      if (body?.kind === 'raid') {
        const target = await lookupOrThrow(body?.name);
        const r = await raidShoutout(refOf(target), int(body?.viewers, 0, 100_000), true);
        const raid = settings.get('raid');
        const notes = [
          !settings.get('enabled') ? 'Achtung: Shoutouts sind ausgeschaltet' : '',
          !raid.enabled ? 'Achtung: Auto-Shoutout bei Raids ist ausgeschaltet' : '',
          raid.enabled && int(body?.viewers, 0, 100_000) < raid.minViewers ? `Achtung: weniger als ${raid.minViewers} Zuschauer → es passiert nichts` : '',
          raid.enabled ? `Kommt ${raid.delaySeconds} Sek. nach dem Raid` : '',
          `Twitch-Shoutout: ${r.entry.apiNote}`,
          r.clipNote,
        ].filter(Boolean);
        return { replies: r.message ? [r.message] : [], notes };
      }
      const name = oneLine(body?.user, 25) || 'TestMod';
      const level = ROLE_LEVEL[parseRole(body?.role, 'moderator')];
      return handleChat({ id: `test:${name.toLowerCase()}`, name }, level, String(body?.message ?? ''), true);
    });

    /** Overlay testen: Clip eines Kanals (Standard: dein eigener) anzeigen, ohne Chat und ohne Twitch-Shoutout */
    ctx.api.post('/overlay/test', async ({ body }) => {
      const me = requireUser();
      const target = await lookupOrThrow(cleanLogin(body?.name) || me.login);
      const show = await prepareShow(target);
      if (!show) throw new HttpError(404, `${target.name} hat keine Clips (und „nur Karte“ ist aus).`);
      enqueueShow(show);
      return { clip: show.clip, seconds: show.seconds, name: target.name };
    });

    ctx.api.post('/overlay/stop', () => {
      stopOverlay();
    });

    ctx.api.post('/queue/remove', ({ body }) => {
      removeFromQueue((p) => p.id === body?.id, { api: 'skipped', apiNote: 'aus der Warteschlange entfernt' });
      return publicState();
    });

    ctx.api.post('/queue/clear', () => {
      removeFromQueue(() => true, { api: 'skipped', apiNote: 'aus der Warteschlange entfernt' });
      return publicState();
    });

    ctx.api.post('/history/clear', () => {
      settings.set('history', []);
      return publicState();
    });

    ctx.api.post('/settings', async ({ body }) => {
      const s = settings.all();
      if (typeof body?.enabled === 'boolean') s.enabled = body.enabled;
      if (body?.commands !== undefined) {
        const raw: unknown[] = Array.isArray(body.commands) ? body.commands : String(body.commands).split(/[\s,]+/);
        const list = raw
          .map(cmdName)
          .filter(Boolean);
        const commands = [...new Set(list)].slice(0, 10);
        if (!commands.length) throw new HttpError(400, 'Mindestens ein Command-Name ist nötig (z.B. so).');
        const bad = commands.find((c) => !CMD_RE.test(c));
        if (bad) throw new HttpError(400, `Ungültiger Command-Name: „${bad}“.`);
        s.commands = commands;
      }
      if (body?.permission !== undefined) s.permission = parseRole(body.permission, 'moderator');
      if (body?.message !== undefined) s.message = oneLine(body.message, 500);
      if (typeof body?.apiShoutout === 'boolean') s.apiShoutout = body.apiShoutout;
      if (body?.sameTargetSeconds !== undefined) s.sameTargetSeconds = int(body.sameTargetSeconds, 0, 3600);
      if (body?.raid) {
        const r = body.raid;
        s.raid = {
          enabled: r.enabled === true,
          minViewers: int(r.minViewers, 0, 100_000),
          delaySeconds: int(r.delaySeconds, 0, 300),
          message: oneLine(r.message, 500),
        };
      }
      if (body?.clip) {
        const c = body.clip;
        s.clip = {
          onCommand: c.onCommand === true,
          onRaid: c.onRaid === true,
          mode: c.mode === 'random' ? 'random' : 'top',
          days: int(c.days, 0, 3650),
          topCount: int(c.topCount, 2, 50),
          allTimeFallback: c.allTimeFallback !== false,
          maxSeconds: int(c.maxSeconds, 5, 60),
          cardSeconds: int(c.cardSeconds, 0, 60),
          accent: COLOR_RE.test(c.accent) ? c.accent : DEFAULTS.clip.accent,
          showClipTitle: c.showClipTitle !== false,
        };
      }
      settings.update({
        enabled: s.enabled,
        commands: s.commands,
        permission: s.permission,
        message: s.message,
        apiShoutout: s.apiShoutout,
        sameTargetSeconds: s.sameTargetSeconds,
        raid: s.raid,
        clip: s.clip,
      });
      return publicState();
    });
  },
};
