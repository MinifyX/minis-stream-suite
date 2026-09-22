import { app, shell } from 'electron';
import { isTwitchUrl, openTwitchWindow } from './twitchWindow';
import { satellite } from './satellite';
import type { AddonManager, AddonManifest } from './addons';
import type { EventBus } from './eventBus';
import { getLogs } from './log';
import { HttpError, type ApiHandler, type LocalServer } from './server';
import type { TwitchAuth } from './twitch/auth';
import { EVENT_TYPES, makeTestEvent, type StreamEventType } from './twitch/events';
import type { EventSubClient } from './twitch/eventsub';

interface Deps {
  server: LocalServer;
  auth: TwitchAuth;
  botAuth: TwitchAuth;
  eventsub: EventSubClient;
  addons: AddonManager;
  upcomingAddons: AddonManifest[];
  bus: EventBus;
}

/** API-Routen der Oberfläche (Login, Status, Addon-Verwaltung, Test-Events). */
export function registerCoreRoutes({ server, auth, botAuth, eventsub, addons, upcomingAddons, bus }: Deps): void {
  const get = (path: string, handler: ApiHandler) => server.route('core', 'GET', `/api/core${path}`, handler);
  const post = (path: string, handler: ApiHandler) => server.route('core', 'POST', `/api/core${path}`, handler);

  get('/status', () => ({
    version: app.getVersion(),
    clientId: auth.clientId,
    auth: auth.state,
    bot: botAuth.user,
    eventsub: eventsub.status,
    baseUrl: server.url,
  }));

  post('/client-id', ({ body }) => {
    const clientId = String(body?.clientId ?? '').trim();
    if (!/^[a-z0-9]{20,40}$/i.test(clientId)) {
      throw new HttpError(400, 'Das sieht nicht wie eine gültige Client-ID aus.');
    }
    // Tokens gehören zur Client-ID → auch der Bot muss sich neu anmelden
    botAuth.logout();
    auth.setClientId(clientId);
    return auth.state;
  });

  post('/login/start', async () => {
    const state = await auth.startLogin();
    if (state.state === 'pending' && state.verificationUri.startsWith('https://')) {
      void shell.openExternal(state.verificationUri);
    }
    return state;
  });

  post('/login/cancel', () => {
    auth.cancelLogin();
    return auth.state;
  });

  post('/logout', () => {
    auth.logout();
    return auth.state;
  });

  /** Twitch-Seite (z.B. Dashboard) in einem Fenster der Suite öffnen */
  post('/twitch-window', ({ body }) => {
    const url = String(body?.url ?? '');
    if (!isTwitchUrl(url)) throw new HttpError(400, 'Nur Twitch-Seiten können hier geöffnet werden.');
    openTwitchWindow(url);
  });

  // ------------------------------------------------------------ Satellite (zweiter PC)

  get('/satellite', () => satellite.status());

  post('/satellite/enabled', async ({ body }) => {
    await satellite.setEnabled(body?.enabled === true);
    return satellite.status();
  });

  post('/satellite/regenerate', () => {
    satellite.regenerateToken();
    return satellite.status();
  });

  /** Satellite-Datei mit eingebauter Adresse + Schlüssel */
  post('/satellite/script', ({ body }) => {
    try {
      return { filename: 'Stream-Suite-Satellite.cmd', content: satellite.script(String(body?.address ?? '')) };
    } catch (err) {
      throw new HttpError(400, (err as Error).message);
    }
  });

  get('/logs', () => getLogs());

  get('/addons', () => ({ installed: addons.list(), upcoming: upcomingAddons }));

  post('/addons/toggle', async ({ body }) => {
    await addons.setEnabled(String(body?.id), Boolean(body?.enabled));
    return addons.list();
  });

  post('/test-event', ({ body }) => {
    const type = body?.type as StreamEventType;
    if (!EVENT_TYPES.includes(type)) throw new HttpError(400, 'Unbekannter Event-Typ');
    bus.emit(makeTestEvent(type, body?.reward));
  });
}
