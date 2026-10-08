/** Schnittstelle des Musik-Addons für andere Addons: ctx.use<MusicService>(MUSIC_SERVICE) */
export const MUSIC_SERVICE = 'music';

export interface MusicService {
  /**
   * Die eingestellte Auto-Start-Quelle (Playlist) abspielen und von 0 auf die
   * eingestellte Lautstärke einblenden. Wirft einen Fehler, wenn das nicht geht.
   */
  startAutoplay(fadeInMs: number): Promise<void>;
}
