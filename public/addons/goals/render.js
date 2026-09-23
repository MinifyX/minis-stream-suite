// Zeichnet Ziele und die „Letzte Events“-Leiste. Wird von den OBS-Overlays (overlay.html, recent.html)
// und von der Vorschau auf der Einstellungsseite benutzt – so sieht die Vorschau genau wie in OBS aus.
window.GoalRender = (() => {
  /** Schriften: Name → Google-Fonts-Stärken (null = auf Windows vorhanden). Gleiche Liste wie im Addon (index.ts). */
  const FONTS = {
    'Segoe UI': null, Arial: null, Verdana: null,
    Nunito: '400;600;700;800;900', Roboto: '400;500;700;900', Montserrat: '400;600;700;800;900',
    Poppins: '400;600;700;800;900', Fredoka: '400;500;600;700', Inter: '400;500;600;700;800;900',
    Oswald: '400;500;600;700', Bangers: '400', 'Press Start 2P': '400', 'Comic Neue': '400;700',
  };
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
  const fontFamily = (name) => `"${name}", "Segoe UI", system-ui, sans-serif`;

  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('de-DE');
  const rgba = (hex, alpha) => {
    const n = parseInt(String(hex).slice(1), 16) || 0;
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  };
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  // ============================================================ CSS (einmal pro Seite)

  const CSS = `
    .gr-goal { position: relative; box-sizing: border-box; color: var(--gr-text); font-family: var(--gr-font); font-size: var(--gr-size); line-height: 1.2; }
    .gr-goal *, .gr-recent * { box-sizing: border-box; }
    .gr-shadow { text-shadow: 0 1px 3px rgba(0, 0, 0, .65); }
    .gr-head { display: flex; align-items: baseline; gap: .6em; margin-bottom: .3em; }
    .gr-title { font-weight: 800; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gr-nums { font-weight: 700; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .gr-nums .gr-of { opacity: .75; font-weight: 600; }
    .gr-pct { font-weight: 800; white-space: nowrap; font-variant-numeric: tabular-nums; }
    .gr-track { position: relative; overflow: hidden; background: var(--gr-track); }
    .gr-fill {
      position: absolute; inset: 0 auto 0 0; width: 0; background: linear-gradient(90deg, var(--gr-c1), var(--gr-c2));
      transition: width .9s cubic-bezier(.2, .8, .2, 1); overflow: hidden;
    }
    .gr-fill::after {
      content: ""; position: absolute; inset: 0; transform: translateX(-100%);
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, .35), transparent); animation: gr-shine 3.2s ease-in-out infinite;
    }
    @keyframes gr-shine { 0%, 40% { transform: translateX(-100%); } 100% { transform: translateX(100%); } }
    .gr-rounded .gr-track, .gr-rounded .gr-fill { border-radius: 99em; }

    /* Dicker Balken: Zahlen im Balken */
    .gr-l-bar .gr-track { height: 1.9em; }
    .gr-l-bar .gr-inside { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 0 .8em; gap: .6em; }
    .gr-l-bar .gr-inside .gr-pct { position: absolute; right: .8em; }
    .gr-l-bar.gr-rounded .gr-inside { padding: 0 1em; }
    .gr-l-bar.gr-rounded .gr-inside .gr-pct { right: 1em; }
    .gr-l-bar .gr-nums .gr-of { font-size: .85em; }

    /* Schmaler Balken: alles in einer Zeile darüber */
    .gr-l-slim .gr-track { height: .45em; }
    .gr-l-slim .gr-head .gr-pct { opacity: .85; }

    /* Kreis */
    .gr-l-ring { display: flex; flex-direction: column; align-items: center; gap: .35em; }
    .gr-ring { position: relative; width: 100%; aspect-ratio: 1; }
    .gr-ring svg { position: absolute; inset: 0; width: 100%; height: 100%; transform: rotate(-90deg); overflow: visible; }
    .gr-ring .gr-arc { transition: stroke-dashoffset .9s cubic-bezier(.2, .8, .2, 1); }
    .gr-ring-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    .gr-ring-center .gr-val { font-size: 2em; font-weight: 800; line-height: 1; font-variant-numeric: tabular-nums; }
    .gr-ring-center .gr-of { font-size: .8em; opacity: .75; font-weight: 600; }
    .gr-ring-center .gr-pct { font-size: .8em; margin-top: .2em; }
    .gr-l-ring .gr-title { flex: none; max-width: 100%; text-align: center; }

    /* Ziel erreicht */
    .gr-done .gr-fill, .gr-done .gr-arc { filter: drop-shadow(0 0 .35em var(--gr-c2)); }
    .gr-celebrating { animation: gr-pop .7s cubic-bezier(.2, 1.6, .4, 1); }
    .gr-celebrating .gr-fill, .gr-celebrating .gr-arc { animation: gr-glow .9s ease-in-out infinite alternate; }
    .gr-celebrating .gr-title { animation: gr-bounce .9s ease-in-out infinite alternate; }
    @keyframes gr-pop { 0% { transform: scale(1); } 40% { transform: scale(1.07); } 100% { transform: scale(1); } }
    @keyframes gr-glow { from { filter: drop-shadow(0 0 .2em var(--gr-c1)) brightness(1); } to { filter: drop-shadow(0 0 .8em var(--gr-c2)) brightness(1.35); } }
    @keyframes gr-bounce { from { transform: translateY(0); } to { transform: translateY(-.12em); } }

    .gr-confetti { position: absolute; inset: 0; pointer-events: none; overflow: hidden; z-index: 10; }
    .gr-confetti i {
      position: absolute; width: .5em; height: .8em; border-radius: .1em; opacity: 0;
      animation: gr-burst var(--t) cubic-bezier(.1, .75, .3, 1) var(--d) forwards;
    }
    @keyframes gr-burst {
      0% { opacity: 1; transform: translate(-50%, -50%) rotate(0); }
      70% { opacity: 1; }
      100% { opacity: 0; transform: translate(calc(-50% + var(--dx)), calc(-50% + var(--dy))) rotate(var(--rot)); }
    }

    /* ---------------- Letzte Events */
    .gr-recent { color: var(--gr-text); font-family: var(--gr-font); font-size: var(--gr-size); line-height: 1.2; }
    .gr-recent .gr-item { display: flex; align-items: center; gap: .5em; min-width: 0; }
    .gr-recent .gr-icon { font-size: 1.25em; flex: none; }
    .gr-recent .gr-text { display: flex; flex-direction: column; min-width: 0; }
    .gr-recent .gr-label { font-size: .55em; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--gr-label); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gr-recent .gr-line { display: flex; align-items: baseline; gap: .4em; min-width: 0; }
    .gr-recent .gr-name { font-weight: 800; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .gr-recent .gr-detail { font-size: .72em; opacity: .85; white-space: nowrap; font-weight: 600; flex: none; }
    .gr-recent .gr-empty .gr-name { opacity: .5; }
    .gr-recent.gr-rounded .gr-panel { border-radius: .55em; }
    .gr-panel { background: var(--gr-bg); }

    .gr-r-bar .gr-panel { display: inline-flex; align-items: stretch; padding: .45em .2em; max-width: 100%; }
    .gr-r-bar.gr-fixed .gr-panel { display: flex; }
    .gr-r-bar .gr-item { padding: 0 .85em; border-left: 1px solid rgba(255, 255, 255, .14); }
    .gr-r-bar.gr-fixed .gr-item { flex: 1; }
    .gr-r-bar .gr-item:first-child { border-left: 0; }
    .gr-r-bar .gr-name { max-width: 11em; }

    .gr-r-list { display: inline-flex; flex-direction: column; gap: .35em; }
    .gr-r-list.gr-fixed { display: flex; }
    .gr-r-list .gr-panel { padding: .45em .8em; }

    .gr-r-ticker .gr-panel { display: inline-flex; padding: .5em .9em; min-width: 12em; max-width: 100%; overflow: hidden; }
    .gr-r-ticker.gr-fixed .gr-panel { display: flex; }
    .gr-r-ticker .gr-item { animation: gr-in .45s cubic-bezier(.2, .8, .2, 1); }
    @keyframes gr-in { from { opacity: 0; transform: translateY(.6em); } }

    .gr-new { animation: gr-flash 1.6s ease-out; }
    @keyframes gr-flash { 0%, 30% { box-shadow: inset 0 0 0 100vmax rgba(255, 255, 255, .22); } 100% { box-shadow: inset 0 0 0 100vmax rgba(255, 255, 255, 0); } }
  `;

  function injectCss() {
    if (document.getElementById('gr-css')) return;
    const style = el('style');
    style.id = 'gr-css';
    style.textContent = CSS;
    document.head.append(style);
  }

  // ============================================================ Zahlen hochzählen

  /** Zahl sanft von der alten zur neuen hochzählen lassen */
  function tween(node, to) {
    const from = Number(node.dataset.value ?? to);
    node.dataset.value = to;
    cancelAnimationFrame(Number(node.dataset.raf || 0));
    if (from === to) {
      node.textContent = fmt(to);
      return;
    }
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 900);
      const eased = 1 - (1 - t) ** 3;
      node.textContent = fmt(from + (to - from) * eased);
      if (t < 1) node.dataset.raf = requestAnimationFrame(step);
    };
    node.dataset.raf = requestAnimationFrame(step);
  }

  // ============================================================ Ziel

  let gradientId = 0;

  /** Gerüst eines Ziels bauen (nur wenn sich Layout/Anzeige ändert) */
  function buildGoal(root, s) {
    const title = s.showTitle ? el('span', 'gr-title') : null;
    const nums = () => {
      const n = el('span', 'gr-nums');
      n.append(el('b', 'gr-val'), el('span', 'gr-of'));
      return n;
    };
    const pct = () => el('span', 'gr-pct');
    root.replaceChildren();

    if (s.layout === 'ring') {
      const id = `gr-grad-${++gradientId}`;
      const ring = el('div', 'gr-ring');
      ring.innerHTML = `
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" style="stop-color: var(--gr-c1)"/><stop offset="1" style="stop-color: var(--gr-c2)"/>
          </linearGradient></defs>
          <circle class="gr-ring-track" cx="50" cy="50" r="43" fill="none" stroke-width="9"/>
          <circle class="gr-arc" cx="50" cy="50" r="43" fill="none" stroke="url(#${id})" stroke-width="9"
            pathLength="100" stroke-dasharray="100" stroke-dashoffset="100"/>
        </svg>`;
      const center = el('div', 'gr-ring-center');
      if (s.showNumbers) center.append(el('span', 'gr-val'), el('span', 'gr-of'));
      if (s.showPercent) center.append(pct());
      ring.append(center);
      root.append(ring);
      if (title) root.append(title);
      return;
    }

    const track = el('div', 'gr-track');
    track.append(el('div', 'gr-fill'));
    if (s.layout === 'slim') {
      const head = el('div', 'gr-head');
      if (title) head.append(title);
      else head.append(el('span', 'gr-title'));
      if (s.showNumbers) head.append(nums());
      if (s.showPercent) head.append(pct());
      root.append(head, track);
      return;
    }
    // Dicker Balken
    if (title) {
      const head = el('div', 'gr-head');
      head.append(title);
      root.append(head);
    }
    const inside = el('div', 'gr-inside');
    if (s.showNumbers) inside.append(nums());
    if (s.showPercent) inside.append(pct());
    track.append(inside);
    root.append(track);
  }

  /**
   * Ziel zeichnen. goal = { title, value, target, style }.
   * Das Gerüst bleibt stehen, solange sich das Layout nicht ändert → Balken wachsen flüssig.
   */
  function drawGoal(root, goal, titleOverride) {
    injectCss();
    const s = goal.style;
    loadFont(s.font);
    root.style.setProperty('--gr-text', s.textColor);
    root.style.setProperty('--gr-c1', s.barColor);
    root.style.setProperty('--gr-c2', s.barColor2);
    root.style.setProperty('--gr-track', rgba(s.trackColor, s.trackOpacity / 100));
    root.style.setProperty('--gr-font', fontFamily(s.font));
    root.style.setProperty('--gr-size', `${s.fontSize}px`);
    root.style.width = `${s.width}px`;

    const key = JSON.stringify([s.layout, s.showTitle, s.showNumbers, s.showPercent]);
    if (root.dataset.key !== key) {
      root.dataset.key = key;
      buildGoal(root, s);
    }
    const value = Math.max(0, goal.value);
    const target = Math.max(1, goal.target);
    const pct = Math.floor((value / target) * 100);
    const fill = Math.min(100, (value / target) * 100);
    root.dataset.base ??= root.className; // eigene Klassen des Elements behalten
    root.className = `${root.dataset.base} gr-goal gr-l-${s.layout}${s.rounded ? ' gr-rounded' : ''}${s.textShadow ? ' gr-shadow' : ''}${value >= target ? ' gr-done' : ''}${root.classList.contains('gr-celebrating') ? ' gr-celebrating' : ''}`;

    const title = root.querySelector('.gr-title');
    if (title) title.textContent = titleOverride ?? (s.showTitle ? goal.title : '');
    const val = root.querySelector('.gr-val');
    if (val) tween(val, value);
    const of = root.querySelector('.gr-of');
    if (of) of.textContent = ` / ${fmt(target)}`;
    const pctEl = root.querySelector('.gr-pct');
    if (pctEl) pctEl.textContent = `${pct}%`;

    const bar = root.querySelector('.gr-fill');
    if (bar) requestAnimationFrame(() => { bar.style.width = `${fill}%`; });
    const arc = root.querySelector('.gr-arc');
    if (arc) {
      arc.setAttribute('stroke-linecap', s.rounded ? 'round' : 'butt');
      requestAnimationFrame(() => arc.setAttribute('stroke-dashoffset', String(100 - fill)));
      const ringTrack = root.querySelector('.gr-ring-track');
      ringTrack.setAttribute('stroke', s.trackColor);
      ringTrack.setAttribute('stroke-opacity', String(s.trackOpacity / 100));
    }
  }

  /** Konfetti aus der Mitte des Ziels schießen */
  function confetti(root, host, colors) {
    injectCss();
    const hostRect = host.getBoundingClientRect();
    const rect = root.getBoundingClientRect();
    const layer = el('div', 'gr-confetti');
    layer.style.fontSize = root.style.getPropertyValue('--gr-size') || '20px';
    const cx = rect.left - hostRect.left + rect.width / 2;
    const cy = rect.top - hostRect.top + rect.height / 2;
    const spread = Math.max(rect.width, 200);
    for (let i = 0; i < 70; i++) {
      const piece = el('i');
      piece.style.left = `${cx + (Math.random() - 0.5) * rect.width * 0.8}px`;
      piece.style.top = `${cy}px`;
      piece.style.background = colors[i % colors.length];
      piece.style.setProperty('--dx', `${(Math.random() - 0.5) * spread * 0.9}px`);
      piece.style.setProperty('--dy', `${(Math.random() - 0.35) * spread * 0.6}px`);
      piece.style.setProperty('--rot', `${(Math.random() - 0.5) * 1080}deg`);
      piece.style.setProperty('--t', `${1.6 + Math.random() * 1.6}s`);
      piece.style.setProperty('--d', `${Math.random() * 0.35}s`);
      layer.append(piece);
    }
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
    host.append(layer);
    setTimeout(() => layer.remove(), 4000);
  }

  /**
   * Ein Ziel an einem Element „einhängen“. update(goal, reachedTarget) zeichnet neu;
   * reachedTarget (Zahl) = Ziel wurde gerade erreicht → Feier. Während der Feier (5 s)
   * wird der neue Stand (z.B. nächstes Ziel) zurückgehalten und danach gezeigt.
   */
  function mountGoal(root, options = {}) {
    const host = options.confettiHost || document.body;
    let latest = null;
    let celebrateTimer = null;

    function update(goal, reachedTarget = null) {
      latest = goal;
      if (reachedTarget !== null && goal.style.celebrate) {
        clearTimeout(celebrateTimer);
        root.classList.remove('gr-celebrating');
        void root.offsetWidth; // Animation neu starten
        root.classList.add('gr-celebrating');
        drawGoal(root, { ...goal, target: reachedTarget }, goal.style.celebrateText || goal.title);
        confetti(root, host, [goal.style.barColor, goal.style.barColor2, '#FFD166', '#06D6A0', '#FFFFFF']);
        celebrateTimer = setTimeout(() => {
          celebrateTimer = null;
          root.classList.remove('gr-celebrating');
          if (latest) drawGoal(root, latest);
        }, 5000);
        return;
      }
      if (celebrateTimer) return; // nach der Feier
      drawGoal(root, goal);
    }

    return { update };
  }

  // ============================================================ Letzte Events

  const RECENT_ORDER = ['follow', 'sub', 'giftsub', 'cheer', 'raid', 'topcheer'];
  const ICONS = { follow: '💜', sub: '⭐', giftsub: '🎁', cheer: '💎', raid: '🚀', topcheer: '👑' };

  /** Anzeige eines Eintrags: Name + Zusatz (z.B. „500 Bits“) */
  function recentText(kind, entry) {
    if (!entry) return { name: '–', detail: '' };
    const n = entry.amount;
    const detail = {
      follow: '',
      sub: entry.months >= 2 ? `${entry.months} Monate` : '',
      giftsub: n ? `${fmt(n)} ${n === 1 ? 'Abo' : 'Abos'}` : '',
      cheer: `${fmt(n)} Bits`,
      raid: `${fmt(n)} Zuschauer`,
      topcheer: `${fmt(n)} Bits`,
    }[kind];
    return { name: entry.name, detail };
  }

  function recentItem(kind, entry, style, isNew) {
    const { name, detail } = recentText(kind, entry);
    const item = el('div', `gr-item${entry ? '' : ' gr-empty'}${isNew ? ' gr-new' : ''}`);
    if (style.showIcons) item.append(el('span', 'gr-icon', ICONS[kind]));
    const text = el('div', 'gr-text');
    if (style.labels[kind]) text.append(el('span', 'gr-label', style.labels[kind]));
    const line = el('div', 'gr-line');
    line.append(el('span', 'gr-name', name));
    if (detail) line.append(el('span', 'gr-detail', detail));
    text.append(line);
    item.append(text);
    return item;
  }

  /**
   * „Letzte Events“ an einem Element einhängen. update(recent, style, changed):
   * changed = Einträge, die gerade neu sind (blinken kurz auf, beim Laufband wird direkt dorthin gesprungen).
   */
  function mountRecent(root) {
    const baseClass = root.className;
    let data = null;
    let style = null;
    let tickerIndex = 0;
    let tickerTimer = null;

    const kinds = () => RECENT_ORDER.filter((k) => style.items[k]);

    function applyStyle() {
      injectCss();
      loadFont(style.font);
      root.style.setProperty('--gr-text', style.textColor);
      root.style.setProperty('--gr-label', style.labelColor);
      root.style.setProperty('--gr-bg', rgba(style.background, style.backgroundOpacity / 100));
      root.style.setProperty('--gr-font', fontFamily(style.font));
      root.style.setProperty('--gr-size', `${style.fontSize}px`);
      root.style.width = style.width ? `${style.width}px` : '';
      root.className = `${baseClass} gr-recent gr-r-${style.layout}${style.rounded ? ' gr-rounded' : ''}${style.textShadow ? ' gr-shadow' : ''}${style.width ? ' gr-fixed' : ''}`;
    }

    function showTicker(isNew) {
      const list = kinds();
      if (!list.length) {
        root.replaceChildren();
        return;
      }
      tickerIndex %= list.length;
      const kind = list[tickerIndex];
      const panel = el('div', `gr-panel${isNew ? ' gr-new' : ''}`);
      panel.append(recentItem(kind, data[kind], style, false));
      root.replaceChildren(panel);
    }

    function restartTicker() {
      clearInterval(tickerTimer);
      tickerTimer = null;
      if (style.layout !== 'ticker') return;
      tickerTimer = setInterval(() => {
        tickerIndex++;
        showTicker(false);
      }, style.tickerSeconds * 1000);
    }

    function update(recent, newStyle, changed = []) {
      const styleChanged = JSON.stringify(newStyle) !== JSON.stringify(style);
      data = recent;
      style = newStyle;
      applyStyle();
      const list = kinds();

      if (style.layout === 'ticker') {
        const jump = list.findIndex((k) => changed.includes(k));
        if (jump >= 0) tickerIndex = jump;
        showTicker(jump >= 0);
        if (styleChanged || jump >= 0) restartTicker();
        return;
      }
      clearInterval(tickerTimer);
      tickerTimer = null;
      if (style.layout === 'list') {
        root.replaceChildren(...list.map((k) => {
          const panel = el('div', `gr-panel${changed.includes(k) ? ' gr-new' : ''}`);
          panel.append(recentItem(k, recent[k], style, false));
          return panel;
        }));
        return;
      }
      const panel = el('div', 'gr-panel');
      panel.append(...list.map((k) => recentItem(k, recent[k], style, changed.includes(k))));
      root.replaceChildren(list.length ? panel : '');
    }

    return { update };
  }

  return { FONTS, loadFont, fmt, drawGoal, mountGoal, mountRecent, recentText, RECENT_ORDER, ICONS };
})();
