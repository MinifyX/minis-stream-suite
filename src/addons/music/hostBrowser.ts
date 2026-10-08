import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Der Music-Host (/addons/music/host.html) muss in einem echten Chrome oder Edge laufen:
 * Das Spotify Web Playback SDK braucht Widevine – das hat weder Electron noch die OBS-Browserquelle.
 *
 * Wir starten den Browser als eigenes App-Fenster mit eigenem Profil:
 *  - eigenes Profil = eigener Prozess → in OBS per „Anwendungsaudioaufnahme“ sauber getrennt
 *    von deinem normalen Browser abgreifbar,
 *  - Autoplay ohne Klick erlaubt (sonst bliebe die Musik nach einem Neustart stumm).
 */

function candidates(): string[] {
  const env = process.env;
  const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean) as string[];
  return [
    ...roots.map((r) => path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...roots.map((r) => path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
  ];
}

/** Chrome bevorzugt, sonst Edge – oder null */
export function findBrowser(): string | null {
  return candidates().find((file) => fs.existsSync(file)) ?? null;
}

/** Host-Fenster öffnen. Gibt den Browsernamen zurück (oder wirft, wenn keiner gefunden wurde). */
export function launchHost(url: string, profileDir: string): string {
  const exe = findBrowser();
  if (!exe) throw new Error('Weder Chrome noch Edge gefunden.');
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(exe, [
    `--app=${url}`,
    `--user-data-dir=${profileDir}`,
    '--autoplay-policy=no-user-gesture-required',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=520,640',
  ], { detached: true, stdio: 'ignore' });
  child.unref();
  return path.basename(exe, '.exe') === 'msedge' ? 'Edge' : 'Chrome';
}
