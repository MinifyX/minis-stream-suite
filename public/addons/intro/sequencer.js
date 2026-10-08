// Ablaufsteuerung der Intro-Sequenz – ohne Audio, Video oder DOM, damit sie testbar ist
// (src/addons/intro/sequencer.test.ts lädt genau diese Datei).
//
// Zustände: IDLE → INTRO → LOOP1 → MAIN → LOOP2 → OUTRO → DONE
//
// Die Zeit kommt immer von außen (`now` in Sekunden, im Player die Uhr des AudioContext).
// Der Sequencer plant das jeweils nächste Segment `lookahead` Sekunden vor der Grenze ein
// und meldet das über Ereignisse. Der Player setzt sie in Ton und Bild um:
//   schedule(entry)  Segment ab entry.start einplanen (Ton sample-genau, Video vorbereiten)
//   cancel(entry)    eingeplantes Segment wieder verwerfen (noch nicht gestartet)
//   begin(entry)     Segment hat angefangen → Zustand hat sich geändert
//   state()          Zustand oder vorgemerkter Trigger hat sich geändert
//   done(reason)     fertig ('completed') oder Notausstieg ('aborted')
//   stop(fade)       alles anhalten (fade = true: über 1 s ausblenden)
//
// entry = { id, segment, start, end, consumes }  (segment null = Ende der Sequenz)
(function (root) {
  'use strict';

  const SEGMENTS = ['intro', 'loop1', 'main', 'loop2', 'outro'];
  const STATE_OF = { intro: 'INTRO', loop1: 'LOOP1', main: 'MAIN', loop2: 'LOOP2', outro: 'OUTRO' };
  /** Welcher Trigger einen Loop beendet */
  const LOOP_EXIT = { loop1: 'go', loop2: 'outro' };
  /** In welchen Zuständen ein Trigger angenommen (bzw. vorgemerkt) wird */
  const TRIGGER_STATES = { go: ['INTRO', 'LOOP1'], outro: ['MAIN', 'LOOP2'] };

  /** Was kommt nach `segment`? consumes = der vorgemerkte Trigger ist damit erledigt */
  function nextAfter(segment, pending) {
    switch (segment) {
      case 'intro': return { segment: 'loop1', consumes: false };
      case 'loop1': return pending === 'go' ? { segment: 'main', consumes: true } : { segment: 'loop1', consumes: false };
      case 'main': return { segment: 'loop2', consumes: false };
      case 'loop2': return pending === 'outro' ? { segment: 'outro', consumes: true } : { segment: 'loop2', consumes: false };
      default: return { segment: null, consumes: false };
    }
  }

  class Sequencer {
    /**
     * @param {{ durations: Record<string, number>, lookahead?: number, minReplan?: number, startDelay?: number }} options
     *   durations: Länge jedes Segments in Sekunden (aus dem dekodierten Audio)
     *   lookahead: so viele Sekunden vor einer Grenze wird das nächste Segment eingeplant (mind. 0,2 s)
     *   minReplan: bis so kurz vor einer Grenze darf eine Planung noch geändert werden
     */
    constructor(options) {
      this.durations = options.durations;
      this.lookahead = Math.max(0.2, options.lookahead ?? 1);
      this.minReplan = options.minReplan ?? 0.08;
      this.startDelay = options.startDelay ?? 0.15;
      this.state = 'IDLE';
      this.pending = null;
      this.current = null;
      this.planned = null;
      this.nextId = 1;
      this.handlers = {};
    }

    on(name, handler) {
      this.handlers[name] = handler;
      return this;
    }

    emit(name, ...args) {
      const handler = this.handlers[name];
      if (handler) handler(...args);
    }

    /** Millisekunden bis zur nächsten Segmentgrenze (oder null) */
    nextBoundaryInMs(now) {
      if (this.current) return Math.max(0, Math.round((this.current.end - now) * 1000));
      if (this.planned) return Math.max(0, Math.round((this.planned.start - now) * 1000));
      return null;
    }

    snapshot(now) {
      return {
        state: this.state,
        pendingTrigger: this.pending,
        segment: this.current ? this.current.segment : null,
        nextBoundaryInMs: this.nextBoundaryInMs(now),
      };
    }

    /**
     * Befehl ausführen. Gibt { ok: true } oder { ok: false, error } zurück.
     * action: 'start' | 'go' | 'outro' | 'cancel-pending' | 'abort' | 'reset'
     */
    command(action, now) {
      switch (action) {
        case 'start': return this.start(now);
        case 'go':
        case 'outro': return this.trigger(action, now);
        case 'cancel-pending': return this.cancelPending(now);
        case 'abort': return this.abort();
        case 'reset': return this.reset();
        default: return { ok: false, error: `Unbekannter Befehl „${action}“.` };
      }
    }

    start(now) {
      if (this.state !== 'IDLE') {
        return { ok: false, error: this.state === 'DONE' ? 'Die Sequenz ist fertig – erst „Reset“, dann neu starten.' : 'Die Sequenz läuft schon.' };
      }
      this.pending = null;
      this.current = null;
      this.state = 'INTRO';
      this.plan('intro', now + this.startDelay, false);
      this.emit('state');
      return { ok: true };
    }

    trigger(trigger, now) {
      if (!TRIGGER_STATES[trigger].includes(this.state)) {
        const where = TRIGGER_STATES[trigger].join(' oder ');
        return { ok: false, error: `„${trigger}“ geht nur während ${where} (gerade: ${this.state}).` };
      }
      if (this.pending === trigger) return { ok: true };
      this.pending = trigger;
      this.replan(now);
      this.emit('state');
      return { ok: true };
    }

    cancelPending(now) {
      if (!this.pending) return { ok: false, error: 'Es ist kein Trigger vorgemerkt.' };
      if (this.planned && this.planned.consumes && !this.canReplan(now)) {
        return { ok: false, error: 'Zu spät – der Wechsel startet gleich.' };
      }
      this.pending = null;
      this.replan(now);
      this.emit('state');
      return { ok: true };
    }

    abort() {
      if (this.state === 'IDLE' || this.state === 'DONE') return { ok: false, error: `Es läuft keine Sequenz (gerade: ${this.state}).` };
      this.finish('aborted', true);
      return { ok: true };
    }

    reset() {
      this.state = 'IDLE';
      this.pending = null;
      this.current = null;
      this.planned = null;
      this.emit('stop', false);
      this.emit('state');
      return { ok: true };
    }

    /** Regelmäßig aufrufen (im Player alle ~20 ms) */
    tick(now) {
      // Eingeplantes Ende erreicht → fertig
      if (this.planned && this.planned.segment === null && now >= this.planned.start) {
        this.finish('completed', false);
        return;
      }
      // Eingeplantes Segment hat begonnen
      if (this.planned && this.planned.segment !== null && now >= this.planned.start) {
        const entry = this.planned;
        this.planned = null;
        this.current = entry;
        if (entry.consumes) this.pending = null;
        this.state = STATE_OF[entry.segment];
        this.emit('begin', entry);
        this.emit('state');
      }
      // Kurz vor dem Ende des laufenden Segments das nächste einplanen
      if (this.current && !this.planned && now >= this.current.end - this.lookahead) {
        const next = nextAfter(this.current.segment, this.pending);
        this.plan(next.segment, this.current.end, next.consumes);
      }
    }

    // -------------------------------------------------------------- intern

    plan(segment, start, consumes) {
      const duration = segment ? this.durations[segment] : 0;
      this.planned = { id: this.nextId++, segment, start, end: start + duration, consumes };
      if (segment) this.emit('schedule', this.planned);
    }

    canReplan(now) {
      return !!this.planned && this.planned.start - now > this.minReplan;
    }

    /** Trigger hat sich geändert → noch nicht gestartetes Folgesegment neu bestimmen, wenn Zeit genug ist */
    replan(now) {
      if (!this.current || !this.planned || !this.canReplan(now)) return;
      const next = nextAfter(this.current.segment, this.pending);
      if (next.segment === this.planned.segment && next.consumes === this.planned.consumes) return;
      const old = this.planned;
      this.planned = null;
      if (old.segment) this.emit('cancel', old);
      this.plan(next.segment, old.start, next.consumes);
    }

    finish(reason, fade) {
      this.state = 'DONE';
      this.pending = null;
      this.current = null;
      this.planned = null;
      this.emit('stop', fade);
      this.emit('state');
      this.emit('done', reason);
    }
  }

  const api = { Sequencer, nextAfter, SEGMENTS, STATE_OF, LOOP_EXIT, TRIGGER_STATES };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IntroSequencer = api;
})(typeof window !== 'undefined' ? window : globalThis);
