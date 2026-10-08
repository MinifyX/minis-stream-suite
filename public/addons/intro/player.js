// Intro-Player: läuft als OBS-Browserquelle und spielt die Sequenz ab.
//
// - Ton ist die Master-Uhr: alle WAVs werden vorab dekodiert und per Web Audio sample-genau
//   geplant (AudioBufferSourceNode.start(when)). Loops werden pro Durchlauf neu eingeplant,
//   jeweils exakt am Ende des vorigen – so kennt der Sequencer jede Loop-Grenze.
// - Bild: zwei <video>-Elemente im Wechsel. Das nächste Segment wartet unsichtbar auf Frame 0
//   und wird umgeschaltet, sobald die HÖRBARE Audio-Zeit seine Startzeit erreicht.
// - Drift-Korrektur: Video gegen Audio-Uhr messen, > 40 ms → nachziehen, sonst playbackRate ±2 %.
// - Die Ablaufsteuerung (Zustände, Trigger, Quantisierung) steckt in sequencer.js.
(() => {
  const { Sequencer, SEGMENTS } = window.IntroSequencer;

  const DEBUG = new URLSearchParams(location.search).has('debug');
  /**
   * So viele Sekunden vor einer Grenze wird das nächste Segment eingeplant. Großzügig, damit auch ein
   * kurz gedrosselter Timer (Browser im Hintergrund) nie zu spät einplant – Trigger werden trotzdem
   * bis kurz vor der Grenze umgeplant (Sequencer.minReplan).
   */
  const LOOKAHEAD = 2.0;
  const TICK_MS = 20;
  const DRIFT_EVERY_MS = 1000;
  /** Ab dieser Abweichung wird das Video hart nachgezogen */
  const DRIFT_SEEK = 0.04;
  const RATE_MAX = 0.02;
  const FADE_S = 1;

  const stage = document.getElementById('stage');
  const videos = [document.getElementById('video-a'), document.getElementById('video-b')];
  const overlay = document.getElementById('overlay');
  const overlayText = document.getElementById('overlay-text');
  const debugBox = document.getElementById('debug');
  const loadingBox = document.getElementById('loading');

  let ws = null;
  /** Nachrichten, die bei einer Verbindungslücke nicht verloren gehen dürfen */
  const outbox = [];

  let config = null;
  let configKey = '';
  /** Neue Konfiguration, die erst nach dem laufenden Intro geladen wird */
  let pendingConfig = null;

  let audioCtx = null;
  let master = null;
  let buffers = {};
  let videoUrls = {};
  let seq = null;
  let ready = false;
  let loaded = 0;
  let total = 0;
  let loadError = null;
  let loadRun = 0;
  /** „start“ kam vor „ready“ → wird danach ausgeführt */
  let startQueued = false;

  /** entry.id → AudioBufferSourceNode */
  const sources = new Map();
  let activeVideo = null;
  let stopTimer = null;
  let lastDrift = 0;
  let maxDrift = 0;

  // ============================================================ Verbindung zur Suite

  function send(message, keep = false) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    else if (keep) outbox.push(message);
  }

  function sendStatus() {
    send({ type: 'player.status', ready, loaded, total, error: loadError, startQueued });
    renderLoading();
  }

  function sendState() {
    if (!seq) {
      send({ type: 'intro.state', state: 'IDLE', pendingTrigger: null, segment: null, nextBoundaryInMs: null });
      return;
    }
    // Zustand ersetzt ältere Zustände im Puffer
    const message = { type: 'intro.state', ...seq.snapshot(audioCtx.currentTime) };
    for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].type === 'intro.state') outbox.splice(i, 1);
    send(message, true);
  }

  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws?channel=intro.player`);
    ws.onopen = () => {
      while (outbox.length) ws.send(JSON.stringify(outbox.shift()));
      sendStatus();
      sendState();
    };
    ws.onmessage = (m) => {
      let msg;
      try {
        msg = JSON.parse(m.data);
      } catch {
        return;
      }
      if (msg.type === 'intro.cmd') onCommand(msg.id, msg.action);
      if (msg.type === 'intro.config') onConfig(msg, false);
      if (msg.type === 'intro.reload') onConfig(config, true);
      // Addon wurde neu eingeschaltet → Zustand neu melden
      if (msg.type === 'intro.hello') {
        sendStatus();
        sendState();
      }
    };
    ws.onclose = () => setTimeout(connect, 2000);
  }

  // ============================================================ Laden

  function isRunning() {
    return !!seq && seq.state !== 'IDLE' && seq.state !== 'DONE';
  }

  function onConfig(next, force) {
    if (!next) return;
    const key = JSON.stringify(next.segments);
    if (!force && key === configKey && (ready || loadError === null)) return;
    if (isRunning()) {
      pendingConfig = next;
      return;
    }
    void load(next);
  }

  function heardTime() {
    // Wann ist welcher Teil des Tons wirklich zu hören? getOutputTimestamp berücksichtigt die Ausgabe-Latenz.
    const ts = audioCtx.getOutputTimestamp ? audioCtx.getOutputTimestamp() : null;
    if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
      return ts.contextTime + (performance.now() - ts.performanceTime) / 1000;
    }
    return audioCtx.currentTime - (audioCtx.outputLatency || audioCtx.baseLatency || 0);
  }

  async function fetchChecked(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${decodeURIComponent(url.split('/').pop())}: ${res.status === 404 ? 'Datei nicht gefunden' : `HTTP ${res.status}`}`);
    return res;
  }

  async function load(next) {
    const run = ++loadRun;
    config = next;
    configKey = JSON.stringify(next.segments);
    pendingConfig = null;
    if (seq) seq.reset();
    seq = null;
    ready = false;
    loadError = null;
    loaded = 0;
    // Video ist optional (leer = schwarzes Bild)
    total = SEGMENTS.length + SEGMENTS.filter((id) => next.segments[id].video).length;
    for (const url of Object.values(videoUrls)) URL.revokeObjectURL(url);
    videoUrls = {};
    buffers = {};
    for (const v of videos) {
      v.removeAttribute('src');
      v.dataset.segment = '';
      v.load();
    }
    sendStatus();

    if (!audioCtx) {
      // 48 kHz wie die WAVs → kein Umrechnen, Loop-Grenzen bleiben sample-genau
      try {
        audioCtx = new AudioContext({ latencyHint: 'playback', sampleRate: 48000 });
      } catch {
        audioCtx = new AudioContext({ latencyHint: 'playback' });
      }
      master = audioCtx.createGain();
      master.connect(audioCtx.destination);
    }

    const nextBuffers = {};
    const nextVideos = {};
    try {
      await Promise.all(SEGMENTS.flatMap((id) => [
        (async () => {
          const data = await (await fetchChecked(next.segments[id].audio)).arrayBuffer();
          nextBuffers[id] = await audioCtx.decodeAudioData(data).catch(() => {
            throw new Error(`${id}: Audio konnte nicht gelesen werden (WAV erwartet)`);
          });
          loaded++;
          if (run === loadRun) sendStatus();
        })(),
        (async () => {
          if (!next.segments[id].video) return;
          // Ganzes Video in den Speicher – keine Nachlade-Ruckler während des Intros
          const blob = await (await fetchChecked(next.segments[id].video)).blob();
          nextVideos[id] = URL.createObjectURL(blob);
          loaded++;
          if (run === loadRun) sendStatus();
        })(),
      ]));
    } catch (err) {
      for (const url of Object.values(nextVideos)) URL.revokeObjectURL(url);
      if (run !== loadRun) return;
      loadError = err.message;
      // Ein vorgemerkter Start darf nicht später von selbst losgehen, wenn die Dateien repariert sind
      startQueued = false;
      sendStatus();
      return;
    }
    if (run !== loadRun) {
      for (const url of Object.values(nextVideos)) URL.revokeObjectURL(url);
      return;
    }

    buffers = nextBuffers;
    videoUrls = nextVideos;
    const durations = Object.fromEntries(SEGMENTS.map((id) => [id, buffers[id].duration]));
    // Vorlauf nie länger als 40 % des kürzesten Segments: sonst würde das übernächste Video
    // das nächste überschreiben, bevor es sichtbar war (Sequencer erzwingt mind. 0,2 s)
    const lookahead = Math.min(LOOKAHEAD, Math.min(...Object.values(durations)) * 0.4);
    seq = new Sequencer({ durations, lookahead, startDelay: 0.3 })
      .on('schedule', onSchedule)
      .on('cancel', onCancel)
      .on('state', onState)
      .on('stop', onStop)
      .on('done', (reason) => send({ type: 'intro.done', reason }, true));
    ready = true;
    sendStatus();
    sendState();

    if (startQueued) {
      startQueued = false;
      await audioCtx.resume().catch(() => {});
      seq.command('start', audioCtx.currentTime);
      sendStatus();
    }
  }

  // ============================================================ Befehle

  async function onCommand(id, action) {
    // Ack auch bei kurzer Verbindungslücke zustellen – der Befehl ist ja ausgeführt
    const ack = (result) => send({ type: 'ack', id, ...result }, true);
    if (!ready) {
      if (action === 'start' && !loadError) {
        startQueued = true;
        sendStatus();
        return ack({ ok: true, queued: true });
      }
      if (action === 'reset') {
        startQueued = false;
        sendStatus();
        return ack({ ok: true });
      }
      return ack({ ok: false, error: loadError ? `Der Player konnte nicht alles laden: ${loadError}` : 'Der Player lädt noch die Dateien.' });
    }
    // OBS erlaubt Ton ohne Klick; in einem normalen Browser kann der AudioContext noch pausiert sein
    if (audioCtx.state !== 'running') await audioCtx.resume().catch(() => {});
    if (audioCtx.state !== 'running' && action === 'start') {
      return ack({ ok: false, error: 'Der Browser blockiert den Ton – einmal in die Player-Seite klicken (in OBS passiert das nicht).' });
    }
    ack(seq.command(action, audioCtx.currentTime));
  }

  // ============================================================ Ton & Bild einplanen

  function onSchedule(entry) {
    const source = audioCtx.createBufferSource();
    source.buffer = buffers[entry.segment];
    source.connect(master);
    source.start(entry.start);
    source.onended = () => sources.delete(entry.id);
    sources.set(entry.id, source);
    prepareVideo(entry);
  }

  function onCancel(entry) {
    const source = sources.get(entry.id);
    if (source) {
      try {
        source.stop();
      } catch {
        // schon gestoppt
      }
      sources.delete(entry.id);
    }
    for (const v of videos) if (v.entry === entry) v.entry = null;
  }

  /** Nächstes Segment im unsichtbaren Element auf Frame 0 bereitlegen */
  function prepareVideo(entry) {
    const el = videos.find((v) => v !== activeVideo) ?? videos[0];
    el.entry = entry;
    el.pause();
    el.playbackRate = 1;
    if (el.dataset.segment !== entry.segment) {
      el.dataset.segment = entry.segment;
      if (videoUrls[entry.segment]) el.src = videoUrls[entry.segment];
      else {
        // Kein Video für dieses Segment → Element bleibt leer (schwarz)
        el.removeAttribute('src');
        el.load();
      }
    } else if (videoUrls[entry.segment]) {
      el.currentTime = 0;
    }
  }

  /** Am Segmentstart: vorbereitetes Element sichtbar machen und abspielen */
  function switchTo(el, heard) {
    if (videoUrls[el.entry.segment]) {
      const offset = heard - el.entry.start;
      if (offset > 0.02) el.currentTime = offset;
      el.playbackRate = 1;
      el.play().catch(() => {});
    }
    el.classList.add('active');
    const old = activeVideo;
    activeVideo = el;
    if (old && old !== el) {
      old.classList.remove('active');
      old.pause();
      old.entry = null;
    }
    const text = config.segments[el.entry.segment]?.overlayText ?? '';
    if (text) overlayText.textContent = text;
    overlay.classList.toggle('show', !!text);
    // Kurz nach dem Umschalten einmal messen (Anlaufzeit des Decoders)
    setTimeout(correctDrift, 300);
  }

  function checkSwitch() {
    if (!seq || !audioCtx) return;
    const heard = heardTime();
    for (const v of videos) {
      if (v.entry && v !== activeVideo && heard >= v.entry.start - 0.004) switchTo(v, heard);
    }
  }

  function correctDrift() {
    const el = activeVideo;
    if (!el || !el.entry || el.paused) return;
    const expected = heardTime() - el.entry.start;
    if (expected < 0 || (el.duration && expected > el.duration)) return;
    const diff = el.currentTime - expected;
    lastDrift = diff;
    maxDrift = Math.max(maxDrift, Math.abs(diff));
    if (Math.abs(diff) > DRIFT_SEEK) {
      el.currentTime = expected;
      el.playbackRate = 1;
    } else {
      // Video voraus → etwas langsamer, hinterher → etwas schneller
      el.playbackRate = 1 - Math.max(-RATE_MAX, Math.min(RATE_MAX, diff / 2));
    }
  }

  function onState() {
    sendState();
    // Neue Dateien erst laden, wenn nichts mehr läuft – auch nicht das Ausblenden nach „abort“
    if (pendingConfig && !isRunning() && !stopTimer) setTimeout(() => onConfig(pendingConfig, true), 0);
  }

  function stopNow() {
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = null;
    for (const source of sources.values()) {
      try {
        source.stop();
      } catch {
        // schon gestoppt
      }
    }
    sources.clear();
    for (const v of videos) {
      v.pause();
      v.classList.remove('active');
      v.entry = null;
    }
    activeVideo = null;
    overlay.classList.remove('show');
    master.gain.cancelScheduledValues(audioCtx.currentTime);
    master.gain.setValueAtTime(1, audioCtx.currentTime);
    stage.classList.remove('black');
    if (pendingConfig && !isRunning()) setTimeout(() => onConfig(pendingConfig, true), 0);
  }

  function onStop(fade) {
    if (!fade) return stopNow();
    // Notausstieg: Ton über 1 s ausblenden, Bild auf Schwarz
    const now = audioCtx.currentTime;
    master.gain.cancelScheduledValues(now);
    master.gain.setValueAtTime(master.gain.value, now);
    master.gain.linearRampToValueAtTime(0, now + FADE_S);
    stage.classList.add('black');
    overlay.classList.remove('show');
    stopTimer = setTimeout(stopNow, FADE_S * 1000 + 50);
  }

  // ============================================================ Takt

  setInterval(() => {
    if (!seq || !audioCtx) return;
    seq.tick(audioCtx.currentTime);
    checkSwitch();
  }, TICK_MS);

  setInterval(correctDrift, DRIFT_EVERY_MS);

  function frame() {
    checkSwitch();
    if (DEBUG) renderDebug();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // ============================================================ Anzeige (nur ?debug=1)

  function renderLoading() {
    if (!DEBUG) return;
    loadingBox.textContent = loadError ? `⚠ ${loadError}` : ready ? '' : `Lade ${loaded}/${total} …`;
  }

  function renderDebug() {
    debugBox.style.display = 'block';
    if (!seq) {
      debugBox.textContent = ready ? 'bereit' : loadError ? `Fehler: ${loadError}` : `lade ${loaded}/${total}`;
      return;
    }
    const snap = seq.snapshot(audioCtx.currentTime);
    debugBox.textContent = [
      `Zustand:  ${snap.state}${snap.pendingTrigger ? `  (vorgemerkt: ${snap.pendingTrigger})` : ''}`,
      `Grenze:   ${snap.nextBoundaryInMs === null ? '–' : `${(snap.nextBoundaryInMs / 1000).toFixed(2)} s`}`,
      `Audio:    ${audioCtx.state}, Latenz ${Math.round((audioCtx.outputLatency || 0) * 1000)} ms`,
      `Versatz:  ${Math.round(lastDrift * 1000)} ms (max ${Math.round(maxDrift * 1000)} ms)`,
      `Rate:     ${activeVideo ? activeVideo.playbackRate.toFixed(3) : '–'}`,
    ].join('\n');
  }

  // Messwerte für Tests (nur ?debug=1)
  if (DEBUG) window.introDebug = () => ({ state: seq?.state, lastDriftMs: Math.round(lastDrift * 1000), maxDriftMs: Math.round(maxDrift * 1000), rate: activeVideo?.playbackRate });

  // Im normalen Browser braucht Ton einen Klick
  document.addEventListener('click', () => audioCtx?.resume());

  // ============================================================ Start

  fetch('/api/addons/intro/player-config')
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
    .then((cfg) => onConfig(cfg, true))
    .catch((err) => {
      loadError = `Konfiguration nicht erreichbar (${err.message}). Ist das Addon „Intro-Sequenz“ aktiv?`;
      sendStatus();
    });
  connect();
})();
