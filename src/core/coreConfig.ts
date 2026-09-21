export interface CoreConfig {
  /** Client-ID der eigenen Twitch-App (dev.twitch.tv/console). */
  clientId: string;
  /** Verschlüsselte Twitch-Tokens (Windows DPAPI über Electron safeStorage). */
  tokens: string | null;
  /** IDs der aktivierten Addons. */
  enabledAddons: string[];
  /** Satellite (zweiter PC, z.B. Gaming-PC) darf sich über das Heimnetz verbinden */
  satelliteEnabled: boolean;
  /** Geheimer Schlüssel, den der Satellite mitschicken muss */
  satelliteToken: string;
  satellitePort: number;
}

export const defaultCoreConfig: CoreConfig = {
  clientId: '',
  tokens: null,
  enabledAddons: ['alerts', 'channelpoints', 'commands', 'timers'],
  satelliteEnabled: false,
  satelliteToken: '',
  satellitePort: 7475,
};
