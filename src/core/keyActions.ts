import { keyboard, type KeyStep } from './keyboard';
import { satellite } from './satellite';

/** Wo Tasten gedrückt werden: auf diesem PC oder auf dem Satellite (z.B. Gaming-PC) */
export type KeyTarget = 'local' | 'satellite';

export const parseTarget = (value: unknown): KeyTarget => (value === 'satellite' ? 'satellite' : 'local');

/** Tastenfolge auf dem gewünschten PC ausführen */
export function runKeys(target: KeyTarget, steps: KeyStep[], label: string): Promise<void> {
  return target === 'satellite' ? satellite.run(steps, label) : keyboard.run(steps, label);
}

/** Fehlertext, wenn das Ziel gerade nicht erreichbar ist (sonst null) */
export function targetProblem(target: KeyTarget): string | null {
  if (target === 'satellite' && !satellite.connected) return 'Kein Satellite verbunden. Starte die Satellite-Datei auf dem anderen PC.';
  return null;
}
