import type { ChatService } from './chat';
import type { ConfigStore } from './config';
import type { CoreConfig } from './coreConfig';
import type { Logger } from './log';
import { HttpError, type LocalServer } from './server';
import type { TwitchApi } from './twitch/api';
import type { TwitchAuth } from './twitch/auth';
import { closeTwitchLoginWindow, openTwitchLoginWindow } from './twitchWindow';

/**
 * Eigener Bot-Account für Chat-Nachrichten (Commands, Timer, Umfragen, Lurk …).
 *
 * Der Bot meldet sich wie dein Hauptaccount per Code an, aber in einem eigenen Fenster mit
 * frischem Speicher. So bleibst du im Browser mit deinem Hauptaccount eingeloggt.
 * Der Bot sollte Mod in deinem Kanal sein: dann darf er schneller schreiben und Links posten.
 */

interface Deps {
  server: LocalServer;
  config: ConfigStore<CoreConfig>;
  /** Dein Hauptaccount */
  auth: TwitchAuth;
  api: TwitchApi;
  botAuth: TwitchAuth;
  chat: ChatService;
  log: Logger;
}

export function registerBot({ server, config, auth, api, botAuth, chat, log }: Deps): void {
  /** null = unbekannt (z.B. Hauptaccount nicht eingeloggt) */
  let isMod: boolean | null = null;

  const checkMod = async (): Promise<boolean | null> => {
    const me = auth.user;
    const bot = botAuth.user;
    if (!me || !bot) {
      isMod = null;
    } else {
      try {
        const res = await api.request<{ data: unknown[] }>('GET', '/moderation/moderators', { query: { broadcaster_id: me.id, user_id: bot.id } });
        isMod = res.data.length > 0;
      } catch (err) {
        log.warn('Konnte nicht prüfen, ob der Bot Mod ist:', err);
        isMod = null;
      }
    }
    chat.botIsMod = isMod === true;
    return isMod;
  };

  botAuth.on('login', (bot) => {
    closeTwitchLoginWindow();
    // Häufiger Fehler: im Login-Fenster war noch der Hauptaccount angemeldet
    if (auth.user && bot.id === auth.user.id) {
      botAuth.reject('Das ist dein Hauptaccount. Melde dich im Fenster mit dem Bot-Account an.');
      return;
    }
    log.info(`Bot-Account verknüpft: ${bot.displayName}`);
    void checkMod();
  });
  botAuth.on('logout', () => {
    isMod = null;
    chat.botIsMod = false;
  });
  auth.on('login', () => {
    const bot = botAuth.user;
    if (bot && auth.user && bot.id === auth.user.id) botAuth.reject('Bot und Hauptaccount sind derselbe Account.');
    else void checkMod();
  });

  const status = () => ({
    auth: botAuth.state,
    enabled: config.get('botEnabled'),
    fallback: config.get('botFallback'),
    isMod,
    /** Wer schreibt gerade die Nachrichten der Suite? */
    sender: chat.activeBot ? 'bot' : 'broadcaster',
  });

  const get = (path: string, handler: () => unknown) => server.route('core', 'GET', `/api/core/bot${path}`, handler);
  const post = (path: string, handler: Parameters<LocalServer['route']>[3]) => server.route('core', 'POST', `/api/core/bot${path}`, handler);

  get('', status);

  post('/login/start', async () => {
    if (!auth.user) throw new HttpError(400, 'Verbinde zuerst deinen eigenen Kanal mit Twitch.');
    const state = await botAuth.startLogin();
    if (state.state === 'pending') openTwitchLoginWindow(state.verificationUri);
    return status();
  });

  /** Login-Fenster erneut öffnen (z.B. versehentlich geschlossen) */
  post('/login/window', () => {
    const state = botAuth.state;
    if (state.state !== 'pending') throw new HttpError(400, 'Es läuft gerade kein Bot-Login.');
    openTwitchLoginWindow(state.verificationUri);
    return status();
  });

  post('/login/cancel', () => {
    botAuth.cancelLogin();
    closeTwitchLoginWindow();
    return status();
  });

  post('/logout', () => {
    botAuth.logout();
    return status();
  });

  post('/settings', ({ body }) => {
    if (typeof body?.enabled === 'boolean') config.set('botEnabled', body.enabled);
    if (typeof body?.fallback === 'boolean') config.set('botFallback', body.fallback);
    return status();
  });

  post('/check-mod', async () => {
    await checkMod();
    return status();
  });

  /** Bot per Klick zum Mod in deinem Kanal machen */
  post('/make-mod', async () => {
    const me = auth.user;
    const bot = botAuth.user;
    if (!me || !bot) throw new HttpError(400, 'Hauptaccount und Bot müssen verbunden sein.');
    try {
      await api.request('POST', '/moderation/moderators', { query: { broadcaster_id: me.id, user_id: bot.id } });
    } catch (err) {
      const msg = (err as Error).message;
      // 422 = ist schon Mod (oder VIP – dann muss man VIP erst entfernen)
      if (!msg.includes('422')) throw new HttpError(400, `Twitch: ${msg}`);
    }
    await checkMod();
    return status();
  });

  post('/test', async () => {
    if (!chat.activeBot) throw new HttpError(400, 'Kein Bot aktiv.');
    await chat.send(`🤖 Test: ${chat.activeBot.displayName} ist startklar!`);
    return status();
  });
}
