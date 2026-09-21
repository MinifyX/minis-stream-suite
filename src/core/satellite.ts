import { randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import { WebSocket, WebSocketServer } from 'ws';
import type { ConfigStore } from './config';
import type { CoreConfig } from './coreConfig';
import { compileSteps, SEND_INPUT_CSHARP, stepsDuration, type KeyStep } from './keyboard';
import { createLogger } from './log';

/**
 * Satellite: ein zweiter PC (z.B. Gaming-PC), der Tastendrücke für die Suite ausführt.
 *
 * Die Suite öffnet dafür einen eigenen Port im Heimnetz (Standard 7475), aber nur, wenn man
 * es einschaltet. Dort gibt es nur einen WebSocket, und nur wer den geheimen Schlüssel kennt,
 * darf sich verbinden. Oberfläche und API der Suite bleiben weiterhin nur auf diesem PC erreichbar.
 *
 * Nachrichten (JSON):
 *   Satellite → Suite: { type: 'hello', token, name, version } · { type: 'done', id, ok }
 *   Suite → Satellite: { type: 'welcome' } · { type: 'run', id, label, lines }
 */

const log = createLogger('Satellite');
const PROTOCOL_VERSION = 1;

interface Client {
  ws: WebSocket;
  name: string;
  since: number;
  alive: boolean;
}

export interface SatelliteStatus {
  enabled: boolean;
  listening: boolean;
  port: number;
  connected: boolean;
  name: string | null;
  since: number | null;
  addresses: string[];
  error: string | null;
}

/** IPv4-Adressen dieses PCs im Heimnetz */
export function lanAddresses(): string[] {
  const result: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const addr of list ?? []) {
      if (addr.family === 'IPv4' && !addr.internal && !addr.address.startsWith('169.254.')) result.push(addr.address);
    }
  }
  // Typische Heimnetz-Adressen zuerst
  const score = (a: string) => (a.startsWith('192.168.') ? 0 : a.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  return result.sort((a, b) => score(a) - score(b));
}

export class SatelliteHub {
  private config: ConfigStore<CoreConfig> | null = null;
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private client: Client | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pending = new Map<string, { resolve: () => void; reject: (err: Error) => void; timer: NodeJS.Timeout }>();
  private queue: Promise<void> = Promise.resolve();
  private counter = 0;
  private error: string | null = null;

  init(config: ConfigStore<CoreConfig>): Promise<void> {
    this.config = config;
    return config.get('satelliteEnabled') ? this.start() : Promise.resolve();
  }

  status(): SatelliteStatus {
    return {
      enabled: this.cfg.get('satelliteEnabled'),
      listening: !!this.server?.listening,
      port: this.cfg.get('satellitePort'),
      connected: !!this.client,
      name: this.client?.name ?? null,
      since: this.client?.since ?? null,
      addresses: lanAddresses(),
      error: this.error,
    };
  }

  get connected(): boolean {
    return !!this.client;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.cfg.set('satelliteEnabled', enabled);
    if (enabled) await this.start();
    else this.stop();
  }

  /** Neuer Schlüssel → alte Satellite-Dateien funktionieren nicht mehr */
  regenerateToken(): void {
    this.cfg.set('satelliteToken', randomBytes(24).toString('hex'));
    this.client?.ws.close(4001, 'Schlüssel geändert');
    log.info('Neuer Satellite-Schlüssel erzeugt');
  }

  /** Tastenfolge auf dem Satellite ausführen (nacheinander, nie gemischt) */
  run(steps: KeyStep[], label: string): Promise<void> {
    const job = this.queue.then(() => this.execute(steps, label));
    this.queue = job.catch(() => {});
    return job;
  }

  stop(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.client?.ws.close(1001, 'Suite beendet Satellite-Zugang');
    this.client = null;
    this.wss?.close();
    this.server?.close();
    this.wss = null;
    this.server = null;
    this.error = null;
  }

  /** Die Satellite-Datei (.cmd) mit eingebauter Adresse und Schlüssel */
  script(address: string): string {
    if (!/^[a-zA-Z0-9.-]{1,253}$/.test(address)) throw new Error('Ungültige Adresse');
    return buildScript(`ws://${address}:${this.cfg.get('satellitePort')}/satellite`, this.token());
  }

  // ------------------------------------------------------------------ intern

  private get cfg(): ConfigStore<CoreConfig> {
    if (!this.config) throw new Error('Satellite nicht initialisiert');
    return this.config;
  }

  private token(): string {
    if (!this.cfg.get('satelliteToken')) this.cfg.set('satelliteToken', randomBytes(24).toString('hex'));
    return this.cfg.get('satelliteToken');
  }

  private start(): Promise<void> {
    if (this.server) return Promise.resolve();
    this.token();
    const port = this.cfg.get('satellitePort');
    const server = http.createServer((_req, res) => {
      res.writeHead(404);
      res.end();
    });
    const wss = new WebSocketServer({ server, path: '/satellite', maxPayload: 64 * 1024 });
    wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? '?'));
    this.server = server;
    this.wss = wss;

    this.pingTimer = setInterval(() => {
      const c = this.client;
      if (!c) return;
      if (!c.alive) {
        log.warn(`Keine Antwort von „${c.name}“ – Verbindung getrennt`);
        c.ws.terminate();
        return;
      }
      c.alive = false;
      c.ws.ping();
    }, 15_000);

    return new Promise((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.error = err.code === 'EADDRINUSE' ? `Port ${port} ist schon belegt.` : err.message;
        log.error('Satellite-Zugang konnte nicht starten:', this.error);
        this.server = null;
        this.wss = null;
        resolve();
      });
      // Absichtlich auf allen Netzwerkkarten, damit der Gaming-PC im Heimnetz rankommt
      server.listen(port, '0.0.0.0', () => {
        this.error = null;
        log.info(`Wartet auf Satellite (Port ${port}, ${lanAddresses().join(', ') || 'keine Netzwerkadresse'})`);
        resolve();
      });
    });
  }

  private onConnection(ws: WebSocket, remote: string): void {
    let authed = false;
    const helloTimeout = setTimeout(() => ws.close(4000, 'Keine Anmeldung'), 5_000);

    ws.on('message', (raw) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!authed) {
        if (msg.type !== 'hello' || !this.checkToken(msg.token)) {
          log.warn(`Satellite-Anmeldung von ${remote} abgelehnt (falscher Schlüssel)`);
          ws.close(4001, 'Falscher Schlüssel');
          return;
        }
        authed = true;
        clearTimeout(helloTimeout);
        const name = String(msg.name ?? 'Satellite').slice(0, 60);
        // Immer nur ein Satellite – ein neuer ersetzt den alten
        if (this.client) this.client.ws.close(4002, 'Ersetzt durch neue Verbindung');
        const client: Client = { ws, name, since: Date.now(), alive: true };
        this.client = client;
        ws.on('pong', () => {
          client.alive = true;
        });
        ws.send(JSON.stringify({ type: 'welcome', version: PROTOCOL_VERSION }));
        log.info(`„${name}“ verbunden (${remote})`);
        return;
      }

      if (msg.type === 'done') {
        const job = this.pending.get(String(msg.id));
        if (!job) return;
        clearTimeout(job.timer);
        this.pending.delete(String(msg.id));
        if (msg.ok) job.resolve();
        else job.reject(new Error(String(msg.error ?? 'Fehler auf dem Satellite')));
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimeout);
      if (this.client?.ws === ws) {
        log.info(`„${this.client.name}“ getrennt`);
        this.client = null;
        for (const job of this.pending.values()) {
          clearTimeout(job.timer);
          job.reject(new Error('Satellite wurde getrennt'));
        }
        this.pending.clear();
      }
    });
    ws.on('error', () => {});
  }

  private checkToken(value: unknown): boolean {
    const expected = Buffer.from(this.token());
    const given = Buffer.from(String(value ?? ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  private execute(steps: KeyStep[], label: string): Promise<void> {
    const client = this.client;
    if (!client) return Promise.reject(new Error('Kein Satellite verbunden'));
    const id = String(++this.counter);
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Satellite antwortet nicht'));
      }, stepsDuration(steps) + 10_000);
      this.pending.set(id, {
        resolve: () => {
          log.info(`Tastenfolge „${label}“ auf „${client.name}“ ausgeführt`);
          resolve();
        },
        reject,
        timer,
      });
      client.ws.send(JSON.stringify({ type: 'run', id, label, lines: compileSteps(steps) }));
    });
  }
}

/** Eine gemeinsame Instanz für die ganze App */
export const satellite = new SatelliteHub();

// ------------------------------------------------------------------ Satellite-Datei

/**
 * Eine .cmd-Datei, die gleichzeitig ein PowerShell-Skript ist: Doppelklick genügt,
 * nichts muss installiert werden. Nur ASCII-Zeichen, damit cmd.exe nicht stolpert.
 */
function buildScript(url: string, token: string): string {
  const ps = `
$ErrorActionPreference = 'Stop'
$Server = '${url}'
$Token = '${token}'
$Version = ${PROTOCOL_VERSION}
$Host.UI.RawUI.WindowTitle = "Mini's Stream Suite - Satellite"

$src = @"
${SEND_INPUT_CSHARP}
"@
Add-Type -TypeDefinition $src

function Say($text, $color = 'Gray') { Write-Host ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $text) -ForegroundColor $color }

function Send-Json($ws, $obj) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($obj | ConvertTo-Json -Compress))
  $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$bytes)
  $ws.SendAsync($seg, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, [Threading.CancellationToken]::None).Wait()
}

function Receive-Text($ws) {
  $buffer = New-Object byte[] 65536
  $ms = New-Object System.IO.MemoryStream
  do {
    $seg = New-Object System.ArraySegment[byte] -ArgumentList @(,$buffer)
    $result = $ws.ReceiveAsync($seg, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    if ($result.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) { return $null }
    $ms.Write($buffer, 0, $result.Count)
  } while (-not $result.EndOfMessage)
  return [Text.Encoding]::UTF8.GetString($ms.ToArray())
}

function Run-Lines($lines) {
  foreach ($line in $lines) {
    $p = ([string]$line).Split(' ')
    switch ($p[0]) {
      'd' { if ([SuiteKb]::Key([uint16]$p[1], [uint16]$p[2], $p[3] -eq '1', $false) -eq 0) { Say 'Windows hat einen Tastendruck blockiert (Spiel als Administrator? Dann Satellite auch als Administrator starten).' 'Yellow' } }
      'u' { [void][SuiteKb]::Key([uint16]$p[1], [uint16]$p[2], $p[3] -eq '1', $true) }
      's' { Start-Sleep -Milliseconds ([int]$p[1]) }
    }
  }
}

Write-Host ''
Write-Host "  Mini's Stream Suite - Satellite" -ForegroundColor Magenta
Write-Host "  Fuehrt Keybinds von deinem Stream-PC auf diesem PC aus." -ForegroundColor DarkGray
Write-Host "  Stream-PC: $Server" -ForegroundColor DarkGray
Write-Host "  Zum Beenden dieses Fenster schliessen." -ForegroundColor DarkGray
Write-Host ''

$wait = 3
while ($true) {
  $ws = $null
  try {
    Say 'Verbinde mit dem Stream-PC ...'
    $ws = New-Object System.Net.WebSockets.ClientWebSocket
    $ws.Options.KeepAliveInterval = [TimeSpan]::FromSeconds(15)
    [void]$ws.ConnectAsync([Uri]$Server, [Threading.CancellationToken]::None).GetAwaiter().GetResult()
    Send-Json $ws @{ type = 'hello'; token = $Token; name = $env:COMPUTERNAME; version = $Version }
    while ($ws.State -eq [System.Net.WebSockets.WebSocketState]::Open) {
      $text = Receive-Text $ws
      if ($text -eq $null) { break }
      $msg = $text | ConvertFrom-Json
      switch ($msg.type) {
        'welcome' { Say 'Verbunden! Keybinds werden jetzt auf diesem PC ausgefuehrt.' 'Green'; $wait = 3 }
        'run' {
          try {
            Run-Lines $msg.lines
            Say ("Keybind: " + $msg.label) 'Cyan'
            Send-Json $ws @{ type = 'done'; id = $msg.id; ok = $true }
          } catch {
            Send-Json $ws @{ type = 'done'; id = $msg.id; ok = $false; error = "$_" }
          }
        }
      }
    }
    $closeCode = if ($ws.CloseStatus -ne $null) { [int]$ws.CloseStatus } else { 0 }
    if ($closeCode -eq 4001) {
      Say 'Der Stream-PC kennt diesen Schluessel nicht mehr. Lade in der Suite eine neue Satellite-Datei herunter.' 'Red'
      $wait = 30
    } elseif ($closeCode -eq 4002) {
      Say 'Ein anderer Satellite hat sich verbunden.' 'Yellow'
      $wait = 30
    } else {
      Say 'Verbindung getrennt.' 'Yellow'
    }
  } catch {
    Say 'Stream-PC nicht erreichbar. Laeuft die Suite und ist der Satellite-Zugang eingeschaltet?' 'Yellow'
  } finally {
    if ($ws) { $ws.Dispose() }
  }
  Say "Neuer Versuch in $wait Sekunden ..." 'DarkGray'
  Start-Sleep -Seconds $wait
  $wait = [Math]::Min($wait * 2, 30)
}
`;
  const batch = [
    '<# : Mini\'s Stream Suite - Satellite. Doppelklick zum Starten.',
    '@echo off',
    'set "SUITE_SATELLITE_FILE=%~f0"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "iex ([IO.File]::ReadAllText($env:SUITE_SATELLITE_FILE))"',
    'if errorlevel 1 pause',
    'exit /b',
    '#>',
  ].join('\r\n');
  return `${batch}\r\n${ps.replace(/\r?\n/g, '\r\n')}`;
}
