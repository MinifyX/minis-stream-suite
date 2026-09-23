export interface CoreConfig {
  /** Client-ID der eigenen Twitch-App (dev.twitch.tv/console). */
  clientId: string;
  /** Verschlüsselte Twitch-Tokens (Windows DPAPI über Electron safeStorage). */
  tokens: string | null;
  /** Verschlüsselte Tokens des Bot-Accounts (null = kein Bot verknüpft) */
  botTokens: string | null;
  /** Nachrichten der Suite über den Bot schicken (sonst dein eigener Account) */
  botEnabled: boolean;
  /** Kann der Bot gerade nicht senden, stattdessen deinen Account nehmen */
  botFallback: boolean;
  /** IDs der aktivierten Addons. */
  enabledAddons: string[];
  /** Eingebaute Addons, die die Suite schon kennt. Neue Addons werden beim ersten Start einmal automatisch eingeschaltet. */
  knownAddons: string[];
  /** Satellite (zweiter PC, z.B. Gaming-PC) darf sich über das Heimnetz verbinden */
  satelliteEnabled: boolean;
  /** Geheimer Schlüssel, den der Satellite mitschicken muss */
  satelliteToken: string;
  satellitePort: number;
  /** Fenster schließen = in den Infobereich (Tray) statt beenden */
  closeToTray: boolean;
}

export const defaultCoreConfig: CoreConfig = {
  clientId: '',
  tokens: null,
  botTokens: null,
  botEnabled: true,
  botFallback: true,
  enabledAddons: [
    'alerts', 'channelpoints', 'queue', 'commands', 'timers', 'chat', 'polls', 'lurk',
    'predictions', 'goals', 'shoutout', 'ads', 'modguard', 'streaminfo',
  ],
  // Die Addons bis v0.4.1: wer sie ausgeschaltet hat, bei dem bleiben sie aus
  knownAddons: ['alerts', 'channelpoints', 'commands', 'timers', 'chat', 'polls', 'lurk'],
  satelliteEnabled: false,
  satelliteToken: '',
  satellitePort: 7475,
  closeToTray: true,
};
