import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createLogger } from '../../core/log';
import { SpotifyClient, parseSpotifySource, pickConnectDevice, playBody, type SpotifyDevice, type SpotifyTokens } from './spotify';

const device = (name: string, type = 'Computer', extra: Partial<SpotifyDevice> = {}): SpotifyDevice => ({
  id: `id-${name}`, name, type, is_active: false, is_restricted: false, volume_percent: 50, ...extra,
});

describe('Spotify-Quellen', () => {
  it('erkennt URIs und Links aus der App', () => {
    assert.equal(parseSpotifySource('spotify:playlist:37i9dQZF1DXcBWIGoYBM5M'), 'spotify:playlist:37i9dQZF1DXcBWIGoYBM5M');
    assert.equal(parseSpotifySource('https://open.spotify.com/intl-de/playlist/37i9dQZF1DX?si=abc'), 'spotify:playlist:37i9dQZF1DX');
    assert.equal(parseSpotifySource('https://open.spotify.com/album/1ATL5GLyefJaxhQzSPVrLX'), 'spotify:album:1ATL5GLyefJaxhQzSPVrLX');
    assert.equal(parseSpotifySource('local:Chill'), null);
    assert.equal(parseSpotifySource('irgendwas'), null);
  });

  it('baut den Body fürs Abspielen', () => {
    assert.deepEqual(playBody('spotify:playlist:x'), { context_uri: 'spotify:playlist:x' });
    assert.deepEqual(playBody('spotify:track:y'), { uris: ['spotify:track:y'] });
    assert.deepEqual(playBody(null), {});
  });
});

describe('Gerät für die Desktop-App wählen', () => {
  const devices = [device('Handy', 'Smartphone', { is_active: true }), device('Stream Suite'), device('GAMING-PC'), device('STREAM-PC', 'Computer', { is_active: true })];

  it('nimmt das Gerät mit dem eingestellten Namen', () => {
    assert.equal(pickConnectDevice(devices, 'gaming-pc', 'Stream Suite')?.name, 'GAMING-PC');
    assert.equal(pickConnectDevice(devices, 'Gibtsnicht', 'Stream Suite'), null);
  });

  it('sonst einen Computer, aktiv bevorzugt, nie das eigene SDK-Gerät', () => {
    assert.equal(pickConnectDevice(devices, '', 'Stream Suite')?.name, 'STREAM-PC');
    assert.equal(pickConnectDevice([device('Stream Suite', 'Computer', { is_active: true })], '', 'Stream Suite'), null);
  });
});

describe('SpotifyClient', () => {
  function setup(responses: Array<{ status: number; body?: unknown; headers?: Record<string, string> }>, tokens: Partial<SpotifyTokens> = {}) {
    let stored: SpotifyTokens | null = { accessToken: 'alt', refreshToken: 'refresh-1', expiresAt: Date.now() + 3600_000, scope: 's', ...tokens };
    const calls: Array<{ url: string; auth?: string; body?: string }> = [];
    const slept: number[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>)?.Authorization, body: init.body?.toString() });
      const r = responses.shift() ?? { status: 500 };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
    }) as unknown as typeof fetch;
    const client = new SpotifyClient({
      clientId: () => 'client',
      redirectUri: () => 'http://127.0.0.1:7474/addons/music/callback.html',
      store: { get: () => stored, set: (t) => { stored = t; } },
      log: createLogger('Test'),
      fetch: fake,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    return { client, calls, slept, tokens: () => stored };
  }

  it('erneuert den Token bei 401 und wiederholt die Anfrage', async () => {
    const t = setup([
      { status: 401, body: { error: { status: 401, message: 'expired' } } },
      { status: 200, body: { access_token: 'neu', expires_in: 3600 } },
      { status: 200, body: { id: 'u1', display_name: 'Mini' } },
    ]);
    const user = await t.client.loadUser();
    assert.deepEqual(user, { id: 'u1', name: 'Mini' });
    assert.equal(t.calls[2].auth, 'Bearer neu');
    assert.equal(t.tokens()?.refreshToken, 'refresh-1', 'alter Refresh-Token bleibt, wenn kein neuer kommt');
  });

  it('erneuert den Token schon vor Ablauf', async () => {
    const t = setup([
      { status: 200, body: { access_token: 'frisch', refresh_token: 'refresh-2', expires_in: 3600 } },
      { status: 204 },
    ], { expiresAt: Date.now() + 10_000 });
    await t.client.request('PUT', '/me/player/pause');
    assert.match(t.calls[0].url, /accounts\.spotify\.com\/api\/token/);
    assert.match(t.calls[0].body ?? '', /grant_type=refresh_token/);
    assert.equal(t.calls[1].auth, 'Bearer frisch');
    assert.equal(t.tokens()?.refreshToken, 'refresh-2');
  });

  it('wartet bei 429 so lange wie Retry-After sagt', async () => {
    const t = setup([{ status: 429, headers: { 'Retry-After': '2' } }, { status: 204 }]);
    assert.equal(await t.client.request('PUT', '/me/player/volume', { query: { volume_percent: '40' } }), null);
    assert.deepEqual(t.slept, [2000]);
    assert.equal(t.calls.length, 2);
  });

  it('gibt bei zu langem Retry-After einen Fehler', async () => {
    const t = setup([{ status: 429, headers: { 'Retry-After': '120' } }]);
    await assert.rejects(t.client.request('PUT', '/me/player/next'), /bremst/);
  });

  it('übersetzt NO_ACTIVE_DEVICE', async () => {
    const t = setup([{ status: 404, body: { error: { status: 404, message: 'Player command failed', reason: 'NO_ACTIVE_DEVICE' } } }]);
    await assert.rejects(t.client.request('PUT', '/me/player/play'), /Kein aktives Spotify-Gerät/);
  });

  it('meldet sich ab, wenn der Refresh-Token ungültig ist', async () => {
    const t = setup([{ status: 400, body: { error: 'invalid_grant', error_description: 'Refresh token revoked' } }], { expiresAt: 0 });
    await assert.rejects(t.client.request('GET', '/me'), /revoked/);
    assert.equal(t.tokens(), null);
  });
});
