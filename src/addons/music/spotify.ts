import { createHash, randomBytes } from 'node:crypto';
import type { Logger } from '../../core/log';

/**
 * Spotify Web API: Login (Authorization Code mit PKCE), Token-Refresh und Anfragen.
 * Nur offizielle Wege – Web API und (im Music-Host) das Web Playback SDK.
 *
 * Stand Februar 2026 (Migration Guide): Development Mode braucht Spotify Premium, max. 5 Nutzer,
 * eine Client-ID pro Entwickler. /me liefert kein `product`/`email` mehr, Playlist-Inhalte heißen
 * `items` statt `tracks`. Die Player-Endpunkte (/me/player/…) sind unverändert.
 * → Wir verlassen uns auf keins der entfernten Felder.
 */

export const SPOTIFY_SCOPES = [
  'streaming', 'user-read-email', 'user-read-private', 'user-read-playback-state',
  'user-modify-playback-state', 'user-read-currently-playing', 'playlist-read-private',
];

const ACCOUNTS = 'https://accounts.spotify.com';
const API = 'https://api.spotify.com/v1';
/** Länger als das warten wir bei 429 nicht – dann lieber Fehler melden */
const MAX_RETRY_AFTER_S = 10;

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  /** Zeitpunkt (ms), ab dem der Access-Token abgelaufen ist */
  expiresAt: number;
  scope: string;
}

/** Wo die Tokens liegen (verschlüsselt, nicht in Sicherungen) */
export interface TokenStore {
  get(): SpotifyTokens | null;
  set(tokens: SpotifyTokens | null): void;
}

export interface SpotifyUser {
  id: string;
  name: string;
}

export class SpotifyError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

// ------------------------------------------------------------------ PKCE & Quellen

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function authorizeUrl(options: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: options.clientId,
    response_type: 'code',
    redirect_uri: options.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: options.challenge,
    state: options.state,
    scope: SPOTIFY_SCOPES.join(' '),
  });
  return `${ACCOUNTS}/authorize?${params}`;
}

/**
 * Spotify-Quelle normalisieren: URI oder Link aus der App.
 * "https://open.spotify.com/intl-de/playlist/abc?si=…" → "spotify:playlist:abc"
 * Gibt null zurück, wenn es keine Spotify-Quelle ist.
 */
export function parseSpotifySource(input: string): string | null {
  const text = input.trim();
  const uri = /^spotify:(playlist|album|artist|track|show|episode):([A-Za-z0-9]+)$/.exec(text);
  if (uri) return `spotify:${uri[1]}:${uri[2]}`;
  const link = /^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album|artist|track|show|episode)\/([A-Za-z0-9]+)/.exec(text);
  if (link) return `spotify:${link[1]}:${link[2]}`;
  return null;
}

/** Body für PUT /me/player/play: Playlists/Alben als context_uri, einzelne Titel als uris */
export function playBody(source: string | null): Record<string, unknown> {
  if (!source) return {};
  if (/^spotify:(track|episode):/.test(source)) return { uris: [source] };
  return { context_uri: source };
}

export interface SpotifyDevice {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  is_restricted: boolean;
  volume_percent: number | null;
}

/**
 * Gerät für die Fernsteuerung der Desktop-App wählen: zuerst nach Name (falls eingestellt),
 * sonst ein „Computer“ – das aktive bevorzugt. Das eigene SDK-Gerät der Suite zählt nicht.
 */
export function pickConnectDevice(devices: SpotifyDevice[], preferredName: string, ownDeviceName: string): SpotifyDevice | null {
  const usable = devices.filter((d) => d.id && !d.is_restricted && d.name !== ownDeviceName);
  const wanted = preferredName.trim().toLowerCase();
  if (wanted) return usable.find((d) => d.name.toLowerCase() === wanted) ?? null;
  const computers = usable.filter((d) => d.type.toLowerCase() === 'computer');
  return computers.find((d) => d.is_active) ?? computers[0] ?? null;
}

// ------------------------------------------------------------------ Client

interface Options {
  clientId: () => string;
  redirectUri: () => string;
  store: TokenStore;
  log: Logger;
  /** Für Tests ersetzbar */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class SpotifyClient {
  private refreshing: Promise<SpotifyTokens> | null = null;
  user: SpotifyUser | null = null;
  private fetchFn: typeof fetch;
  private sleep: (ms: number) => Promise<void>;

  constructor(private options: Options) {
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get loggedIn(): boolean {
    return !!this.options.store.get();
  }

  logout(): void {
    this.options.store.set(null);
    this.user = null;
  }

  private async tokenRequest(params: Record<string, string>): Promise<SpotifyTokens> {
    const res = await this.fetchFn(`${ACCOUNTS}/api/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.options.clientId(), ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, string | number>;
    if (!res.ok) {
      const reason = String(data.error_description || data.error || res.status);
      throw new SpotifyError(res.status, `Spotify-Login fehlgeschlagen: ${reason}`);
    }
    const old = this.options.store.get();
    const tokens: SpotifyTokens = {
      accessToken: String(data.access_token),
      // Beim Refresh schickt Spotify manchmal keinen neuen Refresh-Token → alten behalten
      refreshToken: String(data.refresh_token || old?.refreshToken || ''),
      expiresAt: Date.now() + Number(data.expires_in || 3600) * 1000,
      scope: String(data.scope || old?.scope || ''),
    };
    this.options.store.set(tokens);
    return tokens;
  }

  /** Code aus dem Redirect gegen Tokens tauschen */
  async exchangeCode(code: string, verifier: string): Promise<void> {
    await this.tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: this.options.redirectUri(), code_verifier: verifier });
    await this.loadUser();
  }

  /** Gültiger Access-Token – wird kurz vor Ablauf automatisch erneuert */
  async accessToken(): Promise<string> {
    const tokens = this.options.store.get();
    if (!tokens) throw new SpotifyError(401, 'Nicht mit Spotify verbunden.');
    if (tokens.expiresAt - Date.now() > 60_000) return tokens.accessToken;
    return (await this.refresh()).accessToken;
  }

  /** Mehrere gleichzeitige Aufrufe teilen sich einen Refresh */
  private refresh(): Promise<SpotifyTokens> {
    if (this.refreshing) return this.refreshing;
    const tokens = this.options.store.get();
    if (!tokens?.refreshToken) return Promise.reject(new SpotifyError(401, 'Nicht mit Spotify verbunden.'));
    this.refreshing = this.tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken })
      .catch((err) => {
        // Refresh-Token ungültig (z.B. Zugriff in Spotify entzogen) → neu anmelden
        if (err instanceof SpotifyError && err.status === 400) {
          this.options.log.warn('Spotify-Anmeldung abgelaufen – bitte neu verbinden.');
          this.logout();
        }
        throw err;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  /**
   * Anfrage an die Web API. 401 → einmal Token erneuern; 429 → Retry-After abwarten (max. 10 s), einmal.
   * Gibt null zurück bei 204 (kein Inhalt).
   */
  async request<T>(method: string, path: string, options: { query?: Record<string, string>; body?: unknown } = {}): Promise<T | null> {
    const url = `${API}${path}${options.query ? `?${new URLSearchParams(options.query)}` : ''}`;
    let refreshed = false;
    let waited = false;
    for (;;) {
      const token = await this.accessToken();
      const res = await this.fetchFn(url, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.refresh();
        continue;
      }
      if (res.status === 429 && !waited) {
        const seconds = Number(res.headers.get('retry-after')) || 1;
        if (seconds > MAX_RETRY_AFTER_S) throw new SpotifyError(429, `Spotify bremst gerade (bitte ${seconds} s warten).`);
        waited = true;
        await this.sleep(seconds * 1000);
        continue;
      }
      if (res.status === 204 || res.status === 202) return null;
      const text = await res.text();
      let data: unknown = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = null;
      }
      if (!res.ok) {
        const err = (data as { error?: { message?: string; reason?: string } } | null)?.error;
        throw new SpotifyError(res.status, describeError(res.status, err?.reason, err?.message));
      }
      return data as T;
    }
  }

  async loadUser(): Promise<SpotifyUser | null> {
    const me = await this.request<{ id: string; display_name?: string | null }>('GET', '/me');
    this.user = me ? { id: me.id, name: me.display_name || me.id } : null;
    return this.user;
  }
}

/** Spotify-Fehler auf Deutsch, mit Tipp wo möglich */
export function describeError(status: number, reason?: string, message?: string): string {
  if (reason === 'NO_ACTIVE_DEVICE') return 'Kein aktives Spotify-Gerät. Öffne die Spotify-App (oder den Music-Host) und spiel kurz etwas ab.';
  if (reason === 'PREMIUM_REQUIRED' || status === 403 && /premium/i.test(message ?? '')) return 'Dafür braucht es Spotify Premium.';
  if (status === 403) return `Spotify erlaubt das nicht (${message || 'keine Berechtigung'}). Ist dein Account in der Spotify-App unter „User Management“ eingetragen?`;
  if (status === 404) return `Nicht gefunden (${message || 'Gerät oder Quelle'}).`;
  if (status === 429) return 'Spotify bremst gerade (zu viele Anfragen). Gleich nochmal versuchen.';
  return `Spotify-Fehler ${status}${message ? `: ${message}` : ''}`;
}
