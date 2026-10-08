import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PlaybackQueue, type Entry, type PlaybackState } from './playback';
import { REQUEST_DEFAULTS, checkLimits, fillTemplate, parseRequestCommand, requestMode, searchLocal, type SongRequest } from './requests';
import { cleanSet, claimGames, setForGame, type MusicSet, type QueueItem } from './sets';

const sp = (id: string, durationMs = 180_000): QueueItem => ({ kind: 'spotify', ref: `spotify:track:${id}`, title: `Song ${id}`, artists: ['A'], durationMs, image: null });
const lo = (file: string): QueueItem => ({ kind: 'local', ref: file, title: file, artists: [], durationMs: 0, image: null });
const req = (id: string, item: QueueItem, userId = 'u1'): SongRequest => ({
  id, query: id, item, user: { id: userId, name: userId }, source: 'chat', redemption: null, status: 'queued', at: 0,
});

/** Nachgebauter Player: spielt, was playNow/enqueueNext bekommt, und meldet den Zustand */
function setup(options: { provider?: 'spotify-sdk' | 'local' } = {}) {
  let now = 0;
  let state: PlaybackState | null = null;
  const providerQueue: QueueItem[] = [];
  const log: string[] = [];
  const started: Entry[] = [];
  const kindOf = (p: string) => (p === 'local' ? 'local' : 'spotify');
  let provider: 'spotify-sdk' | 'local' = options.provider ?? 'spotify-sdk';
  const trackId = (item: QueueItem) => (item.kind === 'spotify' ? item.ref.split(':')[2] : `L:${item.ref}`);
  const playTrack = (item: QueueItem) => {
    provider = item.kind === 'local' ? 'local' : 'spotify-sdk';
    state = { trackId: trackId(item), positionMs: 0, durationMs: item.durationMs || 60_000, isPlaying: true, provider, at: now };
  };
  const q = new PlaybackQueue({
    now: () => now,
    state: () => state,
    prequeueMs: () => 15_000,
    trackId,
    playNow: async (item) => {
      log.push(`play ${item.title}`);
      playTrack(item);
    },
    enqueueNext: async (item) => {
      if (item.kind !== kindOf(provider)) return false;
      log.push(`enqueue ${item.title}`);
      providerQueue.push(item);
      return true;
    },
    started: (e) => started.push(e),
    changed: () => undefined,
    error: (m) => log.push(`error ${m}`),
  });
  /** Zeit vergehen lassen; am Titelende spielt der Provider seine Queue bzw. einen eigenen Titel */
  const advance = async (ms: number) => {
    const end = now + ms;
    while (now < end) {
      now = Math.min(end, now + 500);
      if (state && state.isPlaying && now - state.at + state.positionMs >= state.durationMs) {
        const next = providerQueue.shift();
        if (next) playTrack(next);
        else state = { ...state, trackId: `context-${now}`, positionMs: 0, durationMs: 60_000, at: now };
      }
      await q.tick();
    }
  };
  /** Provider spielt gerade einen eigenen Titel (Kontext) */
  const contextTrack = (id: string, durationMs: number) => {
    state = { trackId: id, positionMs: 0, durationMs, isPlaying: true, provider, at: now };
  };
  return { q, log, started, advance, contextTrack, providerQueue, state: () => state };
}

describe('Wiedergabe-Queue', () => {
  it('reiht einen Wunsch erst kurz vor Titelende ein und erkennt seinen Start', async () => {
    const t = setup();
    t.contextTrack('ctx1', 60_000);
    t.q.addRequest(req('r1', sp('wish')));
    await t.advance(40_000);
    assert.deepEqual(t.log, [], 'noch nicht übergeben');
    await t.advance(6_000);
    assert.deepEqual(t.log, ['enqueue Song wish']);
    await t.advance(15_000);
    assert.equal(t.started.length, 1);
    assert.equal(t.started[0].request?.id, 'r1');
    assert.equal(t.q.current?.request?.id, 'r1');
  });

  it('Wünsche lassen sich bis zur Übergabe entfernen, danach nicht mehr', async () => {
    const t = setup();
    t.contextTrack('ctx1', 60_000);
    t.q.addRequest(req('r1', sp('a')));
    t.q.addRequest(req('r2', sp('b')));
    assert.equal(t.q.removeRequest('r2'), true);
    await t.advance(50_000);
    assert.equal(t.q.removeRequest('r1'), false, 'schon bei Spotify');
    assert.equal(t.q.position('r1'), 1);
  });

  it('spielt eine eigene Liste Titel für Titel, Wünsche kommen dazwischen', async () => {
    const t = setup();
    await t.q.startList('Set', [sp('l1', 30_000), sp('l2', 30_000), sp('l3', 30_000)], { shuffle: false, repeat: false });
    t.q.addRequest(req('r1', sp('wish', 30_000)));
    await t.advance(95_000);
    assert.deepEqual(t.started.map((e) => e.item.title), ['Song l1', 'Song wish', 'Song l2', 'Song l3']);
  });

  it('gemischte Liste: schaltet am Titelende auf den anderen Provider um', async () => {
    const t = setup();
    await t.q.startList('Mix', [sp('s1', 30_000), lo('lokal.mp3')], { shuffle: false, repeat: false });
    await t.advance(31_000);
    assert.ok(t.log.includes('play lokal.mp3'), t.log.join(' | '));
    assert.equal(t.state()?.provider, 'local');
    assert.equal(t.started.at(-1)?.item.ref, 'lokal.mp3');
  });

  it('„Weiter“ reiht beim gleichen Provider ein (Playlist bleibt erhalten), sonst startet die Queue selbst', async () => {
    const t = setup();
    t.contextTrack('ctx', 60_000);
    assert.equal(await t.q.skip(), 'none');
    t.q.addRequest(req('r1', sp('a')));
    assert.equal(await t.q.skip(), 'provider', 'Spotify-Wunsch während Spotify läuft → einreihen + Weiter');
    assert.deepEqual(t.log, ['enqueue Song a'], 'nicht direkt gestartet');
    assert.equal(await t.q.skip(), 'provider', 'schon eingereiht → Provider macht weiter');

    const u = setup({ provider: 'local' });
    u.contextTrack('lokal', 60_000);
    u.q.addRequest(req('r2', sp('b')));
    assert.equal(await u.q.skip(), 'queue', 'anderer Provider → direkt starten');
    assert.equal(u.q.current?.request?.id, 'r2');
  });

  it('Liste mit Wiederholen fängt wieder von vorn an', async () => {
    const t = setup();
    await t.q.startList('Set', [sp('x', 20_000), sp('y', 20_000)], { shuffle: false, repeat: true });
    await t.advance(61_000);
    assert.deepEqual(t.started.map((e) => e.item.title), ['Song x', 'Song y', 'Song x', 'Song y']);
  });
});

describe('Songwünsche', () => {
  const s = REQUEST_DEFAULTS;

  it('erkennt die Befehle', () => {
    assert.deepEqual(parseRequestCommand('!sr  daft punk one more time ', s), { command: 'request', arg: 'daft punk one more time' });
    assert.deepEqual(parseRequestCommand('!SONG', s), { command: 'song', arg: '' });
    assert.equal(parseRequestCommand('!srx test', s), null);
    assert.equal(parseRequestCommand('hallo !sr', s), null);
  });

  it('Mods/VIPs direkt, alle anderen als Vorschlag, Kanalpunkte direkt', () => {
    assert.equal(requestMode(0, 'chat', s), 'suggest');
    assert.equal(requestMode(1, 'chat', s), 'suggest');
    assert.equal(requestMode(2, 'chat', s), 'direct');
    assert.equal(requestMode(3, 'chat', s), 'direct');
    assert.equal(requestMode(0, 'reward', s), 'direct');
    assert.equal(requestMode(0, 'chat', { ...s, whoCanRequest: 'subscriber' }), 'denied');
    assert.equal(requestMode(0, 'reward', { ...s, rewardDirect: false }), 'suggest');
  });

  it('prüft Limits', () => {
    const base = { userId: 'u1', privileged: false, open: [] as SongRequest[], lastAt: 0, now: 100_000, settings: s };
    assert.equal(checkLimits({ ...base, item: sp('a') }), null);
    assert.match(checkLimits({ ...base, item: { ...sp('a'), durationMs: 900_000 } }) ?? '', /zu lang/);
    assert.match(checkLimits({ ...base, item: { ...sp('a'), title: 'Baby Shark Dance' }, settings: { ...s, blocklist: ['baby shark'] } }) ?? '', /Sperrliste/);
    assert.match(checkLimits({ ...base, item: sp('a'), open: [req('x', sp('a'), 'u2')] }) ?? '', /schon gewünscht/);
    assert.match(checkLimits({ ...base, item: sp('c'), open: [req('x', sp('a')), req('y', sp('b'))] }) ?? '', /2 offene/);
    assert.match(checkLimits({ ...base, item: sp('c'), lastAt: 90_000 }) ?? '', /50 s warten/);
    assert.equal(checkLimits({ ...base, item: sp('c'), lastAt: 90_000, privileged: true }), null, 'Mods ohne Wartezeit');
    assert.match(checkLimits({ ...base, item: { ...sp('e'), explicit: true }, settings: { ...s, allowExplicit: false } }) ?? '', /Explizite/);
  });

  it('setzt Vorlagen ein', () => {
    assert.equal(fillTemplate('@{user} „{title}“ Platz {pos} {unbekannt}', { user: 'Luna', title: 'X', pos: 2 }), '@Luna „X“ Platz 2 {unbekannt}');
  });

  it('sucht in der eigenen Musik', () => {
    const tracks = [
      { file: 'Chill/Lofi - Regen.mp3', title: 'Regen', artists: ['Lofi Luna'], album: null },
      { file: 'Hype/Mini - Regenbogen.mp3', title: 'Regenbogen', artists: ['Mini'], album: null },
      { file: 'Hype/Über alles.mp3', title: 'Über alles', artists: ['Band'], album: null },
    ];
    assert.equal(searchLocal(tracks, 'regen')[0].title, 'Regen', 'exakter Titel zuerst');
    assert.equal(searchLocal(tracks, 'mini regenbogen')[0].title, 'Regenbogen');
    assert.equal(searchLocal(tracks, 'uber')[0].title, 'Über alles', 'Umlaute egal');
    assert.deepEqual(searchLocal(tracks, 'gibtsnicht'), []);
  });
});

describe('Musik-Sets', () => {
  const game = (id: string) => ({ id, name: `Spiel ${id}` });

  it('prüft verknüpfte und eigene Sets', () => {
    const linked = cleanSet({ name: 'Chill', type: 'linked', source: 'https://open.spotify.com/playlist/abc123', games: [game('1')] });
    assert.equal(linked.source, 'spotify:playlist:abc123');
    assert.throws(() => cleanSet({ name: 'X', type: 'linked', source: 'spotify:track:abc' }), /Playlist/);
    assert.throws(() => cleanSet({ name: '', type: 'linked', source: 'local:Chill' }), /Namen/);
    const custom = cleanSet({ name: 'Mix', type: 'custom', tracks: [{ kind: 'spotify', ref: 'spotify:track:t1', title: 'T' }, { kind: 'local', ref: 'Chill/a.mp3' }] });
    assert.equal(custom.tracks.length, 2);
    assert.throws(() => cleanSet({ name: 'Böse', type: 'custom', tracks: [{ kind: 'local', ref: '../../geheim.txt' }] }), /Pfad/);
  });

  it('wählt das Set zum Spiel, sonst das Standard-Set', () => {
    const sets: MusicSet[] = [
      { id: 'a', name: 'A', type: 'linked', source: 'local:A', tracks: [], games: [game('1')] },
      { id: 'b', name: 'B', type: 'linked', source: 'local:B', tracks: [], games: [game('2')] },
    ];
    assert.equal(setForGame({ sets, defaultSetId: 'b', switchOnGameChange: true }, game('1'))?.id, 'a');
    assert.equal(setForGame({ sets, defaultSetId: 'b', switchOnGameChange: true }, game('9'))?.id, 'b');
    assert.equal(setForGame({ sets, defaultSetId: '', switchOnGameChange: true }, game('9')), null);
  });

  it('ein Spiel gehört nur zu einem Set', () => {
    const sets: MusicSet[] = [
      { id: 'a', name: 'A', type: 'linked', source: 'local:A', tracks: [], games: [game('1'), game('2')] },
      { id: 'b', name: 'B', type: 'linked', source: 'local:B', tracks: [], games: [game('2')] },
    ];
    const result = claimGames(sets, sets[1]);
    assert.deepEqual(result[0].games.map((g) => g.id), ['1']);
  });
});
