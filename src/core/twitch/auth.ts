import { EventEmitter } from 'node:events';
import { safeStorage } from 'electron';
import type { ConfigStore } from '../config';
import type { CoreConfig } from '../coreConfig';
import type { Logger } from '../log';

/**
 * Rechte, die die Suite bei Twitch anfragt.
 * Kommt hier etwas dazu, muss man sich einmal neu einloggen (passiert automatisch).
 */
export const SCOPES = [
  'channel:read:redemptions',
  'channel:manage:redemptions',
  'moderator:read:followers',
  'channel:read:subscriptions',
  'bits:read',
  'user:read:chat',
  'user:write:chat',
];

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface TwitchUser {
  id: string;
  login: string;
  displayName: string;
  avatar: string | null;
}

export type LoginState =
  | { state: 'no-client-id' }
  | { state: 'logged-out' }
  | { state: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { state: 'logged-in'; user: TwitchUser }
  | { state: 'error'; message: string };

/** Fehler, bei dem der Login selbst ungültig ist (nicht nur z.B. kein Internet). */
class AuthError extends Error {}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function postForm(url: string, params: Record<string, string>) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toTokens(data: any): Tokens {
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

/**
 * Twitch-Login per "Device Code Flow": Die App zeigt einen Code, der Browser
 * öffnet twitch.tv/activate, man bestätigt – fertig. Dafür braucht es weder
 * ein Client-Secret noch einen eigenen Server.
 *
 * Events: 'state' (LoginState), 'login' (TwitchUser), 'logout'
 */
export class TwitchAuth extends EventEmitter {
  state: LoginState = { state: 'logged-out' };
  user: TwitchUser | null = null;

  private tokens: Tokens | null = null;
  private refreshing: Promise<void> | null = null;
  private loginRun = 0;
  private validateTimer: NodeJS.Timeout | null = null;

  constructor(
    private config: ConfigStore<CoreConfig>,
    private log: Logger,
  ) {
    super();
  }

  get clientId(): string {
    return this.config.get('clientId');
  }

  setClientId(clientId: string): void {
    this.logout();
    this.config.set('clientId', clientId);
    this.setState(clientId ? { state: 'logged-out' } : { state: 'no-client-id' });
  }

  /** Beim Start: gespeicherten Login laden und prüfen. */
  async init(): Promise<void> {
    if (!this.clientId) return this.setState({ state: 'no-client-id' });
    this.tokens = this.loadTokens();
    if (!this.tokens) return this.setState({ state: 'logged-out' });
    try {
      await this.completeLogin();
    } catch (err) {
      this.log.warn('Gespeicherter Login ist nicht mehr gültig:', err);
      this.clearSession();
      this.setState({ state: 'logged-out' });
    }
  }

  async startLogin(): Promise<LoginState> {
    if (!this.clientId) throw new Error('Bitte zuerst eine Twitch Client-ID eintragen.');
    const { ok, data } = await postForm('https://id.twitch.tv/oauth2/device', {
      client_id: this.clientId,
      scopes: SCOPES.join(' '),
    });
    if (!ok) {
      throw new Error(
        `Twitch hat den Login abgelehnt (${data.message ?? 'unbekannter Fehler'}). ` +
          'Ist die Client-ID richtig und die App als „Öffentlich“ angelegt?',
      );
    }
    const expiresAt = Date.now() + data.expires_in * 1000;
    const run = ++this.loginRun;
    this.setState({ state: 'pending', userCode: data.user_code, verificationUri: data.verification_uri, expiresAt });
    void this.pollForToken(run, data.device_code, data.interval ?? 5, expiresAt);
    return this.state;
  }

  cancelLogin(): void {
    this.loginRun++;
    if (this.state.state === 'pending') this.setState({ state: 'logged-out' });
  }

  logout(): void {
    this.loginRun++;
    const token = this.tokens?.accessToken;
    if (token && this.clientId) {
      postForm('https://id.twitch.tv/oauth2/revoke', { client_id: this.clientId, token }).catch(() => {});
    }
    const wasLoggedIn = !!this.user;
    this.clearSession();
    this.setState(this.clientId ? { state: 'logged-out' } : { state: 'no-client-id' });
    if (wasLoggedIn) {
      this.log.info('Abgemeldet');
      this.emit('logout');
    }
  }

  /** Gültiges Access-Token holen (wird bei Bedarf automatisch erneuert). */
  async getAccessToken(): Promise<string> {
    if (!this.tokens) throw new AuthError('Nicht bei Twitch eingeloggt.');
    if (Date.now() > this.tokens.expiresAt - 60_000) await this.refresh();
    return this.tokens!.accessToken;
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh()
      .catch((err) => {
        if (err instanceof AuthError && this.user) {
          this.log.warn(err.message);
          this.logout();
          this.setState({ state: 'error', message: 'Der Twitch-Login ist abgelaufen – bitte neu verbinden.' });
        }
        throw err;
      })
      .finally(() => {
        this.refreshing = null;
      });
    return this.refreshing;
  }

  private async doRefresh(): Promise<void> {
    if (!this.tokens) throw new AuthError('Nicht eingeloggt.');
    const { ok, data } = await postForm(TOKEN_URL, {
      client_id: this.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.tokens.refreshToken,
    });
    if (!ok) throw new AuthError(`Token konnte nicht erneuert werden: ${data.message ?? 'unbekannt'}`);
    this.tokens = toTokens(data);
    this.saveTokens();
  }

  private async pollForToken(run: number, deviceCode: string, interval: number, expiresAt: number): Promise<void> {
    while (run === this.loginRun && Date.now() < expiresAt) {
      await sleep(interval * 1000);
      if (run !== this.loginRun) return;

      let result;
      try {
        result = await postForm(TOKEN_URL, {
          client_id: this.clientId,
          scopes: SCOPES.join(' '),
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
      } catch (err) {
        this.log.warn('Netzwerkfehler beim Login, versuche erneut…', err);
        continue;
      }

      if (result.ok) {
        this.tokens = toTokens(result.data);
        this.saveTokens();
        try {
          await this.completeLogin();
        } catch (err) {
          this.clearSession();
          this.setState({ state: 'error', message: (err as Error).message });
        }
        return;
      }

      const message = result.data.message;
      if (message === 'authorization_pending') continue;
      if (message === 'slow_down') {
        interval += 5;
        continue;
      }
      this.setState({
        state: 'error',
        message: message === 'access_denied' ? 'Login wurde abgebrochen.' : `Login fehlgeschlagen: ${message ?? 'unbekannter Fehler'}`,
      });
      return;
    }
    if (run === this.loginRun && this.state.state === 'pending') {
      this.setState({ state: 'error', message: 'Der Code ist abgelaufen – bitte erneut versuchen.' });
    }
  }

  /** Token prüfen, Nutzerdaten laden und den Login melden. */
  private async completeLogin(): Promise<void> {
    const info = await this.validate();
    const missing = SCOPES.filter((scope) => !info.scopes.includes(scope));
    if (missing.length) throw new Error(`Es fehlen Rechte (${missing.join(', ')}) – bitte neu verbinden.`);

    const token = await this.getAccessToken();
    const res = await fetch(`https://api.twitch.tv/helix/users?id=${info.user_id}`, {
      headers: { 'Client-Id': this.clientId, Authorization: `Bearer ${token}` },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = res.ok ? await res.json() : null;
    const profile = data?.data?.[0];

    this.user = {
      id: info.user_id,
      login: info.login,
      displayName: profile?.display_name ?? info.login,
      avatar: profile?.profile_image_url ?? null,
    };
    this.setState({ state: 'logged-in', user: this.user });
    this.log.info(`Eingeloggt als ${this.user.displayName}`);
    this.startValidateTimer();
    this.emit('login', this.user);
  }

  private async validate(retried = false): Promise<{ user_id: string; login: string; scopes: string[] }> {
    const token = await this.getAccessToken();
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: `OAuth ${token}` } });
    if (res.status === 401 && !retried) {
      await this.refresh();
      return this.validate(true);
    }
    if (!res.ok) throw new AuthError(`Token ungültig (${res.status})`);
    return (await res.json()) as { user_id: string; login: string; scopes: string[] };
  }

  /** Twitch verlangt, dass Apps ihr Token regelmäßig (stündlich) prüfen. */
  private startValidateTimer(): void {
    this.stopValidateTimer();
    this.validateTimer = setInterval(() => {
      this.validate().catch((err) => {
        if (err instanceof AuthError) return; // refresh() hat sich schon um den Logout gekümmert
        this.log.warn('Token-Prüfung fehlgeschlagen (Internet?):', err);
      });
    }, 60 * 60 * 1000);
  }

  private stopValidateTimer(): void {
    if (this.validateTimer) clearInterval(this.validateTimer);
    this.validateTimer = null;
  }

  private clearSession(): void {
    this.tokens = null;
    this.user = null;
    this.config.set('tokens', null);
    this.stopValidateTimer();
  }

  private saveTokens(): void {
    const json = JSON.stringify(this.tokens);
    const stored = safeStorage.isEncryptionAvailable()
      ? `enc:${safeStorage.encryptString(json).toString('base64')}`
      : `raw:${json}`;
    this.config.set('tokens', stored);
  }

  private loadTokens(): Tokens | null {
    const stored = this.config.get('tokens');
    if (!stored) return null;
    try {
      if (stored.startsWith('enc:')) return JSON.parse(safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64')));
      if (stored.startsWith('raw:')) return JSON.parse(stored.slice(4));
    } catch (err) {
      this.log.warn('Gespeicherte Tokens konnten nicht gelesen werden:', err);
    }
    return null;
  }

  private setState(state: LoginState): void {
    this.state = state;
    this.emit('state', state);
  }
}
