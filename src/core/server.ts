import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import type { Logger } from './log';

export interface ApiRequest {
  /** JSON-Body – bei Upload-Routen ein Buffer mit den Dateidaten */
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

interface Route {
  handler: ApiHandler;
  upload: boolean;
}

const JSON_LIMIT = 2 * 1024 * 1024;
const UPLOAD_LIMIT = 60 * 1024 * 1024;

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

function readRaw(req: http.IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, `Datei zu groß (max. ${Math.round(limit / 1024 / 1024)} MB)`));
        req.destroy();
      } else chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const text = (await readRaw(req, JSON_LIMIT)).toString('utf8');
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, 'Ungültiges JSON');
  }
}

/**
 * Lokaler Webserver (nur auf diesem PC erreichbar). Er liefert
 *  - die Oberfläche der App (/app/…)
 *  - Overlays + Einstellungsseiten der Addons (/addons/<id>/…) – die Overlays bindet man in OBS ein
 *  - hochgeladene Dateien der Addons (/addon-data/<id>/…)
 *  - die API für Oberfläche und Addons (/api/…)
 *  - einen WebSocket (/ws?channel=<addon-id>), über den Overlays live Daten bekommen
 */
export class LocalServer {
  private routes = new Map<string, Route>();
  private mounts = new Map<string, { dir: string; scope: string }>();
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

  /**
   * API-Route registrieren. `scope` = wem sie gehört (z.B. Addon-ID), damit man sie wieder entfernen kann.
   * Upload-Routen bekommen die rohen Dateidaten als Buffer.
   */
  route(scope: string, method: 'GET' | 'POST', urlPath: string, handler: ApiHandler, options: { upload?: boolean } = {}): void {
    const key = `${method} ${urlPath}`;
    this.routes.set(key, { handler, upload: !!options.upload });
    this.scopeKeys(scope).add(key);
  }

  /** Einen Ordner unter einem URL-Präfix ausliefern, z.B. /addon-data/alerts → …/addon-data/alerts */
  mount(scope: string, prefix: string, dir: string): void {
    this.mounts.set(prefix, { dir: path.resolve(dir), scope });
  }

  clearScope(scope: string): void {
    for (const key of this.scopes.get(scope) ?? []) this.routes.delete(key);
    this.scopes.delete(scope);
    for (const [prefix, mount] of this.mounts) if (mount.scope === scope) this.mounts.delete(prefix);
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

  private scopeKeys(scope: string): Set<string> {
    let keys = this.scopes.get(scope);
    if (!keys) this.scopes.set(scope, (keys = new Set()));
    return keys;
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

    const pathname = decodeURIComponent(url.pathname);
    for (const [prefix, mount] of this.mounts) {
      if (pathname.startsWith(`${prefix}/`)) return this.serveFile(mount.dir, pathname.slice(prefix.length), req, res);
    }
    return this.serveFile(this.publicDir, pathname, req, res);
  }

  private async handleApi(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    const route = this.routes.get(`${req.method} ${url.pathname}`);
    if (!route) return sendJson(res, 404, { error: 'Unbekannte API-Route' });

    try {
      let body: unknown;
      if (req.method === 'POST') {
        // Fremde Webseiten dürfen weder JSON noch eigene Header ungefragt an den Server schicken
        if (route.upload) {
          if (req.headers['x-suite-upload'] !== '1') throw new HttpError(400, 'Upload-Header fehlt');
          body = await readRaw(req, UPLOAD_LIMIT);
        } else {
          if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) {
            throw new HttpError(415, 'JSON erwartet');
          }
          body = await readJson(req);
        }
      }
      const result = await route.handler({ body, query: url.searchParams });
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) this.log.error(`${req.method} ${url.pathname}:`, err);
      if (!res.headersSent) sendJson(res, status, { error: (err as Error).message });
    }
  }

  /** Datei ausliefern – mit Range-Unterstützung, damit Videos und Sounds sauber abspielen. */
  private serveFile(root: string, relative: string, req: http.IncomingMessage, res: http.ServerResponse): void {
    if (relative.endsWith('/')) relative += 'index.html';
    const file = path.normalize(path.join(root, relative));
    if (!file.startsWith(root + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });

    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) return sendJson(res, 404, { error: 'Nicht gefunden' });
      const headers: http.OutgoingHttpHeaders = {
        'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'Accept-Ranges': 'bytes',
      };

      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      if (range && (range[1] || range[2])) {
        let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
        let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
        start = Math.max(0, start);
        end = Math.min(end, stat.size - 1);
        if (start > end) {
          res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
          res.end();
          return;
        }
        res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
        if (req.method === 'HEAD') return void res.end();
        fs.createReadStream(file, { start, end }).pipe(res);
        return;
      }

      res.writeHead(200, { ...headers, 'Content-Length': stat.size });
      if (req.method === 'HEAD') return void res.end();
      fs.createReadStream(file).pipe(res);
    });
  }
}
