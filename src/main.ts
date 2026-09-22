import { app, dialog, Menu } from 'electron';
import path from 'node:path';
import { builtInAddons, upcomingAddons } from './addons';
import { AddonManager } from './core/addons';
import { ChatService } from './core/chat';
import { ConfigStore } from './core/config';
import { defaultCoreConfig, type CoreConfig } from './core/coreConfig';
import { registerCoreRoutes } from './core/coreRoutes';
import { EventBus } from './core/eventBus';
import { keyboard } from './core/keyboard';
import { satellite } from './core/satellite';
import { createLogger } from './core/log';
import { LocalServer } from './core/server';
import { TwitchApi } from './core/twitch/api';
import { BOT_SCOPES, TwitchAuth } from './core/twitch/auth';
import { registerBot } from './core/bot';
import { startDesktop } from './core/desktop';
import { startUpdater } from './core/updater';
import { EventSubClient } from './core/twitch/eventsub';

/** Port des lokalen Servers (Overlays in OBS: http://127.0.0.1:7474/…) */
const PORT = Number(process.env.SUITE_PORT) || 7474;

async function bootstrap(): Promise<void> {
  // Kein Standardmenü: sonst lösen Tasten wie Strg+R beim Keybind-Aufnehmen Menü-Aktionen aus
  Menu.setApplicationMenu(null);
  const config = new ConfigStore<CoreConfig>('config', defaultCoreConfig);
  const bus = new EventBus();
  const auth = new TwitchAuth(config, createLogger('Twitch'));
  const api = new TwitchApi(auth);
  const eventsub = new EventSubClient(auth, api, bus, createLogger('EventSub'));
  const server = new LocalServer(path.join(app.getAppPath(), 'public'), PORT, createLogger('Server'));
  // Optionaler Bot-Account: eigener Login, eigene Tokens, schreibt die Chat-Nachrichten der Suite
  const botAuth = new TwitchAuth(config, createLogger('Bot'), { tokenKey: 'botTokens', scopes: BOT_SCOPES });
  const botApi = new TwitchApi(botAuth);
  const chat = new ChatService(auth, api, botAuth, botApi, config);
  const addons = new AddonManager(builtInAddons, { bus, api, auth, server, config, chat });

  registerCoreRoutes({ server, auth, botAuth, eventsub, addons, upcomingAddons, bus });
  registerBot({ server, config, auth, api, botAuth, chat, log: createLogger('Bot') });

  auth.on('login', () => eventsub.start());
  auth.on('logout', () => eventsub.stop());
  app.on('before-quit', () => {
    eventsub.stop();
    keyboard.stop();
    satellite.stop();
    void addons.stopAll();
  });

  try {
    await server.start();
  } catch (err) {
    const inUse = (err as NodeJS.ErrnoException).code === 'EADDRINUSE';
    throw new Error(inUse ? `Port ${PORT} ist schon belegt – läuft die Suite vielleicht schon?` : String(err));
  }

  await satellite.init(config);
  await addons.startEnabled();
  await auth.init();
  await botAuth.init();
  startDesktop({ config, server });
  startUpdater(server);
}

// Für Entwickler: zweite Instanz mit eigenem Datenordner/Port starten, ohne die echte Suite anzufassen
// (z.B. SUITE_DATA_DIR=C:\temp\suite-test SUITE_PORT=7480 npm start)
if (process.env.SUITE_DATA_DIR) app.setPath('userData', process.env.SUITE_DATA_DIR);

// Nur eine Instanz erlauben (sonst wäre der Port doppelt belegt). Ein zweiter Start zeigt das vorhandene Fenster.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app
    .whenReady()
    .then(bootstrap)
    .catch((err) => {
      dialog.showErrorBox("Mini's Stream Suite konnte nicht starten", (err as Error).message);
      app.quit();
    });
}
