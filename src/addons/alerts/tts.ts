import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Text-to-Speech über die in Windows eingebauten Stimmen (System.Speech).
 * Erzeugt eine WAV-Datei, die das Overlay abspielt – so klappt es auch in OBS,
 * wo die Browser-Sprachausgabe oft keine Stimmen hat.
 */

const LIST_SCRIPT = `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$s.GetInstalledVoices() | Where-Object { $_.Enabled } | ForEach-Object { $_.VoiceInfo.Name + '|' + $_.VoiceInfo.Culture.Name }
$s.Dispose()
`;

// Text, Stimme usw. kommen über Umgebungsvariablen rein – nie direkt in den Befehl
const SPEAK_SCRIPT = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($env:TTS_VOICE) { try { $s.SelectVoice($env:TTS_VOICE) } catch {} }
$s.Rate = [int]$env:TTS_RATE
$s.SetOutputToWaveFile($env:TTS_OUT)
$s.Speak($env:TTS_TEXT)
$s.Dispose()
`;

function runPowerShell(script: string, env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => (err ? reject(new Error(stderr.trim() || err.message)) : resolve(stdout)),
    );
  });
}

export interface Voice {
  name: string;
  language: string;
}

export class Tts {
  private voiceCache: Promise<Voice[]> | null = null;

  constructor(
    private dir: string,
    private urlBase: string,
  ) {
    fs.mkdirSync(dir, { recursive: true });
  }

  voices(): Promise<Voice[]> {
    this.voiceCache ??= runPowerShell(LIST_SCRIPT)
      .then((out) =>
        out
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const [name, language] = line.split('|');
            return { name, language: language ?? '' };
          }),
      )
      .catch((err) => {
        this.voiceCache = null;
        throw err;
      });
    return this.voiceCache;
  }

  /** Spricht den Text in eine WAV-Datei und gibt deren URL zurück. */
  async speak(text: string, voice: string, rate: number): Promise<string> {
    this.cleanup();
    const file = path.join(this.dir, `${randomUUID()}.wav`);
    await runPowerShell(SPEAK_SCRIPT, {
      TTS_TEXT: text.slice(0, 400),
      TTS_VOICE: voice,
      TTS_RATE: String(Math.max(-10, Math.min(10, Math.round(rate)))),
      TTS_OUT: file,
    });
    return `${this.urlBase}/${path.basename(file)}`;
  }

  /** Alte Sprachdateien (älter als 10 Minuten) löschen. */
  private cleanup(): void {
    const cutoff = Date.now() - 10 * 60 * 1000;
    for (const name of fs.readdirSync(this.dir)) {
      const file = path.join(this.dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        // Datei wird evtl. gerade abgespielt – beim nächsten Mal
      }
    }
  }
}
