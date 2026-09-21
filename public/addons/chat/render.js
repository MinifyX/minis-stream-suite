// Zeichnet Chat-Nachrichten und Events. Benutzt von OBS-Overlay, Chat-Fenster und Vorschau.
// Sicherheit: Texte aus dem Chat landen nur als textContent im DOM, Farben werden streng geprüft.
window.ChatRender = (() => {
  const ROLE_LEVEL = { everyone: 0, subscriber: 1, vip: 2, moderator: 3, broadcaster: 4 };

  const COLORS = {
    rot: '#FF4D4D', red: '#FF4D4D', grün: '#4DFF88', gruen: '#4DFF88', green: '#4DFF88',
    blau: '#4DA6FF', blue: '#4DA6FF', gelb: '#FFE14D', yellow: '#FFE14D', lila: '#B580FF', purple: '#B580FF',
    pink: '#FF6BD6', orange: '#FF9F43', weiß: '#FFFFFF', weiss: '#FFFFFF', white: '#FFFFFF',
    grau: '#AAAAAA', gray: '#AAAAAA', grey: '#AAAAAA', gold: '#FFD700', türkis: '#35D0FF', tuerkis: '#35D0FF',
    cyan: '#35D0FF', schwarz: '#000000', black: '#000000',
  };
  const RAINBOW = new Set(['regenbogen', 'rainbow']);
  // Twitchs Standardfarben für Leute ohne eigene Namensfarbe
  const DEFAULT_NAME_COLORS = ['#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50', '#9ACD32', '#FF4500', '#2E8B57',
    '#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F'];

  const CSS = `
    .cr-emote { height: 1.7em; width: auto; vertical-align: middle; margin: -0.3em 0.05em; }
    .cr-badge { height: 1.05em; width: auto; vertical-align: middle; margin-right: 0.25em; position: relative; top: -0.08em; }
    .cr-name { font-weight: 800; }
    .cr-login { font-weight: 500; opacity: .7; font-size: .85em; }
    .cr-mention { font-weight: 800; }
    .cr-md-code { font-family: Consolas, monospace; background: rgba(255,255,255,.14); padding: 0 .3em; border-radius: 4px; font-size: .92em; }
    .cr-rainbow {
      background: linear-gradient(90deg, #ff4d4d, #ff9f43, #ffe14d, #4dff88, #35d0ff, #b580ff, #ff6bd6, #ff4d4d);
      background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; color: transparent;
      animation: cr-rainbow 3s linear infinite;
    }
    @keyframes cr-rainbow { to { background-position: 200% 0; } }
    .cr-rainbow .cr-emote { -webkit-background-clip: border-box; }
    /* Textschatten würde durch die transparente Regenbogen-Schrift scheinen → Schatten als Filter */
    .cr-shadow .cr-rainbow { text-shadow: none; filter: drop-shadow(0 1px 1px rgba(0,0,0,.85)); }
    .cr-reply { font-size: .8em; opacity: .65; margin-bottom: .1em; }
    .cr-ev-user { font-weight: 800; }
    .cr-ev-detail { opacity: .85; font-size: .9em; margin-top: .15em; }
  `;
  // Wohin die Styles kommen (Standard: <head>; die Browser-Erweiterung nutzt ein Shadow DOM)
  let styleTarget = null;
  const setStyleTarget = (node) => { styleTarget = node; };

  let cssInjected = false;
  function injectCss() {
    if (cssInjected) return;
    cssInjected = true;
    const style = document.createElement('style');
    style.textContent = CSS;
    (styleTarget ?? document.head).append(style);
  }

  /** Schriften: null = auf dem PC installiert, sonst Google-Fonts-Stärken */
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

  let assets = { badges: {}, emotes: {}, broadcaster: '' };
  const setAssets = (a) => { if (a) assets = a; };
  const getAssets = () => assets;

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  function nameColor(item) {
    if (/^#[0-9a-f]{6}$/i.test(item.color || '')) return item.color;
    let hash = 0;
    for (const ch of item.user.login || item.user.name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return DEFAULT_NAME_COLORS[hash % DEFAULT_NAME_COLORS.length];
  }

  /** Zu dunkle Farben auf dunklem Hintergrund aufhellen (wie Twitch es auch macht) */
  function readableOnDark(hex) {
    const n = parseInt(hex.slice(1), 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    if (lum >= 0.45) return hex;
    const mix = Math.min(0.75, 0.45 - lum + 0.25); // Richtung Weiß mischen
    r = Math.round(r + (255 - r) * mix);
    g = Math.round(g + (255 - g) * mix);
    b = Math.round(b + (255 - b) * mix);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
  }

  // ------------------------------------------------------------ Text: Emotes, Markdown, Farben

  function emoteImg(url, name) {
    const img = el('img', 'cr-emote');
    img.src = url;
    img.alt = name;
    img.title = name;
    img.loading = 'lazy';
    return img;
  }

  /** Klartext + Emotes von 7TV/BTTV/FFZ */
  function textWithEmotes(text, parent) {
    const map = assets.emotes || {};
    let buffer = '';
    for (const part of text.split(/(\s+)/)) {
      const url = part && map[part];
      if (url) {
        if (buffer) parent.append(buffer);
        buffer = '';
        parent.append(emoteImg(url, part));
      } else buffer += part;
    }
    if (buffer) parent.append(buffer);
  }

  const MD_RULES = [
    { re: /`([^`]+)`/, tag: 'code', cls: 'cr-md-code', literal: true },
    { re: /\*\*(?!\s)(.+?)(?<!\s)\*\*/, tag: 'strong' },
    { re: /~~(?!\s)(.+?)(?<!\s)~~/, tag: 's' },
    { re: /\*(?![\s*])(.+?)(?<![\s*])\*/, tag: 'em' },
  ];

  function markdown(text, parent, opts) {
    if (!opts.markdown) return textWithEmotes(text, parent);
    let rest = text;
    while (rest) {
      let best = null;
      for (const rule of MD_RULES) {
        const m = rule.re.exec(rest);
        if (m && (!best || m.index < best.m.index)) best = { m, rule };
      }
      if (!best) return textWithEmotes(rest, parent);
      if (best.m.index) textWithEmotes(rest.slice(0, best.m.index), parent);
      const node = el(best.rule.tag, best.rule.cls);
      if (best.rule.literal) node.textContent = best.m[1];
      else markdown(best.m[1], node, opts);
      parent.append(node);
      rest = rest.slice(best.m.index + best.m[0].length);
    }
  }

  /** Zerlegt Text an Farb-Markierungen: [rot]…[/], [#ff00aa]…[/], [regenbogen]…[/] */
  function colorSegments(text) {
    const segments = [];
    const re = /\[(#[0-9a-f]{6}|#[0-9a-f]{3}|[a-zäöüß]+)\]/gi;
    let pos = 0;
    let m;
    while ((m = re.exec(text))) {
      const key = m[1].toLowerCase();
      const color = key.startsWith('#') ? key : COLORS[key] ?? (RAINBOW.has(key) ? 'rainbow' : null);
      if (!color) continue;
      const contentStart = re.lastIndex;
      const end = text.indexOf('[/]', contentStart);
      const contentEnd = end < 0 ? text.length : end;
      if (m.index > pos) segments.push({ text: text.slice(pos, m.index) });
      segments.push({ text: text.slice(contentStart, contentEnd), color });
      pos = end < 0 ? text.length : end + 3;
      re.lastIndex = pos;
    }
    if (pos < text.length) segments.push({ text: text.slice(pos) });
    return segments;
  }

  function rich(text, parent, opts) {
    if (!opts.colors) return markdown(text, parent, opts);
    for (const seg of colorSegments(text)) {
      if (!seg.color) {
        markdown(seg.text, parent, opts);
        continue;
      }
      const span = el('span', seg.color === 'rainbow' ? 'cr-rainbow' : 'cr-color');
      if (seg.color !== 'rainbow') span.style.color = seg.color;
      markdown(seg.text, span, opts);
      parent.append(span);
    }
  }

  // ------------------------------------------------------------ Nachricht

  /** Darf diese Person Markdown / Farben benutzen? */
  function permissions(item, settings) {
    return {
      markdown: settings.markdown.enabled && item.level >= ROLE_LEVEL[settings.markdown.minRole],
      colors: settings.colors.enabled && item.level >= ROLE_LEVEL[settings.colors.minRole],
    };
  }

  const plainText = (item) => item.fragments.map((f) => f.text).join('');

  /**
   * options: { settings, showBadges, timestamps, fixedNameColor, deletedText }
   */
  function message(item, options) {
    injectCss();
    const { settings } = options;
    const root = el('div', 'cr-item cr-msg');
    root.dataset.id = item.id;
    root.dataset.user = item.user.id;
    if (item.own) root.classList.add('cr-own');
    if (item.highlighted) root.classList.add('cr-highlighted');
    if (item.deleted) root.classList.add('cr-deleted');

    if (item.replyTo) root.append(el('div', 'cr-reply', `↩ Antwort an @${item.replyTo}`));

    const head = el('span', 'cr-head');
    if (options.timestamps) {
      head.append(el('span', 'cr-time', new Date(item.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })));
    }
    if (options.showBadges) {
      for (const b of item.badges) {
        const url = assets.badges?.[b.set]?.[b.id] ?? assets.badges?.[b.set]?.['1'];
        if (!url) continue;
        const img = el('img', 'cr-badge');
        img.src = url;
        img.alt = b.set;
        img.title = b.set;
        head.append(img);
      }
    }
    const name = el('span', 'cr-name', item.user.name);
    const color = options.fixedNameColor || nameColor(item);
    name.style.color = options.darkBackground && !options.fixedNameColor ? readableOnDark(color) : color;
    name.dataset.login = item.user.login;
    if (item.user.login && item.user.name.toLowerCase() !== item.user.login.toLowerCase()) {
      name.append(' ', el('span', 'cr-login', `(${item.user.login})`));
    }
    head.append(name);
    root.append(head, el('span', 'cr-colon', ': '));

    const body = el('span', 'cr-text');
    if (item.deleted && options.deletedText) {
      body.append(el('em', 'cr-deleted-note', options.deletedText));
    } else {
      const perms = permissions(item, settings);
      for (const f of item.fragments) {
        if (f.type === 'emote' && f.emoteId && /^[\w-]+$/.test(f.emoteId)) {
          body.append(emoteImg(`https://static-cdn.jtvnw.net/emoticons/v2/${f.emoteId}/default/dark/2.0`, f.text));
        } else if (f.type === 'mention') {
          body.append(el('span', 'cr-mention', f.text));
        } else if (f.type === 'cheermote') {
          body.append(el('span', 'cr-cheer', f.text));
        } else {
          rich(f.text, body, perms);
        }
      }
    }
    root.append(body);
    return root;
  }

  // ------------------------------------------------------------ Event

  function event(item) {
    injectCss();
    const root = el('div', `cr-item cr-event cr-ev-${item.event}`);
    root.dataset.id = item.id;
    const line = el('div', 'cr-ev-line');
    line.append(el('span', 'cr-ev-icon', item.icon), ' ');
    const [before, after] = item.text.split('{user}');
    line.append(before ?? '');
    if (after !== undefined) line.append(el('span', 'cr-ev-user', item.user), after);
    if (item.test) line.append(el('span', 'cr-ev-test', ' [Test]'));
    root.append(line);
    if (item.detail) root.append(el('div', 'cr-ev-detail', item.detail));
    return root;
  }

  function hexToRgba(hex, opacity) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    if (!m) return 'transparent';
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${opacity / 100})`;
  }

  /** Overlay-Einstellungen als CSS-Variablen auf ein Element legen */
  function applyOverlayStyle(target, o) {
    loadFont(o.font);
    target.style.setProperty('--cr-font', `"${o.font}", "Segoe UI", sans-serif`);
    target.style.setProperty('--cr-size', `${o.fontSize}px`);
    target.style.setProperty('--cr-weight', String(o.fontWeight));
    target.style.setProperty('--cr-text', o.textColor);
    target.style.setProperty('--cr-bg', hexToRgba(o.background, o.backgroundOpacity));
    target.style.setProperty('--cr-radius', o.rounded ? '12px' : '0px');
    target.classList.toggle('cr-shadow', o.textShadow);
    target.classList.toggle('cr-stacked', o.layout === 'stacked');
    target.classList.toggle('cr-top', o.direction === 'top');
    target.classList.toggle('cr-right', o.align === 'right');
  }

  /** Soll ein Eintrag im OBS-Overlay erscheinen? */
  function overlayVisible(item, o) {
    if (item.hiddenReward || item.deleted) return false;
    if (item.kind === 'event') return !!o.events[item.event];
    if (o.hiddenUsers.includes((item.user.login || '').toLowerCase())) return false;
    if (o.hideCommands && plainText(item).trim().startsWith('!')) return false;
    return true;
  }

  /** Gemeinsames Aussehen des Overlays (auch für die Vorschau in den Einstellungen) */
  const OVERLAY_CSS = `
    .cr-overlay { display: flex; flex-direction: column; justify-content: flex-end; align-items: flex-start; gap: 6px; overflow: hidden; box-sizing: border-box; padding: 10px 12px; }
    .cr-overlay.cr-top { justify-content: flex-start; }
    .cr-overlay.cr-right { align-items: flex-end; }
    .cr-overlay .cr-item {
      font-family: var(--cr-font); font-size: var(--cr-size); font-weight: var(--cr-weight); color: var(--cr-text);
      background: var(--cr-bg); border-radius: var(--cr-radius); padding: .35em .7em; max-width: 100%;
      box-sizing: border-box; overflow-wrap: anywhere; line-height: 1.4; flex: none;
    }
    .cr-overlay.cr-shadow .cr-item { text-shadow: 0 1px 2px rgba(0,0,0,.85), 0 0 3px rgba(0,0,0,.6); }
    .cr-overlay.cr-stacked .cr-head { display: block; }
    .cr-overlay.cr-stacked .cr-colon { display: none; }
    .cr-overlay .cr-highlighted { box-shadow: inset 4px 0 0 #9146ff; }
    .cr-overlay .cr-event { box-shadow: inset 4px 0 0 var(--cr-ev, #9146ff); }
    .cr-ev-follow { --cr-ev: #b580ff; } .cr-ev-sub, .cr-ev-resub { --cr-ev: #ffd700; } .cr-ev-giftsub { --cr-ev: #ff6bd6; }
    .cr-ev-cheer { --cr-ev: #35d0ff; } .cr-ev-raid { --cr-ev: #ff9f43; } .cr-ev-redemption { --cr-ev: #4dff88; } .cr-ev-stream { --cr-ev: #ff4d4d; }
    .cr-anim-slide { animation: cr-slide .35s cubic-bezier(.2, 1.2, .4, 1) both; }
    .cr-overlay.cr-right .cr-anim-slide { animation-name: cr-slide-r; }
    .cr-anim-fade { animation: cr-fade .4s ease-out both; }
    .cr-anim-pop { animation: cr-pop .35s cubic-bezier(.2, 1.5, .4, 1) both; }
    .cr-out { transition: opacity .6s ease, transform .6s ease; opacity: 0; transform: translateY(-6px); }
    @keyframes cr-slide { from { opacity: 0; transform: translateX(-30px); } }
    @keyframes cr-slide-r { from { opacity: 0; transform: translateX(30px); } }
    @keyframes cr-fade { from { opacity: 0; } }
    @keyframes cr-pop { from { opacity: 0; transform: scale(.85); } }
  `;
  let overlayCssInjected = false;
  function injectOverlayCss() {
    if (overlayCssInjected) return;
    overlayCssInjected = true;
    const style = document.createElement('style');
    style.textContent = OVERLAY_CSS;
    (styleTarget ?? document.head).append(style);
  }

  /** Eintrag fürs Overlay bauen (Nachricht oder Event) */
  function overlayItem(item, settings, animate) {
    injectOverlayCss();
    const o = settings.overlay;
    const node = item.kind === 'message'
      ? message(item, { settings, showBadges: o.showBadges, fixedNameColor: o.nameColorMode === 'fixed' ? o.nameColor : null })
      : event(item);
    if (animate && o.animation !== 'none') node.classList.add(`cr-anim-${o.animation}`);
    return node;
  }

  return {
    setAssets, getAssets, setStyleTarget, message, event, plainText, nameColor, readableOnDark, ROLE_LEVEL, FONTS, loadFont,
    applyOverlayStyle, overlayVisible, overlayItem, injectOverlayCss,
  };
})();
