import type { TwitchAuth } from './auth';

export interface RequestOptions {
  query?: Record<string, string | string[]>;
  body?: unknown;
}

/** Kleiner Helfer für die Twitch Helix API (https://dev.twitch.tv/docs/api/reference). */
export class TwitchApi {
  constructor(private auth: TwitchAuth) {}

  async request<T = unknown>(method: string, endpoint: string, options: RequestOptions = {}, retried = false): Promise<T> {
    const url = new URL(`https://api.twitch.tv/helix${endpoint}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      for (const item of [value].flat()) url.searchParams.append(key, item);
    }

    const token = await this.auth.getAccessToken();
    const hasBody = options.body !== undefined;
    const res = await fetch(url, {
      method,
      headers: {
        'Client-Id': this.auth.clientId,
        Authorization: `Bearer ${token}`,
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
    });

    if (res.status === 401 && !retried) {
      await this.auth.refresh();
      return this.request<T>(method, endpoint, options, true);
    }
    if (!res.ok) {
      const text = await res.text();
      let message = text;
      try {
        message = JSON.parse(text).message ?? text;
      } catch {
        // kein JSON
      }
      throw new Error(`Twitch API ${res.status}: ${message}`);
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }
}
