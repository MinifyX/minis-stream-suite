// Music-Host: spielt die Musik der Suite (lokale Dateien mit Crossfade, Spotify Web Playback SDK).
// Verbunden über den WebSocket-Kanal music.host. Befehle kommen vom Musik-Addon (src/addons/music).
(() => {
  const SDK_URL = 'https://sdk.scdn.co/spotify-player.js';
  const SDK_TIMEOUT_MS = 10_000;
  const STATUS_EVERY_MS = 2000;
  /** Kurzer Übergang bei „Weiter“/„Zurück“ von Hand */
  const MANUAL_FADE_MS = 400;

  const $ = (id) => document.getElementById(id);
  let ws = null;
  /** Welche Wiedergabe gerade dran ist: 'local', 'sdk' oder null */
  let engine = null;

  function send(message) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function setRow(name, level, text) {
    $(`d-${name}`).className = `dot ${level}`;
    $(`v-${name}`).textContent = text;
  }

  // ============================================================ Ton

  const audioCtx = new AudioContext({ latencyHint: 'playback' });
  /** Lautstärke der lokalen Wiedergabe (Spotify regelt das SDK selbst) */
  const localMaster = audioCtx.createGain();
  localMaster.connect(audioCtx.destination);

  /** 0..100 → Verstärkung (quadratisch, klingt gleichmäßiger als linear) */
  const gainOf = (volume) => Math.pow(Math.max(0, Math.min(100, volume)) / 100, 2);

  function renderAudio() {
    const ok = audioCtx.state === 'running';
    $('unlock').hidden = ok;
    setRow('audio', ok ? 'ok' : 'warn', ok ? 'freigegeben' : 'blockiert – bitte oben klicken');
  }

  $('unlock').onclick = async () => {
    await audioCtx.resume().catch(() => {});
    if (sdk.player) sdk.player.activateElement?.();
    renderAudio();
    send({ type: 'host.audio', unlocked: audioCtx.state === 'running' });
  };
  audioCtx.onstatechange = () => {
    renderAudio();
    send({ type: 'host.audio', unlocked: audioCtx.state === 'running' });
  };

  // ============================================================ Lokal: zwei Decks mit Crossfade

  function makeDeck() {
    const audio = new Audio();
    audio.preload = 'auto';
    const gain = audioCtx.createGain();
    audioCtx.createMediaElementSource(audio).connect(gain);
    gain.connect(localMaster);
    return { audio, gain, track: null, fading: false };
  }

  const local = {
    decks: [makeDeck(), makeDeck()],
    current: 0,
    tracks: [],
    order: [],
    pos: 0,
    shuffle: false,
    repeat: true,
    crossfadeMs: 4000,
    /** Wurde der Übergang zum nächsten Titel schon gestartet? */
    advancing: false,
  };

  const deck = () => local.decks[local.current];
  const otherDeck = () => local.decks[1 - local.current];

  function shuffled(n) {
    const a = [...Array(n).keys()];
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function rampGain(gain, to, ms) {
    const now = audioCtx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    if (ms > 0) gain.gain.linearRampToValueAtTime(to, now + ms / 1000);
    else gain.gain.setValueAtTime(to, now);
  }

  /** Titel an Position `pos` der Reihenfolge abspielen, mit Überblendung über `fadeMs` */
  async function playAt(pos, fadeMs) {
    const track = local.tracks[local.order[pos]];
    if (!track) return;
    local.pos = pos;
    local.advancing = false;
    const from = deck();
    local.current = 1 - local.current;
    const to = deck();
    to.track = track;
    to.audio.src = track.url;
    to.audio.currentTime = 0;
    rampGain(to.gain, fadeMs > 0 ? 0 : 1, 0);
    try {
      await audioCtx.resume();
      await to.audio.play();
    } catch (err) {
      send({ type: 'host.error', message: `Titel konnte nicht abgespielt werden (${decodeURIComponent(track.url.split('/').pop())}): ${err.message}` });
      return;
    }
    rampGain(to.gain, 1, fadeMs);
    if (!from.audio.paused) {
      rampGain(from.gain, 0, fadeMs);
      const old = from.audio;
      setTimeout(() => {
        if (deck().audio !== old) old.pause();
      }, fadeMs + 50);
    }
    reportLocal();
  }

  /** Nächster Titel der Reihenfolge (am Ende: von vorn, wenn Wiederholen an ist) */
  function advance(fadeMs, step = 1) {
    let pos = local.pos + step;
    if (pos < 0) pos = 0;
    if (pos >= local.order.length) {
      if (!local.repeat) {
        stopLocal();
        return;
      }
      if (local.shuffle) local.order = shuffled(local.tracks.length);
      pos = 0;
    }
    void playAt(pos, fadeMs);
  }

  function stopLocal() {
    for (const d of local.decks) d.audio.pause();
    reportLocal();
  }

  for (const [index, d] of local.decks.entries()) {
    d.audio.addEventListener('timeupdate', () => {
      if (index !== local.current || local.advancing || d.audio.paused) return;
      const left = (d.audio.duration - d.audio.currentTime) * 1000;
      // Crossfade: rechtzeitig vor dem Ende den nächsten Titel einblenden
      if (local.crossfadeMs > 0 && Number.isFinite(left) && left <= local.crossfadeMs) {
        local.advancing = true;
        advance(Math.min(local.crossfadeMs, Math.max(0, left)));
      }
    });
    d.audio.addEventListener('ended', () => {
      if (index === local.current && !local.advancing) {
        local.advancing = true;
        advance(0);
      }
    });
    d.audio.addEventListener('play', reportLocal);
    d.audio.addEventListener('pause', reportLocal);
    d.audio.addEventListener('error', () => {
      if (index !== local.current || !d.track) return;
      send({ type: 'host.error', message: `Datei kann nicht abgespielt werden: ${decodeURIComponent(d.track.url.split('/').pop())}` });
      if (!local.advancing) {
        local.advancing = true;
        setTimeout(() => advance(0), 500);
      }
    });
  }

  function reportLocal() {
    const d = deck();
    const playing = !!d.track && !d.audio.paused;
    send({
      type: 'local.status',
      isPlaying: playing,
      trackId: d.track ? d.track.id : null,
      positionMs: Math.round((d.audio.currentTime || 0) * 1000),
      durationMs: Number.isFinite(d.audio.duration) ? Math.round(d.audio.duration * 1000) : 0,
    });
    if (engine === 'local') setRow('now', playing ? 'ok' : '', d.track ? `${playing ? '▶' : '⏸'} lokal` : '–');
  }
  setInterval(() => {
    if (engine === 'local' && deck().track) reportLocal();
  }, STATUS_EVERY_MS);

  function onLocal(msg) {
    if (msg.type === 'local.load') {
      engine = 'local';
      sdk.player?.pause().catch(() => {});
      local.tracks = msg.tracks || [];
      local.shuffle = !!msg.shuffle;
      local.repeat = msg.repeat !== false;
      local.crossfadeMs = Math.max(0, Number(msg.crossfadeMs) || 0);
      local.order = local.shuffle ? shuffled(local.tracks.length) : [...local.tracks.keys()];
      void playAt(0, 0);
      return;
    }
    const d = deck();
    switch (msg.action) {
      case 'pause':
        for (const x of local.decks) x.audio.pause();
        break;
      case 'resume':
        engine = 'local';
        if (d.track) {
          rampGain(d.gain, 1, 0);
          void audioCtx.resume().then(() => d.audio.play());
        }
        break;
      case 'next':
        if (local.tracks.length) {
          local.advancing = true;
          advance(MANUAL_FADE_MS);
        }
        break;
      case 'previous':
        if (!local.tracks.length) break;
        // Wie bei jedem Player: nach 3 s zurück an den Anfang, sonst voriger Titel
        if (d.audio.currentTime > 3) d.audio.currentTime = 0;
        else {
          local.advancing = true;
          advance(MANUAL_FADE_MS, -1);
        }
        break;
    }
  }

  // ============================================================ Spotify Web Playback SDK

  const sdk = { player: null, deviceName: '', ready: false, loading: null, volume: 60, fadeTimer: null, pollTimer: null };

  function loadSdk() {
    if (window.Spotify) return Promise.resolve();
    if (sdk.loading) return sdk.loading;
    sdk.loading = new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = resolve;
      const script = document.createElement('script');
      script.src = SDK_URL;
      script.onerror = () => reject(new Error('Spotify-SDK konnte nicht geladen werden (Internet?).'));
      document.head.append(script);
    });
    return sdk.loading;
  }

  function sdkFail(error) {
    sdk.ready = false;
    setRow('sdk', 'err', `geht nicht: ${error}`);
    send({ type: 'sdk.failed', error });
  }

  async function getToken() {
    const res = await fetch('/api/addons/music/spotify/token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'kein Token');
    return data.accessToken;
  }

  function reportSdk(state) {
    if (!state || !state.track_window || !state.track_window.current_track) {
      send({ type: 'sdk.state', track: null, isPlaying: false });
      return;
    }
    const t = state.track_window.current_track;
    send({
      type: 'sdk.state',
      isPlaying: !state.paused,
      positionMs: state.position,
      durationMs: state.duration,
      track: {
        id: t.id || t.uri,
        title: t.name,
        artists: (t.artists || []).map((a) => a.name),
        album: t.album ? t.album.name : null,
        coverUrl: t.album && t.album.images && t.album.images.length ? t.album.images[0].url : null,
      },
    });
    if (engine === 'sdk') setRow('now', state.paused ? '' : 'ok', `${state.paused ? '⏸' : '▶'} Spotify`);
  }

  async function initSdk(msg) {
    sdk.volume = Number(msg.volume) || 0;
    if (sdk.player && sdk.deviceName === msg.deviceName && sdk.ready) {
      send({ type: 'sdk.ready', deviceId: sdk.deviceId });
      return;
    }
    if (sdk.player) {
      sdk.player.disconnect();
      sdk.player = null;
    }
    sdk.ready = false;
    sdk.deviceName = msg.deviceName;
    setRow('sdk', 'warn', 'verbinde…');
    try {
      await loadSdk();
    } catch (err) {
      sdkFail(err.message);
      return;
    }
    const player = new window.Spotify.Player({
      name: msg.deviceName,
      getOAuthToken: (cb) => getToken().then(cb).catch((err) => send({ type: 'host.error', message: `Spotify-Token: ${err.message}` })),
      volume: sdk.volume / 100,
    });
    sdk.player = player;

    // Hängt connect() oder kommt kein „ready“ → nach 10 s aufgeben (Suite schaltet auf Fernsteuerung)
    const timeout = setTimeout(() => {
      if (sdk.player === player && !sdk.ready) {
        sdkFail('keine Verbindung nach 10 s');
        player.disconnect();
      }
    }, SDK_TIMEOUT_MS);

    player.addListener('ready', ({ device_id: deviceId }) => {
      if (sdk.player !== player) return;
      clearTimeout(timeout);
      sdk.ready = true;
      sdk.deviceId = deviceId;
      setRow('sdk', 'ok', `bereit als „${msg.deviceName}“`);
      send({ type: 'sdk.ready', deviceId });
    });
    player.addListener('not_ready', () => {
      if (sdk.player !== player) return;
      sdk.ready = false;
      setRow('sdk', 'warn', 'offline – verbinde neu…');
    });
    player.addListener('initialization_error', ({ message }) => {
      clearTimeout(timeout);
      sdkFail(`Start fehlgeschlagen (${message}). Läuft dieses Fenster in Chrome oder Edge?`);
    });
    player.addListener('authentication_error', ({ message }) => {
      clearTimeout(timeout);
      sdkFail(`Anmeldung abgelehnt (${message})`);
    });
    player.addListener('account_error', ({ message }) => {
      clearTimeout(timeout);
      sdkFail(`Account (${message}) – Spotify Premium nötig`);
    });
    player.addListener('playback_error', ({ message }) => send({ type: 'host.error', message: `Spotify-Wiedergabe: ${message}` }));
    player.addListener('player_state_changed', reportSdk);

    const ok = await Promise.race([player.connect(), new Promise((r) => setTimeout(() => r(false), SDK_TIMEOUT_MS))]);
    if (!ok && sdk.player === player && !sdk.ready) {
      clearTimeout(timeout);
      sdkFail('connect() hat nicht geklappt');
    }
  }

  // Position regelmäßig melden (player_state_changed kommt nur bei Änderungen)
  setInterval(async () => {
    if (engine !== 'sdk' || !sdk.player || !sdk.ready) return;
    const state = await sdk.player.getCurrentState().catch(() => null);
    if (state && !state.paused) reportSdk(state);
  }, 3000);

  function onSdkCmd(action) {
    const p = sdk.player;
    if (!p) return;
    if (action === 'pause') p.pause();
    else if (action === 'resume') {
      engine = 'sdk';
      p.resume();
    } else if (action === 'next') p.nextTrack();
    else if (action === 'previous') p.previousTrack();
    else if (action === 'disconnect') {
      p.disconnect();
      sdk.player = null;
      sdk.ready = false;
      setRow('sdk', '', 'aus');
    }
  }

  /** SDK-Lautstärke in kleinen Schritten (das SDK kann keine Rampe) */
  function sdkFade(target, ms) {
    if (sdk.fadeTimer) clearInterval(sdk.fadeTimer);
    const start = sdk.volume;
    if (!sdk.player || ms <= 0) {
      sdk.volume = target;
      sdk.player?.setVolume(target / 100);
      return;
    }
    const t0 = performance.now();
    sdk.fadeTimer = setInterval(() => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      sdk.volume = start + (target - start) * k;
      sdk.player?.setVolume(Math.max(0, sdk.volume) / 100);
      if (k >= 1) {
        clearInterval(sdk.fadeTimer);
        sdk.fadeTimer = null;
      }
    }, 100);
  }

  // ============================================================ Verbindung

  function onMessage(msg) {
    switch (msg.type) {
      case 'local.load':
      case 'local.cmd':
        return onLocal(msg);
      case 'sdk.init':
        return void initSdk(msg);
      case 'sdk.cmd':
        return onSdkCmd(msg.action);
      case 'volume':
        if (msg.engine === 'sdk') sdkFade(Number(msg.volume), Number(msg.fadeMs) || 0);
        else rampGain(localMaster, gainOf(Number(msg.volume)), Number(msg.fadeMs) || 0);
        return;
      case 'host.ping':
        // Musik-Addon wurde neu eingeschaltet → neu melden
        send({ type: 'host.hello', audioUnlocked: audioCtx.state === 'running', browser: browserName() });
        return;
      case 'engine':
        engine = msg.engine;
        if (engine !== 'local') for (const d of local.decks) d.audio.pause();
        if (engine !== 'sdk') sdk.player?.pause().catch(() => {});
        return;
    }
  }

  function browserName() {
    return (navigator.userAgentData?.brands || []).map((b) => b.brand).find((b) => /Chrome|Edge/.test(b)) || '';
  }

  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws?channel=music.host`);
    ws.onopen = () => {
      setRow('suite', 'ok', 'verbunden');
      send({ type: 'host.hello', audioUnlocked: audioCtx.state === 'running', browser: browserName() });
    };
    ws.onmessage = (m) => {
      try {
        onMessage(JSON.parse(m.data));
      } catch (err) {
        send({ type: 'host.error', message: err.message });
      }
    };
    ws.onclose = () => {
      setRow('suite', 'err', 'getrennt – verbinde neu…');
      setTimeout(connect, 2000);
    };
  }

  renderAudio();
  connect();
})();
