import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { Logger } from './log';

export interface ApiRequest {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  query: URLSearchParams;
}
export type ApiHandler = (req: ApiRequest) => unknown;

/** Fehler mit HTTP-Statuscode – die Nachricht wird im UI angezeigt. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.woff2': 'font/woff2',
};

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new HttpError(413, 'Anfrage zu groß'));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new HttpError(400, 'Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Lokaler Webserver (nur auf diesem PC erreichbar). Er liefert
 *  - die Oberfläche der App (/app/…)
 *  - Overlays + Einstellungsseiten der Addons (/addons/<id>/…) – die Overlays bindet man in OBS ein
 *  - die API für Oberfläche und Addons (/api/…)
 *  - einen WebSocket (/ws?channel=<addon-id>), über den Overlays live Daten bekommen
 */
export class LocalServer {
  private routes = new Map<string, ApiHandler>();
  private scopes = new Map<string, Set<string>>();
  private clients = new Set<{ ws: WebSocket; channel: string }>();

  constructor(
    private publicDir: string,
    readonly port: number,
    private log: Logger,
  ) {}

  get url(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** API-Route registrieren. `scope` = wem sie gehört (z.B. Addon-ID), damit man sie wieder entfernen kann. */
  route(scope: string, method: 'GET' | 'POST', urlPath: string, handler: ApiHandler): void {
    const key = `${method} ${urlPath}`;
    this.routes.set(key, handler);
    let keys = this.scopes.get(scope);
    if (!keys) this.scopes.set(scope, (keys = new Set()));
    keys.add(key);
  }

  clearScope(scope: string): void {
    for (const key of this.scopes.get(scope) ?? []) this.routes.delete(key);
    this.scopes.delete(scope);
  }

  /** Nachricht an alle Overlays eines Kanals schicken. */
  broadcast(channel: string, data: unknown): void {
    const message = JSON.stringify(data);
    for (const client of this.clients) {
      if (client.channel === channel && client.ws.readyState === WebSocket.OPEN) client.ws.send(message);
    }
  }

  start(): Promise<void> {
    const server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        this.log.error(`${req.method} ${req.url}:`, err);
        if (!res.headersSent) sendJson(res, 500, { error: (err as Error).message });
      });
    });

    const wss = new WebSocketServer({ noServer: true });
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/ws' || !this.isAllowedHost(req)) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const client = { ws, channel: url.searchParams.get('channel') ?? '' };
        this.clients.add(client);
        ws.on('close', () => this.clients.delete(client));
      });
    });

    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this.port, '127.0.0.1', () => {
        this.log.info(`Läuft auf ${this.url}`);
        resolve();
      });
    });
  }

  /** Schutz gegen fremde Webseiten, die per DNS-Tricks auf den lokalen Server zugreifen wollen. */
  private isAllowedHost(req: http.IncomingMessage): boolean {
    const host = req.headers.host ?? '';
    return host === `127.0.0.1:${this.port}` || host === `localhost:${this.port}`;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.isAllowedHost(req)) return sendJson(res, 403, { error: 'Forbidden' });
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (url.pathname.startsWith('/api/')) return this.handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    if (url.pathname === '/') {
      res.writeHead(302, { Location: '/app/' });
      res.end();
      return;
    }
    return this.serveStatic(url.pathname, res);
  }

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const handler = this.routes.get(`${req.method} ${url.pathname}`);
    if (!handler) return sendJson(res, 404, { error: 'Unbekannte API-Route' });

    try {
      let body: unknown;
      if (req.method === 'POST') {
        // JSON-Pflicht: Browser dürfen so etwas nicht ungefragt von fremden Seiten schicken
        if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
          throw new HttpError(415, 'JSON erwartet');
        }
        body = await readBody(req);
      }
      const result = await handler({ body, query: url.searchParams });
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) this.log.error(`${req.method} ${url.pathname}:`, err);
      sendJson(res, status, { error: (err as Error).message });
    }
  }

  private serveStatic(pathname: string, res: http.ServerResponse): void {
    let relative = decodeURIComponent(pathname);
    if (relative.endsWith('/')) relative += 'index.html';
    const file = path.normalize(path.join(this.publicDir, relative));
    if (!file.startsWith(this.publicDir + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return sendJson(res, 404, { error: 'Nicht gefunden' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  }
}
