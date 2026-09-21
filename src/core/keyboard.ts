import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createLogger } from './log';

/**
 * Simuliert Tastendrücke unter Windows (SendInput).
 *
 * Tasten werden als Scancodes geschickt, also als "physische" Taste. Das klappt auch in
 * Spielen, und die Taste ist unabhängig vom Tastaturlayout dieselbe, die man beim
 * Aufnehmen gedrückt hat. Nur Medientasten laufen über virtuelle Tastencodes.
 *
 * Ein kleiner PowerShell-Helfer läuft dauerhaft im Hintergrund, damit Tastendrücke
 * ohne Verzögerung ankommen. Keine Zusatzprogramme nötig.
 */

type KeyDef = { scan: number; ext?: boolean } | { vk: number };

/** KeyboardEvent.code → Scancode (Set 1) bzw. virtueller Tastencode */
export const KEYS: Record<string, KeyDef> = {
  Escape: { scan: 0x01 },
  Digit1: { scan: 0x02 }, Digit2: { scan: 0x03 }, Digit3: { scan: 0x04 }, Digit4: { scan: 0x05 }, Digit5: { scan: 0x06 },
  Digit6: { scan: 0x07 }, Digit7: { scan: 0x08 }, Digit8: { scan: 0x09 }, Digit9: { scan: 0x0a }, Digit0: { scan: 0x0b },
  Minus: { scan: 0x0c }, Equal: { scan: 0x0d }, Backspace: { scan: 0x0e }, Tab: { scan: 0x0f },
  KeyQ: { scan: 0x10 }, KeyW: { scan: 0x11 }, KeyE: { scan: 0x12 }, KeyR: { scan: 0x13 }, KeyT: { scan: 0x14 },
  KeyY: { scan: 0x15 }, KeyU: { scan: 0x16 }, KeyI: { scan: 0x17 }, KeyO: { scan: 0x18 }, KeyP: { scan: 0x19 },
  BracketLeft: { scan: 0x1a }, BracketRight: { scan: 0x1b }, Enter: { scan: 0x1c }, ControlLeft: { scan: 0x1d },
  KeyA: { scan: 0x1e }, KeyS: { scan: 0x1f }, KeyD: { scan: 0x20 }, KeyF: { scan: 0x21 }, KeyG: { scan: 0x22 },
  KeyH: { scan: 0x23 }, KeyJ: { scan: 0x24 }, KeyK: { scan: 0x25 }, KeyL: { scan: 0x26 },
  Semicolon: { scan: 0x27 }, Quote: { scan: 0x28 }, Backquote: { scan: 0x29 }, ShiftLeft: { scan: 0x2a }, Backslash: { scan: 0x2b },
  KeyZ: { scan: 0x2c }, KeyX: { scan: 0x2d }, KeyC: { scan: 0x2e }, KeyV: { scan: 0x2f }, KeyB: { scan: 0x30 },
  KeyN: { scan: 0x31 }, KeyM: { scan: 0x32 }, Comma: { scan: 0x33 }, Period: { scan: 0x34 }, Slash: { scan: 0x35 },
  ShiftRight: { scan: 0x36 }, NumpadMultiply: { scan: 0x37 }, AltLeft: { scan: 0x38 }, Space: { scan: 0x39 }, CapsLock: { scan: 0x3a },
  F1: { scan: 0x3b }, F2: { scan: 0x3c }, F3: { scan: 0x3d }, F4: { scan: 0x3e }, F5: { scan: 0x3f }, F6: { scan: 0x40 },
  F7: { scan: 0x41 }, F8: { scan: 0x42 }, F9: { scan: 0x43 }, F10: { scan: 0x44 }, F11: { scan: 0x57 }, F12: { scan: 0x58 },
  F13: { scan: 0x64 }, F14: { scan: 0x65 }, F15: { scan: 0x66 }, F16: { scan: 0x67 }, F17: { scan: 0x68 }, F18: { scan: 0x69 },
  F19: { scan: 0x6a }, F20: { scan: 0x6b }, F21: { scan: 0x6c }, F22: { scan: 0x6d }, F23: { scan: 0x6e }, F24: { scan: 0x76 },
  ScrollLock: { scan: 0x46 }, IntlBackslash: { scan: 0x56 },
  Numpad7: { scan: 0x47 }, Numpad8: { scan: 0x48 }, Numpad9: { scan: 0x49 }, NumpadSubtract: { scan: 0x4a },
  Numpad4: { scan: 0x4b }, Numpad5: { scan: 0x4c }, Numpad6: { scan: 0x4d }, NumpadAdd: { scan: 0x4e },
  Numpad1: { scan: 0x4f }, Numpad2: { scan: 0x50 }, Numpad3: { scan: 0x51 }, Numpad0: { scan: 0x52 }, NumpadDecimal: { scan: 0x53 },
  NumpadEnter: { scan: 0x1c, ext: true }, ControlRight: { scan: 0x1d, ext: true }, NumpadDivide: { scan: 0x35, ext: true },
  PrintScreen: { scan: 0x37, ext: true }, AltRight: { scan: 0x38, ext: true },
  Home: { scan: 0x47, ext: true }, ArrowUp: { scan: 0x48, ext: true }, PageUp: { scan: 0x49, ext: true },
  ArrowLeft: { scan: 0x4b, ext: true }, ArrowRight: { scan: 0x4d, ext: true }, End: { scan: 0x4f, ext: true },
  ArrowDown: { scan: 0x50, ext: true }, PageDown: { scan: 0x51, ext: true }, Insert: { scan: 0x52, ext: true },
  Delete: { scan: 0x53, ext: true }, MetaLeft: { scan: 0x5b, ext: true }, MetaRight: { scan: 0x5c, ext: true },
  ContextMenu: { scan: 0x5d, ext: true },
  MediaPlayPause: { vk: 0xb3 }, MediaTrackNext: { vk: 0xb0 }, MediaTrackPrevious: { vk: 0xb1 }, MediaStop: { vk: 0xb2 },
  AudioVolumeMute: { vk: 0xad }, AudioVolumeDown: { vk: 0xae }, AudioVolumeUp: { vk: 0xaf },
};

const MODIFIERS = new Set(['ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight']);

export interface KeyStep {
  /** Tasten der Kombination (KeyboardEvent.code), z.B. ["ControlLeft", "F13"] */
  keys: string[];
  /** Wie lange die Kombination gehalten wird (ms) */
  holdMs: number;
  /** Pause vor diesem Schritt (ms) */
  delayMs: number;
}

export const MAX_STEPS = 20;
const MAX_TIME = 60_000;

/** Prüft und bereinigt eine Tastenfolge. Wirft einen Fehler mit verständlicher Meldung. */
export function validateSteps(input: unknown): KeyStep[] {
  if (!Array.isArray(input) || !input.length) throw new Error('Mindestens ein Schritt ist nötig.');
  if (input.length > MAX_STEPS) throw new Error(`Höchstens ${MAX_STEPS} Schritte.`);
  const steps = input.map((raw, i) => {
    const s = (raw ?? {}) as Record<string, unknown>;
    const keys = Array.isArray(s.keys) ? [...new Set(s.keys.map(String))] : [];
    if (!keys.length) throw new Error(`Schritt ${i + 1}: keine Taste gewählt.`);
    if (keys.length > 5) throw new Error(`Schritt ${i + 1}: höchstens 5 Tasten gleichzeitig.`);
    const unknown = keys.find((k) => !KEYS[k]);
    if (unknown) throw new Error(`Schritt ${i + 1}: unbekannte Taste „${unknown}“.`);
    const num = (v: unknown, max: number) => Math.max(0, Math.min(max, Math.round(Number(v) || 0)));
    // Modifier zuerst drücken, damit z.B. Strg+F13 sauber ankommt
    keys.sort((a, b) => Number(MODIFIERS.has(b)) - Number(MODIFIERS.has(a)));
    return { keys, holdMs: Math.max(20, num(s.holdMs, 30_000)), delayMs: num(s.delayMs, 30_000) };
  });
  const total = steps.reduce((sum, s) => sum + s.holdMs + s.delayMs, 0);
  if (total > MAX_TIME) throw new Error('Die ganze Folge darf höchstens 60 Sekunden dauern.');
  return steps;
}

// ------------------------------------------------------------------ PowerShell-Helfer

const HELPER = `
$src = @"
using System;
using System.Runtime.InteropServices;
public static class SuiteKb {
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct UNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public UNION u; }
  [DllImport("user32.dll", SetLastError = true)] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  public static uint Key(ushort vk, ushort scan, bool ext, bool up) {
    uint flags = 0;
    if (vk == 0) flags |= 0x0008;
    if (ext) flags |= 0x0001;
    if (up) flags |= 0x0002;
    INPUT i = new INPUT();
    i.type = 1;
    i.u.ki.wVk = vk;
    i.u.ki.wScan = scan;
    i.u.ki.dwFlags = flags;
    return SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
}
"@
Add-Type -TypeDefinition $src
[Console]::Out.WriteLine('ready')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  switch ($p[0]) {
    'd' { $r = [SuiteKb]::Key([uint16]$p[1], [uint16]$p[2], $p[3] -eq '1', $false); if ($r -eq 0) { [Console]::Out.WriteLine('blocked') } }
    'u' { [void][SuiteKb]::Key([uint16]$p[1], [uint16]$p[2], $p[3] -eq '1', $true) }
    's' { Start-Sleep -Milliseconds ([int]$p[1]) }
    'x' { [Console]::Out.WriteLine('done ' + $p[1]) }
  }
}
`;

export class Keyboard {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private waiting = new Map<string, () => void>();
  private queue: Promise<void> = Promise.resolve();
  private queued = 0;
  private counter = 0;
  private blocked = false;
  private log = createLogger('Tastatur');

  /** Tastenfolge in die Warteschlange stellen – Folgen laufen nacheinander, nie gemischt. */
  run(steps: KeyStep[], label: string): Promise<void> {
    if (this.queued >= 20) {
      this.log.warn(`Warteschlange voll – „${label}“ wird übersprungen`);
      return Promise.resolve();
    }
    this.queued++;
    const job = this.queue.then(() => this.execute(steps, label)).finally(() => {
      this.queued--;
    });
    this.queue = job.catch(() => {});
    return job;
  }

  stop(): void {
    this.proc?.stdin.end();
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', HELPER], {
        windowsHide: true,
      });
      this.proc = proc;
      let buffer = '';
      const timeout = setTimeout(() => reject(new Error('Tastatur-Helfer startet nicht')), 20_000);
      proc.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        let idx;
        while ((idx = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line === 'ready') {
            clearTimeout(timeout);
            resolve();
          } else if (line === 'blocked') {
            if (!this.blocked) this.log.warn('Windows hat einen Tastendruck blockiert. Läuft das Ziel-Programm als Administrator? Dann muss die Suite auch als Administrator laufen.');
            this.blocked = true;
          } else if (line.startsWith('done ')) {
            this.waiting.get(line.slice(5))?.();
            this.waiting.delete(line.slice(5));
          }
        }
      });
      proc.stderr.on('data', (chunk: Buffer) => this.log.warn(chunk.toString().trim()));
      proc.on('exit', () => {
        if (this.proc === proc) {
          this.proc = null;
          this.ready = null;
        }
        for (const done of this.waiting.values()) done();
        this.waiting.clear();
      });
      proc.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  private async execute(steps: KeyStep[], label: string): Promise<void> {
    await this.start();
    const proc = this.proc;
    if (!proc) throw new Error('Tastatur-Helfer läuft nicht');
    const id = String(++this.counter);
    const lines: string[] = [];
    const cmd = (key: string, up: boolean) => {
      const def = KEYS[key];
      if (!def) return;
      lines.push('vk' in def ? `${up ? 'u' : 'd'} ${def.vk} 0 0` : `${up ? 'u' : 'd'} 0 ${def.scan} ${def.ext ? 1 : 0}`);
    };
    for (const step of steps) {
      if (step.delayMs) lines.push(`s ${step.delayMs}`);
      step.keys.forEach((k) => cmd(k, false));
      lines.push(`s ${step.holdMs}`);
      [...step.keys].reverse().forEach((k) => cmd(k, true));
    }
    lines.push(`x ${id}`);
    const finished = new Promise<void>((resolve) => this.waiting.set(id, resolve));
    proc.stdin.write(`${lines.join('\n')}\n`);
    await finished;
    this.log.info(`Tastenfolge „${label}“ ausgeführt`);
  }
}

/** Eine gemeinsame Instanz für die ganze App */
export const keyboard = new Keyboard();
