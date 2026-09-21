export interface CoreConfig {
  /** Client-ID der eigenen Twitch-App (dev.twitch.tv/console). */
  clientId: string;
  /** Verschlüsselte Twitch-Tokens (Windows DPAPI über Electron safeStorage). */
  tokens: string | null;
  /** IDs der aktivierten Addons. */
  enabledAddons: string[];
}

export const defaultCoreConfig: CoreConfig = {
  clientId: '',
  tokens: null,
  enabledAddons: ['alerts'],
};
