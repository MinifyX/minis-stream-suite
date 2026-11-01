import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { makeTestEvent, type StreamEvent, type TwitchUserRef } from '../../core/twitch/events';
import { effectOf } from '../channelpoints/service';
import {
  alertShownEvent,
  backoffDelay,
  BACKOFF_MAX_MS,
  EventIds,
  Forwarder,
  MAX_AGE_MS,
  MAX_OUTBOX,
  normalizeServerUrl,
  shouldForward,
  sign,
  toSuiteEvent,
  type ForwarderConfig,
  type SuiteBatch,
  type SuiteEvent,
} from './forwarder';

// ------------------------------------------------------------------ Test-Helfer

const USER: TwitchUserRef = { id: '1', login: 'zuschauer', name: 'Zuschauer' };
const CONFIG: ForwarderConfig = { serverUrl: 'https://uwuclip.example.test', secret: 'test-secret' };

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uwuclip-test-'));
after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
let fileNo = 0;
const outboxFile = () => path.join(tmpRoot, `outbox-${fileNo++}.json`);

const redemption = (redemptionId = 'r1', rewardId = 'reward-1'): StreamEvent => ({
  type: 'redemption', redemptionId, user: USER, reward: { id: rewardId, title: 'Jumpscare', cost: 500 }, input: '', status: 'unfulfilled',
});

const suiteEvent = (id: string, at: number): SuiteEvent => ({ id, at, type: 'follow', data: { user: USER } });

interface Call { url: string; headers: Record<string, string>; body: string; batch: SuiteBatch }

/** Fake-Server: antwortet der Reihe nach mit den Status-Codes (der letzte gilt danach immer) */
function fakeFetch(statuses: Array<number | 'network'>) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    const body = String(init.body);
    calls.push({ url, headers: init.headers as Record<string, string>, body, batch: JSON.parse(body) });
    const status = statuses.length > 1 ? statuses.shift()! : statuses[0];
    if (status === 'network') throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
    const events = (JSON.parse(body) as SuiteBatch).events.length;
    return new Response(JSON.stringify({ accepted: events, dropped: 0 }), { status });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

function makeForwarder(opts: { statuses?: Array<number | 'network'>; file?: string; config?: ForwarderConfig | null } = {}) {
  let now = 1_000_000_000_000;
  const server = fakeFetch(opts.statuses ?? [200]);
  const file = opts.file ?? outboxFile();
  const fw = new Forwarder({
    file,
    version: '0.8.0',
    config: () => (opts.config === undefined ? CONFIG : opts.config),
    now: () => now,
    fetch: server.fn,
  });
  return { fw, server, file, tick: (ms: number) => (now += ms), getNow: () => now };
}

// ------------------------------------------------------------------ Signatur

describe('UwUClip: Signatur', () => {
  test('sha256=<hex> über "<timestamp>.<body>"', () => {
    const body = '{"source":"minis-stream-suite","version":"0.8.0","events":[]}';
    const expected = createHmac('sha256', 'geheim').update(`1700000000000.${body}`).digest('hex');
    assert.equal(sign('geheim', 1700000000000, body), `sha256=${expected}`);
    assert.match(sign('geheim', 1, body), /^sha256=[0-9a-f]{64}$/);
  });

  test('Anfrage: Pfad, Header und signierter Body passen zusammen', async () => {
    const { fw, server, getNow } = makeForwarder();
    fw.enqueue(suiteEvent('a', getNow()));
    await fw.flush();
    assert.equal(server.calls.length, 1);
    const call = server.calls[0];
    assert.equal(call.url, 'https://uwuclip.example.test/api/hooks/suite');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.equal(call.headers['X-UwUClip-Timestamp'], String(getNow()));
    assert.equal(call.headers['X-UwUClip-Signature'], sign(CONFIG.secret, getNow(), call.body));
    assert.equal(call.batch.source, 'minis-stream-suite');
    assert.equal(call.batch.version, '0.8.0');
    assert.deepEqual(call.batch.events.map((e) => e.id), ['a']);
  });

  test('Server-Adresse: / am Ende weg, nur http(s)', () => {
    assert.equal(normalizeServerUrl(' https://uwuclip.example.test/ '), 'https://uwuclip.example.test');
    assert.equal(normalizeServerUrl('http://192.0.2.10:8080/clip//'), 'http://192.0.2.10:8080/clip');
    assert.equal(normalizeServerUrl(''), '');
    assert.throws(() => normalizeServerUrl('ftp://uwuclip.example.test'));
    assert.throws(() => normalizeServerUrl('javascript:alert(1)'));
    assert.throws(() => normalizeServerUrl('https://user:pw@uwuclip.example.test'));
    assert.throws(() => normalizeServerUrl('kein link'));
  });
});

// ------------------------------------------------------------------ Filter & Umwandlung

describe('UwUClip: was weitergeleitet wird', () => {
  test('Chat, Löschungen, erledigte Einlösungen und Test-Events nie', () => {
    assert.equal(shouldForward(makeTestEvent('chat')), false);
    assert.equal(shouldForward({ type: 'chatdelete', messageId: 'm' }), false);
    assert.equal(shouldForward({ type: 'chatclear', userId: null }), false);
    assert.equal(shouldForward({ type: 'redemptionupdate', redemptionId: 'r', rewardId: 'x', status: 'fulfilled' }), false);
    assert.equal(shouldForward({ ...redemption(), test: true }), false);
    assert.equal(shouldForward(redemption()), true);
    assert.equal(shouldForward({ type: 'raid', user: USER, viewers: 5 }), true);
    assert.equal(shouldForward({ type: 'adbreak', durationSeconds: 90, automatic: true, startedAt: '' }), true);
  });

  test('Umfragen und Vorhersagen nur Start und Ende', () => {
    const poll = (phase: 'begin' | 'progress' | 'end'): StreamEvent => ({ type: 'poll', phase, pollId: 'p', title: 'T', choices: [], status: '', endsAt: null });
    assert.deepEqual(['begin', 'progress', 'end'].map((p) => shouldForward(poll(p as 'begin'))), [true, false, true]);
    const pred = (phase: 'begin' | 'progress' | 'lock' | 'end'): StreamEvent => ({
      type: 'prediction', phase, predictionId: 'x', title: 'T', outcomes: [], status: '', winningOutcomeId: null, locksAt: null,
    });
    assert.deepEqual(['begin', 'progress', 'lock', 'end'].map((p) => shouldForward(pred(p as 'begin'))), [true, false, false, true]);
  });

  test('Hype Train nur, wenn er beendet ist – ohne Namen der Top-Spender', () => {
    const train = (phase: 'begin' | 'progress' | 'end'): StreamEvent => ({
      type: 'hypetrain', phase, level: 3, total: 4200, progress: 0, goal: 0,
      topContributions: [{ user: USER, type: 'bits', total: 1000 }], expiresAt: null, trainType: 'regular',
    } as StreamEvent);
    assert.deepEqual(['begin', 'progress', 'end'].map((p) => shouldForward(train(p as 'begin'))), [false, false, true]);
    const data = toSuiteEvent(train('end'), { id: 'h', at: 1 }).data;
    assert.equal('topContributions' in data, false);
    assert.equal(data.level, 3);
  });

  test('data ohne type/test, effect nur bei Einlösungen', () => {
    const e = toSuiteEvent(redemption(), { id: 'id1', at: 5, effect: { group: 'HudFX', foreign: true } });
    assert.deepEqual(e, {
      id: 'id1', at: 5, type: 'redemption', effect: { group: 'HudFX', foreign: true },
      data: { redemptionId: 'r1', user: USER, reward: { id: 'reward-1', title: 'Jumpscare', cost: 500 }, input: '', status: 'unfulfilled' },
    });
    assert.equal(toSuiteEvent(redemption(), { id: 'x', at: 1 }).effect, null);
    assert.equal('effect' in toSuiteEvent({ type: 'follow', user: USER }, { id: 'x', at: 1 }), false);
  });

  test('alert_shown zeigt auf das Event – auch bei einer Kopie', () => {
    const ids = new EventIds();
    const original = redemption('r9');
    ids.remember(original, 'id-9');
    assert.equal(ids.find(original), 'id-9');
    assert.equal(ids.find(structuredClone(original)), 'id-9');
    assert.equal(ids.find(redemption('anders')), null);
    const shown = alertShownEvent({ id: 's', at: 7, ref: 'id-9', variant: 'Gruselig', event: original, category: 'channelpoints' });
    assert.equal(shown.type, 'alert_shown');
    assert.equal(shown.ref, 'id-9');
    assert.equal(shown.variant, 'Gruselig');
  });
});

describe('UwUClip: Gruppe einer Belohnung (effect)', () => {
  const groups = [
    { name: 'Sounds', rewardIds: ['a', 'b'] },
    { name: 'HudFX', foreign: true, rewardIds: ['b', 'c'] },
    { name: 'Lumia', foreign: true, rewardIds: ['d'] },
  ];
  test('in keiner Gruppe → null', () => assert.equal(effectOf(groups, [], 'zzz'), null));
  test('HudFX gewinnt vor anderen Gruppen', () => assert.deepEqual(effectOf(groups, [], 'b'), { group: 'HudFX', foreign: true }));
  test('eigene Gruppe ohne „andere App“', () => assert.deepEqual(effectOf(groups, [], 'a'), { group: 'Sounds', foreign: false }));
  test('einzeln als „andere App“ markiert', () => assert.deepEqual(effectOf(groups, ['a'], 'a'), { group: 'Sounds', foreign: true }));
});

// ------------------------------------------------------------------ Warteschlange

describe('UwUClip: Warteschlange', () => {
  test('wird gespeichert und nach einem Neustart wieder geladen', async () => {
    const first = makeForwarder({ config: null });
    first.fw.enqueue(suiteEvent('a', first.getNow()));
    first.fw.enqueue(suiteEvent('b', first.getNow()));
    first.fw.stop();
    const second = makeForwarder({ file: first.file });
    assert.equal(second.fw.status().queued, 2);
    await second.fw.flush();
    assert.deepEqual(second.server.calls[0].batch.events.map((e) => e.id), ['a', 'b']);
    assert.equal(second.fw.status().queued, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(first.file, 'utf8')).events, []);
  });

  test('Events älter als 7 Tage fallen weg', async () => {
    const { fw, server, getNow } = makeForwarder();
    fw.enqueue(suiteEvent('alt', getNow() - MAX_AGE_MS - 1));
    fw.enqueue(suiteEvent('neu', getNow()));
    await fw.flush();
    assert.deepEqual(server.calls[0].batch.events.map((e) => e.id), ['neu']);
    assert.equal(fw.status().dropped, 1);
  });

  test(`höchstens ${MAX_OUTBOX} Events, die ältesten fallen weg; max. 1000 pro Anfrage`, async () => {
    const { fw, server, getNow } = makeForwarder();
    for (let i = 0; i < MAX_OUTBOX + 5; i++) fw.enqueue(suiteEvent(`e${i}`, getNow()));
    assert.equal(fw.status().queued, MAX_OUTBOX);
    assert.equal(fw.status().dropped, 5);
    await fw.flush();
    assert.equal(server.calls.length, MAX_OUTBOX / 1000);
    assert.ok(server.calls.every((c) => c.batch.events.length === 1000));
    assert.equal(server.calls[0].batch.events[0].id, 'e5');
    assert.equal(fw.status().queued, 0);
  });

  test('aus / nicht eingerichtet → nichts senden', async () => {
    const { fw, server, getNow } = makeForwarder({ config: null });
    fw.enqueue(suiteEvent('a', getNow()));
    await fw.flush();
    assert.equal(server.calls.length, 0);
    assert.equal(fw.status().state, 'off');
  });
});

// ------------------------------------------------------------------ Fehler

describe('UwUClip: Fehler und Wiederholen', () => {
  test('Netzwerkfehler/5xx: wachsende Wartezeit bis max. 5 Min., danach weiter', async () => {
    const { fw, server, tick, getNow } = makeForwarder({ statuses: ['network', 503, 200] });
    fw.enqueue(suiteEvent('a', getNow()));
    await fw.flush();
    assert.equal(fw.status().state, 'retrying');
    assert.equal(fw.status().nextAttemptAt, getNow() + backoffDelay(1));
    await fw.flush(); // noch in der Wartezeit → kein Versuch
    assert.equal(server.calls.length, 1);
    tick(backoffDelay(1));
    await fw.flush();
    assert.equal(server.calls.length, 2);
    assert.equal(fw.status().nextAttemptAt, getNow() + backoffDelay(2));
    tick(backoffDelay(2));
    await fw.flush();
    assert.equal(fw.status().state, 'connected');
    assert.equal(fw.status().queued, 0);
    assert.equal(fw.status().lastError, null);
    assert.equal(backoffDelay(50), BACKOFF_MAX_MS);
    assert.ok(backoffDelay(2) > backoffDelay(1));
  });

  test('401/403: pausiert ohne erneute Versuche, bis resume()', async () => {
    for (const status of [401, 403]) {
      const { fw, server, tick, getNow } = makeForwarder({ statuses: [status, 200] });
      fw.enqueue(suiteEvent('a', getNow()));
      await fw.flush();
      assert.equal(fw.status().state, 'paused');
      assert.match(fw.status().lastError ?? '', new RegExp(`\\(${status}\\)`));
      tick(60 * 60 * 1000);
      await fw.flush();
      assert.equal(server.calls.length, 1);
      fw.resume();
      await fw.flush();
      assert.equal(server.calls.length, 2);
      assert.equal(fw.status().queued, 0);
    }
  });

  test('400/413: kleinere Pakete, ein einzelnes abgelehntes Event fällt weg', async () => {
    const { fw, server, getNow } = makeForwarder({ statuses: [413, 200, 400, 200] });
    for (const id of ['a', 'b', 'c', 'd']) fw.enqueue(suiteEvent(id, getNow()));
    await fw.flush();
    // 4 → 413 → 2 (ok) → Rest 2 → 400 → 1 (ok) → 1 (ok)
    assert.deepEqual(server.calls.map((c) => c.batch.events.length), [4, 2, 2, 1, 1]);
    assert.equal(fw.status().queued, 0);

    const single = makeForwarder({ statuses: [400, 400, 200] });
    single.fw.enqueue(suiteEvent('kaputt', single.getNow()));
    single.fw.enqueue(suiteEvent('gut', single.getNow()));
    await single.fw.flush();
    assert.deepEqual(single.server.calls.map((c) => c.batch.events.map((e) => e.id)), [['kaputt', 'gut'], ['kaputt'], ['gut']]);
    assert.equal(single.fw.status().dropped, 1);
    assert.equal(single.fw.status().queued, 0);
  });

  test('Verbindung testen: leeres Paket, Antwort und Fehler', async () => {
    const ok = makeForwarder();
    assert.deepEqual(await ok.fw.test(), { ok: true, status: 200, accepted: 0, dropped: 0 });
    assert.deepEqual(ok.server.calls[0].batch.events, []);
    const denied = makeForwarder({ statuses: [403] });
    const res = await denied.fw.test();
    assert.equal(res.ok, false);
    assert.equal(res.ok === false && res.status, 403);
    const down = makeForwarder({ statuses: ['network'] });
    const err = await down.fw.test();
    assert.equal(err.ok === false && err.error, 'Server nicht erreichbar (ECONNREFUSED)');
    const empty = makeForwarder({ config: null });
    assert.equal((await empty.fw.test()).ok, false);
    assert.equal(empty.server.calls.length, 0);
  });
});
