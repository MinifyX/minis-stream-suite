import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';

// Der Sequencer ist reines Browser-JS (läuft im Intro-Player), wir testen genau diese Datei.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Sequencer } = require(path.join(__dirname, '..', '..', '..', 'public', 'addons', 'intro', 'sequencer.js'));

interface Entry {
  id: number;
  segment: string | null;
  start: number;
  end: number;
  consumes: boolean;
}

const DURATIONS = { intro: 4, loop1: 2, main: 6, loop2: 2, outro: 3 };

/** Sequencer mit Protokoll: welche Segmente wann wirklich angefangen haben */
function setup(options: Record<string, number> = {}) {
  const seq = new Sequencer({ durations: DURATIONS, lookahead: 0.5, minReplan: 0.08, startDelay: 0.1, ...options });
  const begun: Array<{ segment: string; start: number }> = [];
  const scheduled: Entry[] = [];
  const cancelled: Entry[] = [];
  const done: string[] = [];
  const stops: boolean[] = [];
  seq
    .on('begin', (e: Entry) => begun.push({ segment: e.segment!, start: e.start }))
    .on('schedule', (e: Entry) => scheduled.push(e))
    .on('cancel', (e: Entry) => cancelled.push(e))
    .on('done', (reason: string) => done.push(reason))
    .on('stop', (fade: boolean) => stops.push(fade));
  let now = 0;
  /** Zeit in kleinen Schritten vorspulen (wie der Player-Takt) */
  const advance = (seconds: number) => {
    const target = now + seconds;
    while (now < target - 1e-9) {
      now = Math.min(target, now + 0.02);
      seq.tick(now);
    }
  };
  const at = () => now;
  return { seq, begun, scheduled, cancelled, done, stops, advance, at };
}

describe('Intro-Sequencer', () => {
  it('läuft ohne Trigger: intro → loop1 wiederholt sich', () => {
    const t = setup();
    assert.deepEqual(t.seq.command('start', t.at()), { ok: true });
    t.advance(4.1 + 2 * 3 + 0.5);
    assert.deepEqual(t.begun.map((b) => b.segment), ['intro', 'loop1', 'loop1', 'loop1', 'loop1']);
    assert.equal(t.seq.state, 'LOOP1');
  });

  it('plant lückenlos: jedes Segment beginnt genau am Ende des vorigen', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(1);
    t.seq.command('go', t.at());
    t.advance(20);
    for (let i = 1; i < t.scheduled.length; i++) {
      const prev = t.scheduled[i - 1];
      assert.equal(t.scheduled[i].start, prev.end, `${t.scheduled[i].segment} schließt nicht an ${prev.segment} an`);
    }
  });

  it('„go“ während LOOP1 wechselt erst an der nächsten Loop-Grenze', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(4.1 + 0.7); // mitten im ersten loop1-Durchlauf (Start 4.1, Ende 6.1)
    assert.equal(t.seq.state, 'LOOP1');
    assert.deepEqual(t.seq.command('go', t.at()), { ok: true });
    assert.equal(t.seq.state, 'LOOP1', 'darf nicht sofort wechseln');
    assert.equal(t.seq.pending, 'go');
    t.advance(1.2); // 6.0 – kurz vor der Grenze
    assert.equal(t.seq.state, 'LOOP1');
    t.advance(0.15);
    assert.equal(t.seq.state, 'MAIN');
    const main = t.begun.find((b) => b.segment === 'main')!;
    assert.ok(Math.abs(main.start - 6.1) < 1e-9, `main beginnt bei ${main.start} statt 6.1`);
    assert.equal(t.seq.pending, null);
  });

  it('„go“ kurz vor der Grenze plant den schon eingeplanten Loop um', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(4.1 + 1.7); // 0,3 s vor der Grenze, loop1 ist schon wieder eingeplant
    assert.equal(t.scheduled.at(-1)!.segment, 'loop1');
    t.seq.command('go', t.at());
    assert.equal(t.cancelled.length, 1);
    assert.equal(t.scheduled.at(-1)!.segment, 'main');
    t.advance(0.5);
    assert.equal(t.seq.state, 'MAIN');
  });

  it('„go“ zu knapp vor der Grenze gilt für die übernächste Grenze', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(4.1 + 1.96); // nur noch 0,04 s
    t.seq.command('go', t.at());
    assert.equal(t.cancelled.length, 0);
    t.advance(0.1);
    assert.equal(t.seq.state, 'LOOP1', 'noch ein Durchlauf');
    t.advance(2);
    assert.equal(t.seq.state, 'MAIN');
  });

  it('„go“ während INTRO → LOOP1 läuft genau einmal, dann MAIN', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(1);
    assert.equal(t.seq.state, 'INTRO');
    assert.deepEqual(t.seq.command('go', t.at()), { ok: true });
    t.advance(4 + 2 + 1);
    assert.deepEqual(t.begun.map((b) => b.segment), ['intro', 'loop1', 'main']);
  });

  it('„outro“ während MAIN → LOOP2 läuft genau einmal, dann OUTRO, dann DONE', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(1);
    t.seq.command('go', t.at());
    t.advance(4 + 2 + 1); // in MAIN
    assert.equal(t.seq.state, 'MAIN');
    assert.deepEqual(t.seq.command('outro', t.at()), { ok: true });
    t.advance(6 + 2 + 3);
    assert.deepEqual(t.begun.map((b) => b.segment), ['intro', 'loop1', 'main', 'loop2', 'outro']);
    assert.equal(t.seq.state, 'DONE');
    assert.deepEqual(t.done, ['completed']);
  });

  it('„cancel-pending“ nimmt einen vorgemerkten Trigger zurück', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(1);
    t.seq.command('go', t.at());
    assert.equal(t.seq.pending, 'go');
    assert.deepEqual(t.seq.command('cancel-pending', t.at()), { ok: true });
    assert.equal(t.seq.pending, null);
    t.advance(4 + 2 * 3);
    assert.ok(!t.begun.some((b) => b.segment === 'main'));
  });

  it('„cancel-pending“ macht einen schon eingeplanten Wechsel rückgängig', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(4.1 + 0.5);
    t.seq.command('go', t.at());
    t.advance(1.2); // MAIN ist jetzt eingeplant
    assert.equal(t.scheduled.at(-1)!.segment, 'main');
    t.seq.command('cancel-pending', t.at());
    assert.equal(t.scheduled.at(-1)!.segment, 'loop1');
    t.advance(1);
    assert.equal(t.seq.state, 'LOOP1');
  });

  it('lehnt Trigger im falschen Zustand ab', () => {
    const t = setup();
    assert.equal(t.seq.command('go', t.at()).ok, false);
    t.seq.command('start', t.at());
    t.advance(1);
    assert.equal(t.seq.command('outro', t.at()).ok, false);
    assert.equal(t.seq.command('start', t.at()).ok, false);
    assert.equal(t.seq.command('cancel-pending', t.at()).ok, false);
  });

  for (const target of ['INTRO', 'LOOP1', 'MAIN', 'LOOP2', 'OUTRO']) {
    it(`„abort“ aus ${target} → DONE mit Ausblenden und done(aborted)`, () => {
      const t = setup();
      t.seq.command('start', t.at());
      for (let i = 0; i < 400 && t.seq.state !== target; i++) {
        t.advance(0.1);
        if (t.seq.state === 'LOOP1') t.seq.command('go', t.at());
        if (t.seq.state === 'LOOP2') t.seq.command('outro', t.at());
      }
      assert.equal(t.seq.state, target);
      assert.deepEqual(t.seq.command('abort', t.at()), { ok: true });
      assert.equal(t.seq.state, 'DONE');
      assert.deepEqual(t.done, ['aborted']);
      assert.deepEqual(t.stops, [true]);
      t.advance(10);
      assert.equal(t.seq.state, 'DONE', 'danach passiert nichts mehr');
    });
  }

  it('„reset“ geht zurück auf IDLE und löst nichts aus', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(5);
    assert.deepEqual(t.seq.command('reset', t.at()), { ok: true });
    assert.equal(t.seq.state, 'IDLE');
    assert.deepEqual(t.done, []);
    assert.deepEqual(t.stops, [false]);
    t.advance(10);
    assert.equal(t.seq.state, 'IDLE');
    assert.deepEqual(t.seq.command('start', t.at()), { ok: true }, 'danach neu startbar');
  });

  it('aus DONE startet es erst nach „reset“ wieder', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(1);
    t.seq.command('abort', t.at());
    assert.equal(t.seq.command('start', t.at()).ok, false);
    t.seq.command('reset', t.at());
    assert.equal(t.seq.command('start', t.at()).ok, true);
  });

  it('meldet die Restzeit bis zur nächsten Grenze', () => {
    const t = setup();
    t.seq.command('start', t.at());
    t.advance(4.1 + 0.5);
    assert.equal(t.seq.snapshot(t.at()).nextBoundaryInMs, 1500);
  });
});
