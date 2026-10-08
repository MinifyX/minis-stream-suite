// Kleiner Musik-Player (Now Playing + Knöpfe + Lautstärke), z.B. auf der Intro-Seite.
// MusicMini.mount(container) → false, wenn das Musik-Addon aus ist.
window.MusicMini = (() => {
  const { h, api, toast } = window.UI;

  async function mount(container) {
    let s;
    try {
      s = await api('addons/music/state');
    } catch {
      return false;
    }
    let receivedAt = Date.now();
    let dragging = false;

    const cover = h('div', { class: 'mm-cover' });
    const title = h('div', { class: 'mm-title no-i18n' });
    const artist = h('div', { class: 'mm-artist no-i18n' });
    const bar = h('div', { class: 'mm-bar-fill' });
    const time = h('span', { class: 'mm-time' });
    const toggleBtn = h('button', { class: 'btn mm-btn', title: 'Play/Pause' });
    const volume = h('input', { type: 'range', min: 0, max: 100, class: 'mm-vol' });
    const volLabel = h('span', { class: 'mm-vol-label' });
    const provider = h('div', { class: 'note' });

    const cmd = async (action) => {
      try {
        s = await api('addons/music/cmd', { action });
        receivedAt = Date.now();
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    };
    toggleBtn.onclick = () => cmd('toggle');
    volume.oninput = () => {
      dragging = true;
      volLabel.textContent = `${volume.value}%`;
    };
    volume.onchange = async () => {
      dragging = false;
      try {
        s = await api('addons/music/volume', { volume: Number(volume.value) });
      } catch (err) {
        toast(err.message, 'err');
      }
      render();
    };

    const fmt = (ms) => {
      const sec = Math.max(0, Math.floor(ms / 1000));
      return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
    };

    function progress() {
      const np = s.nowPlaying;
      if (!np || !np.durationMs) {
        bar.style.width = '0';
        time.textContent = '';
        return;
      }
      const pos = Math.min(np.durationMs, np.positionMs + (np.isPlaying ? Date.now() - receivedAt : 0));
      bar.style.width = `${(pos / np.durationMs) * 100}%`;
      time.textContent = `${fmt(pos)} / ${fmt(np.durationMs)}`;
    }

    function render() {
      const np = s.nowPlaying;
      if (np?.coverUrl) {
        const img = cover.querySelector('img');
        if (!img || img.getAttribute('src') !== np.coverUrl) cover.replaceChildren(h('img', { src: np.coverUrl, alt: '' }));
      } else cover.replaceChildren('🎵');
      title.textContent = np ? np.title : 'Gerade läuft nichts';
      artist.textContent = np ? np.artists.join(', ') : '';
      toggleBtn.textContent = np?.isPlaying ? '⏸' : '▶';
      if (!dragging) {
        volume.value = s.volume;
        volLabel.textContent = `${s.volume}%`;
      }
      const label = s.providers?.find((p) => p.id === s.provider)?.label ?? s.provider;
      provider.textContent = `Quelle: ${label}${s.fallback ? ' (Ersatz, weil Spotify in der Suite gerade nicht geht)' : ''}`;
      progress();
    }

    container.replaceChildren(h('div', { class: 'mm' },
      cover,
      h('div', { class: 'mm-main' },
        title, artist,
        h('div', { class: 'mm-bar' }, bar),
        h('div', { class: 'mm-row' },
          h('button', { class: 'btn mm-btn', title: 'Zurück', onclick: () => cmd('previous') }, '⏮'),
          toggleBtn,
          h('button', { class: 'btn mm-btn', title: 'Weiter', onclick: () => cmd('next') }, '⏭'),
          time,
          h('span', { class: 'spacer' }),
          h('span', {}, '🔊'), volume, volLabel),
        provider)));

    const style = document.getElementById('mm-style') ?? document.head.appendChild(h('style', { id: 'mm-style' }));
    style.textContent = `
      .mm { display: flex; gap: 14px; align-items: center; }
      .mm-cover { width: 84px; height: 84px; border-radius: 10px; flex: none; overflow: hidden; display: grid; place-items: center; font-size: 34px; background: linear-gradient(135deg, #9147ff, #ff4fd8); }
      .mm-cover img { width: 100%; height: 100%; object-fit: cover; }
      .mm-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
      .mm-title { font-size: 17px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .mm-artist { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 1.5em; }
      .mm-bar { height: 4px; border-radius: 2px; background: var(--card-2); overflow: hidden; margin: 4px 0; }
      .mm-bar-fill { height: 100%; background: var(--accent); width: 0; transition: width .5s linear; }
      .mm-row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .mm-btn { padding: 6px 12px; font-size: 15px; }
      .mm-time { font: 12px Consolas, monospace; color: var(--muted); margin-left: 6px; }
      .mm .mm-vol { width: 120px; }
      .mm-vol-label { font: 12px Consolas, monospace; color: var(--muted); min-width: 36px; }
    `;

    render();
    setInterval(progress, 500);

    const connect = () => {
      const ws = new WebSocket(`ws://${location.host}/ws?channel=music`);
      ws.onmessage = (m) => {
        const msg = JSON.parse(m.data);
        if (msg.type === 'music.nowPlaying') {
          s.nowPlaying = msg.nowPlaying;
          receivedAt = Date.now();
          render();
        } else if (msg.type === 'music.state') {
          Object.assign(s, msg);
          render();
        }
      };
      ws.onclose = () => setTimeout(connect, 2000);
    };
    connect();
    return true;
  }

  return { mount };
})();
