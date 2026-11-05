import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildReport, enqueue, INTERVAL_MINUTES, linkCode, normalizeUrl } from './report';

describe('Watchtime', () => {
  test('erkennt nur gültige Codes', () => {
    assert.equal(linkCode('!discord 123456'), '123456');
    assert.equal(linkCode('  !DISCORD   123456 '), '123456');
    assert.equal(linkCode('!discord 12345'), null);
    assert.equal(linkCode('hallo !discord 123456'), null);
  });

  test('zählt jeden Login einmal', () => {
    const r = buildReport('a', ['Fan', 'fan', 'other'], []);
    assert.deepEqual(r.viewers, [{ login: 'fan', minutes: INTERVAL_MINUTES }, { login: 'other', minutes: INTERVAL_MINUTES }]);
  });

  test('begrenzt die Warteschlange und wirft die ältesten weg', () => {
    let q = [buildReport('0', [], [])];
    for (let i = 1; i < 30; i++) q = enqueue(q, buildReport(String(i), [], []));
    assert.equal(q.length, 24);
    assert.equal(q.at(-1)?.id, '29');
  });

  test('lässt nur http und https zu', () => {
    assert.equal(normalizeUrl(' http://192.168.70.70:8790/x '), 'http://192.168.70.70:8790');
    assert.throws(() => normalizeUrl('file:///etc/passwd'));
  });
});
