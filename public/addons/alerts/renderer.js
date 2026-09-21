// Zeichnet einen Alert. Wird vom OBS-Overlay UND von der Vorschau im Editor benutzt,
// damit beides garantiert gleich aussieht.
window.AlertRenderer = (() => {
  /** Schriften: null = auf dem PC installiert, sonst Google-Fonts-Stärken */
  const FONTS = {
    'Segoe UI': null,
    Arial: null,
    Impact: null,
    Roboto: '400;500;700;900',
    Montserrat: '400;600;700;800;900',
    Poppins: '400;600;700;800;900',
    Nunito: '400;600;700;800;900',
    Fredoka: '400;500;600;700',
    Oswald: '400;500;600;700',
    'Bebas Neue': '400',
    Bangers: '400',
    'Luckiest Guy': '400',
    'Permanent Marker': '400',
    'Press Start 2P': '400',
  };

  const CSS = `
    .ma-root { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
    .ma-box { display: flex; align-items: center; max-width: 96%; max-height: 96%; box-sizing: border-box; }
    .ma-layout-image-left { flex-direction: row; }
    .ma-layout-image-right { flex-direction: row-reverse; }
    .ma-layout-image-top { flex-direction: column; }
    .ma-layout-image-bottom { flex-direction: column-reverse; }
    .ma-layout-overlay { display: grid; place-items: center; }
    .ma-layout-overlay > * { grid-area: 1 / 1; }
    .ma-layout-overlay .ma-text { position: relative; z-index: 1; }
    .ma-media { display: flex; align-items: center; justify-content: center; flex: none; }
    .ma-media img, .ma-media video { height: 100%; width: auto; display: block; }
    .ma-media svg { height: 100%; width: auto; aspect-ratio: 1; display: block; overflow: visible; }
    .ma-text { min-width: 0; overflow-wrap: anywhere; line-height: 1.2; }
    .ma-layout-image-top .ma-text, .ma-layout-image-bottom .ma-text, .ma-layout-overlay .ma-text { width: 100%; }
    .ma-accent { color: var(--ma-accent); }
    .ma-sub { font-size: 0.62em; font-weight: 500; opacity: 0.92; margin-top: 0.35em; }
    .ma-fx { position: absolute; pointer-events: none; z-index: 5; }

    .ma-in-fade { animation: ma-fade-in .5s ease-out both; }
    .ma-in-pop { animation: ma-pop-in .6s cubic-bezier(.2, 1.5, .4, 1) both; }
    .ma-in-slide-down { animation: ma-slide-down-in .6s cubic-bezier(.2, 1.2, .4, 1) both; }
    .ma-in-slide-up { animation: ma-slide-up-in .6s cubic-bezier(.2, 1.2, .4, 1) both; }
    .ma-in-zoom { animation: ma-zoom-in .5s ease-out both; }
    .ma-in-bounce { animation: ma-bounce-in .9s ease-out both; }
    .ma-out-fade { animation: ma-fade-out .5s ease-in both; }
    .ma-out-slide-up { animation: ma-slide-up-out .5s ease-in both; }
    .ma-out-slide-down { animation: ma-slide-down-out .5s ease-in both; }
    .ma-out-zoom { animation: ma-zoom-out .5s ease-in both; }
    .ma-out-none { opacity: 0; }
    @keyframes ma-fade-in { from { opacity: 0; } }
    @keyframes ma-pop-in { from { opacity: 0; transform: scale(.6); } }
    @keyframes ma-slide-down-in { from { opacity: 0; transform: translateY(-80px); } }
    @keyframes ma-slide-up-in { from { opacity: 0; transform: translateY(80px); } }
    @keyframes ma-zoom-in { from { opacity: 0; transform: scale(1.6); } }
    @keyframes ma-bounce-in {
      0% { opacity: 0; transform: translateY(-140px); }
      55% { opacity: 1; transform: translateY(14px); }
      75% { transform: translateY(-6px); }
      100% { transform: none; }
    }
    @keyframes ma-fade-out { to { opacity: 0; } }
    @keyframes ma-slide-up-out { to { opacity: 0; transform: translateY(-80px); } }
    @keyframes ma-slide-down-out { to { opacity: 0; transform: translateY(80px); } }
    @keyframes ma-zoom-out { to { opacity: 0; transform: scale(.6); } }

    .ma-bob, .ma-pulse, .ma-wiggle, .ma-twinkle, .ma-flicker { transform-box: fill-box; transform-origin: center; }
    .ma-bob { animation: ma-bob 1.8s ease-in-out infinite; }
    .ma-pulse { animation: ma-pulse 1.2s ease-in-out infinite; }
    .ma-wiggle { animation: ma-wiggle 1.6s ease-in-out infinite; }
    .ma-twinkle { animation: ma-twinkle 1.4s ease-in-out infinite; }
    .ma-flicker { animation: ma-flicker .18s ease-in-out infinite alternate; transform-origin: top center; }
    @keyframes ma-bob { 50% { transform: translateY(-7px); } }
    @keyframes ma-pulse { 50% { transform: scale(1.07); } }
    @keyframes ma-wiggle { 25% { transform: rotate(-5deg); } 75% { transform: rotate(5deg); } }
    @keyframes ma-twinkle { 50% { transform: scale(.6); opacity: .5; } }
    @keyframes ma-flicker { to { transform: scaleY(1.25); } }
  `;

  let cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.append(style);
  }

  const loadedFonts = new Set();
  function loadFont(name) {
    const weights = FONTS[name];
    if (!weights || loadedFonts.has(name)) return;
    loadedFonts.add(name);
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = `https://fonts.googleapis.com/css2?family=${name.replace(/ /g, '+')}:wght@${weights}&display=swap`;
    document.head.append(link);
  }

  function hexToRgba(hex, opacity) {
    const m = /^#?([0-9a-f]{6})/i.exec(hex || '');
    if (!m) return 'transparent';
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity / 100})`;
  }

  /** Nachricht mit Platzhaltern → Text, Platzhalter-Werte in Akzentfarbe */
  function fillMessage(template, values) {
    const fragment = document.createDocumentFragment();
    let last = 0;
    for (const match of template.matchAll(/\{(\w+)\}/g)) {
      fragment.append(template.slice(last, match.index));
      if (match[1] in values) {
        const span = document.createElement('span');
        span.className = 'ma-accent';
        span.textContent = String(values[match[1]]);
        fragment.append(span);
      } else fragment.append(match[0]);
      last = match.index + match[0].length;
    }
    fragment.append(template.slice(last));
    return fragment;
  }

  function fillPlain(template, values) {
    return template.replace(/\{(\w+)\}/g, (m, key) => (key in values ? String(values[key]) : m));
  }

  function mediaUrl(ref) {
    return `/addon-data/alerts/media/${encodeURIComponent(ref.id)}`;
  }

  function buildMedia(design, height, muted) {
    const ref = design.image;
    if (!ref) return null;
    const wrap = document.createElement('div');
    wrap.className = 'ma-media';
    wrap.style.height = `${Math.round((height * design.imageSize) / 100)}px`;
    if (ref.source === 'builtin') {
      wrap.innerHTML = window.AlertLibrary?.images[ref.id]?.svg ?? '';
    } else if (ref.kind === 'video') {
      const video = document.createElement('video');
      video.src = mediaUrl(ref);
      video.autoplay = true;
      video.loop = true;
      video.playsInline = true;
      video.volume = Math.min(1, design.imageVolume / 100);
      video.muted = muted || design.imageVolume === 0;
      wrap.append(video);
    } else {
      const img = document.createElement('img');
      img.src = mediaUrl(ref);
      img.alt = '';
      wrap.append(img);
    }
    return wrap;
  }

  function build(alert, height, muted) {
    injectCss();
    const d = alert.design;
    loadFont(d.font);

    const root = document.createElement('div');
    root.className = 'ma-root';
    const box = document.createElement('div');
    box.className = `ma-box ma-layout-${d.layout}`;
    Object.assign(box.style, {
      background: hexToRgba(d.background, d.backgroundOpacity),
      padding: `${d.padding}px`,
      gap: `${d.gap}px`,
      borderRadius: d.rounded ? '18px' : '0',
      boxShadow: d.shadow ? '0 12px 40px rgba(0, 0, 0, .5)' : 'none',
      fontFamily: `"${d.font}", "Segoe UI", sans-serif`,
      fontWeight: String(d.fontWeight),
      fontSize: `${d.fontSize}px`,
      textAlign: d.align,
      color: d.textColor,
    });
    box.style.setProperty('--ma-accent', d.accentColor);

    const text = document.createElement('div');
    text.className = 'ma-text';
    if (d.textShadow) text.style.textShadow = '0 2px 4px rgba(0,0,0,.65), 0 0 2px rgba(0,0,0,.65)';
    const message = document.createElement('div');
    message.className = 'ma-msg';
    message.append(fillMessage(d.message, alert.values || {}));
    text.append(message);
    if (alert.userMessage) {
      const sub = document.createElement('div');
      sub.className = 'ma-sub';
      sub.textContent = alert.userMessage;
      text.append(sub);
    }

    const media = buildMedia(d, height, muted);
    if (media) box.append(media);
    box.append(text);
    root.append(box);
    return { root, box };
  }

  /**
   * Alert in `host` abspielen.
   * options.mode: 'live' (mit Ton), 'muted' (Animation ohne Ton), 'static' (steht einfach da)
   * Rückgabe: { skip() – ausblenden, stop() – sofort entfernen }
   */
  function play(host, alert, { mode = 'live', onDone } = {}) {
    const d = alert.design;
    const height = host.clientHeight || window.innerHeight;
    const { root, box } = build(alert, height, mode !== 'live');
    host.append(root);

    const stops = [];
    let finished = false;
    let removed = false;

    const cleanup = (immediate) => {
      if (removed) return;
      removed = true;
      stops.forEach((fn) => fn(immediate));
      root.querySelectorAll('video').forEach((v) => v.pause());
      root.remove();
      onDone?.();
    };

    if (mode === 'static') return { skip() {}, stop: () => cleanup(true) };

    box.classList.add(`ma-in-${d.animationIn}`);

    if (mode === 'live') {
      if (d.sound?.source === 'builtin') window.AlertLibrary?.playSound(d.sound.id, d.soundVolume);
      else if (d.sound) {
        const audio = new Audio(mediaUrl(d.sound));
        audio.volume = Math.min(1, d.soundVolume / 100);
        audio.play().catch(() => {});
        stops.push(() => audio.pause());
      }
    }

    // Sprachausgabe: Alert bleibt stehen, bis fertig gesprochen wurde
    let ttsDone = Promise.resolve();
    if (mode === 'live' && alert.ttsUrl) {
      const voice = new Audio(alert.ttsUrl);
      voice.volume = Math.min(1, d.tts.volume / 100);
      ttsDone = new Promise((resolve) => {
        voice.onended = resolve;
        voice.onerror = resolve;
        setTimeout(resolve, 60_000);
      });
      const timer = setTimeout(() => voice.play().catch(() => {}), 350);
      stops.push(() => { clearTimeout(timer); voice.pause(); });
    }

    if (d.celebration.enabled && window.AlertEffects) {
      stops.push(window.AlertEffects.start(host, d.celebration, box));
    }

    const skip = () => {
      if (finished) return;
      finished = true;
      box.classList.remove(`ma-in-${d.animationIn}`);
      box.classList.add(`ma-out-${d.animationOut}`);
      setTimeout(() => cleanup(false), d.animationOut === 'none' ? 0 : 500);
    };
    Promise.all([new Promise((r) => setTimeout(r, d.durationMs)), ttsDone]).then(skip);

    return { skip, stop: () => cleanup(true) };
  }

  return { FONTS, play, fillPlain };
})();
