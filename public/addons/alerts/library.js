// Eingebaute Bilder (animierte SVGs) und Sounds (live erzeugt per Web Audio) –
// selbst gemacht, also keine Probleme mit Urheberrechten im Stream.
window.AlertLibrary = (() => {
  // ------------------------------------------------------------------ Bilder

  const INK = '#151515';
  const LINE = `stroke="${INK}" stroke-width="7" stroke-linejoin="round" stroke-linecap="round"`;
  const YELLOW = '#FFE14D';
  const RED = '#FF3B3B';

  /** Form mit gelbem "3D"-Versatz dahinter */
  const layered = (tag, attrs, fill = '#fff') =>
    `<g transform="translate(7 6)"><${tag} ${attrs} fill="${YELLOW}" ${LINE}/></g><${tag} ${attrs} fill="${fill}" ${LINE}/>`;
  const shadow = '<ellipse cx="100" cy="190" rx="58" ry="7" fill="#000" opacity=".3"/>';
  const sparks = (points) =>
    `<g class="ma-twinkle">${points.map(([x1, y1, x2, y2]) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${RED}" stroke-width="6" stroke-linecap="round"/>`).join('')}</g>`;
  const svg = (inner) => `<svg class="ma-svg" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`;

  const HEART = 'M100 168 C 45 128, 22 98, 30 66 C 38 36, 80 30, 100 62 C 120 30, 162 36, 170 66 C 178 98, 155 128, 100 168 Z';

  const images = {
    heart: {
      name: 'Herzen',
      svg: svg(`${shadow}
        <g class="ma-pulse">${layered('path', `d="${HEART}"`)}</g>
        <g transform="translate(-6 60) scale(.42)"><g class="ma-bob">${layered('path', `d="${HEART}"`)}</g></g>
        ${sparks([[156, 30, 166, 14], [172, 50, 190, 44], [30, 150, 16, 162]])}`),
    },
    star: {
      name: 'Stern',
      svg: svg(`${shadow}
        <g class="ma-wiggle">${layered('polygon', 'points="100,22 119,72 172,74 131,107 145,160 100,130 55,160 69,107 28,74 81,72"')}</g>
        ${sparks([[30, 30, 42, 44], [172, 32, 160, 46], [178, 128, 192, 136]])}`),
    },
    gift: {
      name: 'Geschenk',
      svg: svg(`${shadow}
        <g class="ma-bob">
          ${layered('rect', 'x="40" y="92" width="120" height="84" rx="6"')}
          ${layered('rect', 'x="32" y="70" width="136" height="28" rx="6"')}
          <rect x="89" y="70" width="22" height="106" fill="#9146FF" ${LINE}/>
          <path d="M100 70 C 70 30, 44 52, 70 68 Z M100 70 C 130 30, 156 52, 130 68 Z" fill="#9146FF" ${LINE}/>
        </g>
        ${sparks([[26, 50, 14, 38], [176, 60, 192, 52], [176, 150, 190, 160]])}`),
    },
    diamond: {
      name: 'Diamant',
      svg: svg(`${shadow}
        <g class="ma-bob">
          ${layered('polygon', 'points="66,36 134,36 170,80 100,170 30,80"', '#D9C2FF')}
          <path d="M30 80 H170 M66 36 L84 80 L100 170 L116 80 L134 36 M84 80 L100 36 L116 80" fill="none" ${LINE}/>
        </g>
        ${sparks([[22, 40, 34, 52], [178, 36, 166, 50], [170, 140, 186, 150]])}`),
    },
    rocket: {
      name: 'Rakete',
      svg: svg(`${shadow}
        <g class="ma-bob">
          <path class="ma-flicker" d="M84 140 Q100 196 116 140 Z" fill="#FF7A2C" ${LINE}/>
          ${layered('path', 'd="M72 118 L46 150 L78 142 Z"')}
          ${layered('path', 'd="M128 118 L154 150 L122 142 Z"')}
          ${layered('path', 'd="M100 18 C 134 46, 140 96, 128 142 L 72 142 C 60 96, 66 46, 100 18 Z"')}
          <circle cx="100" cy="78" r="15" fill="#9146FF" ${LINE}/>
        </g>
        ${sparks([[34, 60, 20, 52], [168, 60, 184, 50], [40, 110, 26, 118]])}`),
    },
    sparkle: {
      name: 'Funkeln',
      svg: svg(`${shadow}
        <g class="ma-pulse">${layered('path', 'd="M100 18 C 108 76, 122 90, 180 98 C 122 106, 108 120, 100 178 C 92 120, 78 106, 20 98 C 78 90, 92 76, 100 18 Z"')}</g>
        <g class="ma-twinkle"><path d="M160 24 C 162 38, 166 42, 180 44 C 166 46, 162 50, 160 64 C 158 50, 154 46, 140 44 C 154 42, 158 38, 160 24 Z" fill="${YELLOW}" ${LINE}/></g>
        ${sparks([[30, 36, 42, 50], [28, 160, 40, 150]])}`),
    },
    trophy: {
      name: 'Pokal',
      svg: svg(`${shadow}
        <g class="ma-wiggle">
          <path d="M58 52 H34 C 34 88, 50 98, 66 98 M142 52 H166 C 166 88, 150 98, 134 98" fill="none" ${LINE}/>
          ${layered('path', 'd="M56 34 H144 V80 C144 114 122 130 100 130 C78 130 56 114 56 80 Z"', YELLOW)}
          <rect x="90" y="130" width="20" height="24" fill="${YELLOW}" ${LINE}/>
          ${layered('rect', 'x="64" y="152" width="72" height="20" rx="5"')}
        </g>
        ${sparks([[24, 30, 36, 44], [176, 30, 164, 44], [22, 130, 8, 136]])}`),
    },
    party: {
      name: 'Party',
      svg: svg(`${shadow}
        <g class="ma-wiggle">
          ${layered('path', 'd="M100 26 L150 170 H50 Z"', '#9146FF')}
          <path d="M80 84 L120 84 M68 118 L132 118 M58 150 L142 150" stroke="${YELLOW}" stroke-width="10" stroke-linecap="round"/>
          <path d="M100 26 L150 170 H50 Z" fill="none" ${LINE}/>
          <circle cx="100" cy="22" r="12" fill="${YELLOW}" ${LINE}/>
        </g>
        ${sparks([[34, 50, 20, 40], [166, 50, 180, 40], [30, 110, 14, 110], [170, 110, 186, 110]])}`),
    },
  };

  // ------------------------------------------------------------------ Sounds

  let audioCtx = null;
  const getCtx = () => {
    audioCtx ||= new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
    return audioCtx;
  };

  function tools(ctx, out) {
    const now = ctx.currentTime + 0.02;
    return {
      /** Ton mit kurzem Anschlag und Ausklingen */
      tone(freq, start, dur, type = 'sine', gain = 0.3, lowpass = 0) {
        const t = now + start;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.value = freq;
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        let node = osc;
        if (lowpass) {
          const f = ctx.createBiquadFilter();
          f.type = 'lowpass';
          f.frequency.value = lowpass;
          osc.connect(f);
          node = f;
        }
        node.connect(g).connect(out);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      },
      /** Ton, der die Tonhöhe ändert */
      sweep(from, to, start, dur, type = 'sine', gain = 0.3) {
        const t = now + start;
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(from, t);
        osc.frequency.exponentialRampToValueAtTime(to, t + dur);
        g.gain.setValueAtTime(gain, t);
        g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
        osc.connect(g).connect(out);
        osc.start(t);
        osc.stop(t + dur + 0.05);
      },
      /** Rauschen durch einen wandernden Filter (Whoosh) */
      noise(start, dur, from, to, gain = 0.4) {
        const t = now + start;
        const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * dur), ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const f = ctx.createBiquadFilter();
        f.type = 'bandpass';
        f.Q.value = 1.5;
        f.frequency.setValueAtTime(from, t);
        f.frequency.exponentialRampToValueAtTime(to, t + dur);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(gain, t + dur * 0.4);
        g.gain.linearRampToValueAtTime(0, t + dur);
        src.connect(f).connect(g).connect(out);
        src.start(t);
        src.stop(t + dur);
      },
    };
  }

  const sounds = {
    chime: { name: 'Glockenspiel', play: (t) => [660, 880, 1320].forEach((f, i) => t.tone(f, i * 0.12, 0.6, 'sine', 0.3)) },
    pop: { name: 'Pop', play: (t) => { t.sweep(300, 1100, 0, 0.12, 'sine', 0.5); t.tone(1400, 0.1, 0.15, 'sine', 0.15); } },
    coin: { name: 'Münze', play: (t) => { t.tone(988, 0, 0.1, 'square', 0.12); t.tone(1319, 0.08, 0.5, 'square', 0.12); } },
    fanfare: {
      name: 'Fanfare',
      play: (t) => [[523, 0, 0.18], [659, 0.16, 0.18], [784, 0.32, 0.18], [1047, 0.48, 0.9]]
        .forEach(([f, s, d]) => { t.tone(f, s, d, 'sawtooth', 0.12, 2200); t.tone(f / 2, s, d, 'triangle', 0.15); }),
    },
    levelup: { name: 'Level-Up', play: (t) => [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => t.tone(f, i * 0.07, 0.25, 'square', 0.1)) },
    bell: { name: 'Glocke', play: (t) => { t.tone(880, 0, 2, 'sine', 0.3); t.tone(1760, 0, 1.2, 'sine', 0.1); t.tone(2640, 0, 0.8, 'sine', 0.05); } },
    whoosh: { name: 'Whoosh', play: (t) => t.noise(0, 0.7, 300, 4000, 0.5) },
    blip: { name: 'Blip', play: (t) => { t.tone(1200, 0, 0.08, 'square', 0.1); t.tone(1600, 0.1, 0.12, 'square', 0.1); } },
    tada: {
      name: 'Tada',
      play: (t) => {
        t.noise(0, 0.25, 800, 3000, 0.25);
        [523, 659, 784].forEach((f) => t.tone(f, 0.18, 1.2, 'triangle', 0.18));
        [1047, 1319].forEach((f) => t.tone(f, 0.18, 1, 'sine', 0.08));
      },
    },
    tense: {
      name: 'Spannung',
      play: (t) => { t.tone(110, 0, 1.6, 'sawtooth', 0.12, 600); t.tone(116.5, 0, 1.6, 'sawtooth', 0.12, 600); t.sweep(200, 90, 0, 1.4, 'sine', 0.2); },
    },
  };

  /** Eingebauten Sound abspielen (Lautstärke 0–100) */
  function playSound(id, volume = 50) {
    const def = sounds[id];
    if (!def) return;
    try {
      const ctx = getCtx();
      const master = ctx.createGain();
      master.gain.value = Math.max(0, Math.min(1, volume / 100));
      master.connect(ctx.destination);
      def.play(tools(ctx, master));
    } catch {
      // Kein Audio verfügbar
    }
  }

  return { images, sounds, playSound };
})();
