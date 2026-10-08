// Reiter „Musik-Sets“: Sets anlegen (verknüpft oder eigene Liste), Spielen zuordnen, Spielwechsel.
(() => {
  const { $, h, api, toast, toggle } = window.UI;
  const BASE = 'addons/music';

  const st = {
    data: null,
    /** Playlists für verknüpfte Sets (Spotify + Ordner) */
    lists: null,
  };

  const fill = (el, ...children) => el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  const fmt = (ms) => {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };

  async function load() {
    try {
      st.data = await api(`${BASE}/sets`);
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    render();
  }

  async function loadLists() {
    if (st.lists) return st.lists;
    try {
      st.lists = await api(`${BASE}/playlists`);
    } catch {
      st.lists = { spotify: [], local: [] };
    }
    return st.lists;
  }

  async function post(path, body, message) {
    try {
      st.data = { ...st.data, ...(await api(`${BASE}/${path}`, body)) };
      if (message) toast(message, 'ok');
      render();
      return true;
    } catch (err) {
      toast(err.message, 'err');
      return false;
    }
  }

  function sourceLabel(set) {
    if (set.type === 'custom') return `Eigene Liste · ${set.tracks.length} Titel`;
    const all = [...(st.lists?.spotify ?? []), ...(st.lists?.local ?? [])];
    const found = all.find((p) => p.id === set.source);
    if (found) return `${found.provider === 'local' ? '📁' : '🟢'} ${found.name}`;
    return set.source.startsWith('local:') ? `📁 ${set.source.slice(6) || 'Hauptordner'}` : `🟢 ${set.source}`;
  }

  // ============================================================ Liste

  function render() {
    if (!st.data) return;
    const { sets, activeSetId, defaultSetId, gameSet } = st.data;
    fill($('#sets'), sets.length
      ? sets.map((set) => h('div', { class: `set-card${set.id === activeSetId ? ' active' : ''}` },
        h('div', { class: 'set-main' },
          h('div', { class: 'set-name no-i18n' }, set.name,
            set.id === activeSetId ? h('span', { class: 'badge ok' }, 'läuft') : null,
            set.id === defaultSetId ? h('span', { class: 'badge' }, 'Standard') : null,
            set.id === gameSet && set.id !== activeSetId ? h('span', { class: 'badge accent' }, 'passt zum Spiel') : null),
          h('div', { class: 'note no-i18n' }, sourceLabel(set)),
          h('div', { class: 'chips' }, set.games.length
            ? set.games.map((g) => h('span', { class: 'chip no-i18n' }, `🎮 ${g.name}`))
            : h('span', { class: 'note' }, 'keinem Spiel zugeordnet'))),
        h('div', { class: 'set-actions' },
          h('button', { class: 'btn small', onclick: () => post('sets/play', { id: set.id }, `„${set.name}“ läuft`) }, '▶'),
          h('button', { class: 'btn small', onclick: () => openEditor(set) }, '✏️'),
          h('button', { class: 'btn small', onclick: () => {
            if (confirm(`Set „${set.name}“ löschen?`)) post('sets/delete', { id: set.id }, 'Gelöscht');
          } }, '🗑'))))
      : h('div', { class: 'empty' }, 'Noch keine Sets. Leg eins an – z.B. „Chill“ für Just Chatting und „Hype“ für Shooter.'));

    const game = st.data.currentGame;
    const matched = sets.find((s) => s.id === gameSet);
    fill($('#sets-game'),
      h('p', { class: 'auto-current' }, 'Aktuelle Kategorie: ', h('b', { class: 'no-i18n' }, game ? game.name : 'unbekannt')),
      h('p', { class: 'note' }, matched ? ['Dazu passt: ', h('b', { class: 'no-i18n' }, matched.name)] : 'Dazu passt kein Set (und es gibt kein Standard-Set).'),
      h('div', { class: 'opt-row' }, h('span', {}, 'Beim Spielwechsel automatisch umschalten'),
        toggle(st.data.switchOnGameChange, (on) => post('sets/settings', { switchOnGameChange: on }), 'Automatisch umschalten')),
      h('p', { class: 'note' }, 'Nur wenn gerade Musik läuft. Die Musik wird dabei kurz aus- und wieder eingeblendet; offene Songwünsche bleiben in der Queue.'),
      h('div', { class: 'field' }, h('label', {}, 'Standard-Set (Spiele ohne eigenes Set)'),
        h('select', { onchange: (e) => post('sets/settings', { defaultSetId: e.target.value }) },
          h('option', { value: '', selected: !defaultSetId }, '– nichts ändern –'),
          ...sets.map((s) => h('option', { value: s.id, selected: s.id === defaultSetId, class: 'no-i18n' }, s.name)))),
      h('p', { class: 'note' }, 'Per Streamdeck: POST /api/music/set mit { "set": "Name" }. Nach dem Intro: auf dem Reiter „Player“ als Auto-Start „Set passend zum Spiel“ wählen.'),
    );
  }

  // ============================================================ Editor

  function openEditor(existing) {
    const draft = existing
      ? structuredClone(existing)
      : { name: '', type: 'linked', source: '', tracks: [], games: [] };
    const host = $('#modal-host');
    const close = () => host.replaceChildren();

    const name = h('input', { type: 'text', class: 'no-i18n', value: draft.name, placeholder: 'z.B. Chill, Hype, Horror' });
    const body = h('div', { class: 'modal-body' });

    const renderBody = async () => {
      const typeRow = h('div', { class: 'seg-toggle' },
        ...[['linked', '🔗 Verknüpft'], ['custom', '📝 Eigene Liste']].map(([v, l]) => h('button', {
          class: draft.type === v ? 'on' : '',
          onclick: () => {
            draft.type = v;
            renderBody();
          },
        }, l)));
      fill(body,
        h('div', { class: 'field' }, h('label', {}, 'Name'), name),
        typeRow,
        draft.type === 'linked' ? await linkedEditor() : customEditor(),
        gamesEditor());
    };

    // ---- verknüpft: Playlist/Ordner auswählen oder Link einfügen
    const linkedEditor = async () => {
      const lists = await loadLists();
      const link = h('input', { type: 'text', class: 'no-i18n', placeholder: 'oder Spotify-Link einfügen (Playlist/Album)', value: draft.source.startsWith('spotify:') && ![...lists.spotify].some((p) => p.id === draft.source) ? draft.source : '' });
      link.oninput = () => {
        draft.source = link.value.trim();
      };
      const option = (p) => h('option', { value: p.id, selected: p.id === draft.source, class: 'no-i18n' }, `${p.name} (${p.count})`);
      const select = h('select', { onchange: (e) => {
        draft.source = e.target.value;
        link.value = '';
      } },
      h('option', { value: '' }, '– auswählen –'),
      lists.spotify.length ? h('optgroup', { label: 'Spotify' }, ...lists.spotify.map(option)) : null,
      lists.local.length ? h('optgroup', { label: 'Eigene Musik (Ordner)' }, ...lists.local.map(option)) : null);
      return h('div', { class: 'box' },
        h('div', { class: 'field' }, h('label', {}, 'Quelle'), select),
        link,
        h('p', { class: 'note' }, 'Die Titel pflegst du weiter in Spotify bzw. im Ordner.'));
    };

    // ---- eigene Liste: suchen und Titel hinzufügen
    const customEditor = () => {
      let where = 'spotify';
      const q = h('input', { type: 'search', class: 'no-i18n', placeholder: 'Song suchen oder Spotify-Link einfügen' });
      const results = h('div', { class: 'search-results' });
      const list = h('div', { class: 'track-list' });

      const renderList = () => fill(list, draft.tracks.length
        ? draft.tracks.map((t, i) => h('div', { class: 'track' },
          h('span', { class: 'track-no' }, i + 1),
          t.image ? h('img', { src: t.image, alt: '' }) : h('span', { class: 'track-icon' }, t.kind === 'local' ? '📁' : '🟢'),
          h('div', { class: 'track-main no-i18n' }, h('b', {}, t.title), h('span', {}, t.artists.join(', '))),
          h('span', { class: 'note' }, fmt(t.durationMs)),
          h('button', { class: 'icon-btn', title: 'Nach oben', disabled: i === 0, onclick: () => {
            [draft.tracks[i - 1], draft.tracks[i]] = [draft.tracks[i], draft.tracks[i - 1]];
            renderList();
          } }, '↑'),
          h('button', { class: 'icon-btn', title: 'Nach unten', disabled: i === draft.tracks.length - 1, onclick: () => {
            [draft.tracks[i + 1], draft.tracks[i]] = [draft.tracks[i], draft.tracks[i + 1]];
            renderList();
          } }, '↓'),
          h('button', { class: 'icon-btn', title: 'Entfernen', onclick: () => {
            draft.tracks.splice(i, 1);
            renderList();
          } }, '✕')))
        : h('div', { class: 'empty' }, 'Noch keine Titel – oben suchen und mit ＋ hinzufügen.'));

      let timer = null;
      const search = async () => {
        const text = q.value.trim();
        if (!text) return results.replaceChildren();
        try {
          const items = await api(`${BASE}/search?where=${where}&q=${encodeURIComponent(text)}`);
          fill(results, items.length
            ? items.map((t) => h('div', { class: 'track' },
              t.image ? h('img', { src: t.image, alt: '' }) : h('span', { class: 'track-icon' }, t.kind === 'local' ? '📁' : '🟢'),
              h('div', { class: 'track-main no-i18n' }, h('b', {}, t.title), h('span', {}, t.artists.join(', '))),
              h('span', { class: 'note' }, fmt(t.durationMs)),
              h('button', { class: 'btn small', onclick: () => {
                if (draft.tracks.some((x) => x.kind === t.kind && x.ref === t.ref)) return toast('Ist schon drin.', 'info');
                draft.tracks.push({ kind: t.kind, ref: t.ref, title: t.title, artists: t.artists, durationMs: t.durationMs, image: t.image });
                renderList();
              } }, '＋')))
            : h('div', { class: 'empty' }, 'Nichts gefunden.'));
        } catch (err) {
          fill(results, h('div', { class: 'empty' }, err.message));
        }
      };
      q.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(search, 350);
      };
      const whereRow = h('div', { class: 'seg-toggle small' },
        ...[['spotify', '🟢 Spotify'], ['local', '📁 Eigene Musik']].map(([v, l]) => {
          const b = h('button', { class: where === v ? 'on' : '', onclick: () => {
            where = v;
            [...whereRow.children].forEach((c) => c.classList.toggle('on', c === b));
            search();
          } }, l);
          return b;
        }));
      renderList();
      return h('div', { class: 'box' }, h('div', { class: 'auto-row' }, q, whereRow), results, h('label', { class: 'note' }, 'Titel im Set:'), list,
        h('p', { class: 'note' }, 'Zufällig/Wiederholen gelten wie auf dem Reiter „Player“ eingestellt.'));
    };

    // ---- Spiele zuordnen
    const gamesEditor = () => {
      const chips = h('div', { class: 'chips' });
      const renderChips = () => fill(chips, draft.games.length
        ? draft.games.map((g, i) => h('span', { class: 'chip no-i18n' }, `🎮 ${g.name}`, h('button', { onclick: () => {
          draft.games.splice(i, 1);
          renderChips();
        } }, '✕')))
        : h('span', { class: 'note' }, 'Noch keinem Spiel zugeordnet.'));
      const q = h('input', { type: 'search', placeholder: 'Spiel/Kategorie suchen, z.B. Minecraft' });
      const results = h('div', { class: 'game-results' });
      let timer = null;
      q.oninput = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
          const text = q.value.trim();
          if (!text) return results.replaceChildren();
          try {
            const games = await api(`${BASE}/games/search?q=${encodeURIComponent(text)}`);
            fill(results, games.map((g) => h('button', { class: 'game-pick', onclick: () => {
              if (!draft.games.some((x) => x.id === g.id)) draft.games.push({ id: g.id, name: g.name });
              renderChips();
              q.value = '';
              results.replaceChildren();
            } }, h('img', { src: g.image, alt: '' }), h('span', { class: 'no-i18n' }, g.name))));
          } catch (err) {
            fill(results, h('div', { class: 'empty' }, err.message));
          }
        }, 350);
      };
      const current = st.data.currentGame;
      renderChips();
      return h('div', { class: 'box' },
        h('label', {}, '🎮 Läuft automatisch bei diesen Spielen'),
        chips,
        q,
        current && !draft.games.some((g) => g.id === current.id)
          ? h('button', { class: 'link-btn', onclick: () => {
            draft.games.push(current);
            renderChips();
          } }, `＋ aktuelles Spiel (${current.name})`)
          : null,
        results,
        h('p', { class: 'note' }, 'Ein Spiel gehört zu genau einem Set – beim Speichern wird es aus anderen Sets entfernt.'));
    };

    const save = async () => {
      draft.name = name.value.trim();
      try {
        const res = await api(`${BASE}/sets/save`, { set: draft });
        st.data = { ...st.data, ...res };
        toast('Set gespeichert', 'ok');
        close();
        render();
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    host.replaceChildren(h('div', { class: 'modal-back', onclick: (e) => {
      if (e.target === e.currentTarget) close();
    } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, existing ? 'Set bearbeiten' : 'Neues Set'), h('button', { class: 'icon-btn', onclick: close }, '✕')),
      body,
      h('div', { class: 'modal-foot' }, h('span', { class: 'spacer' }), h('button', { class: 'btn', onclick: close }, 'Abbrechen'), h('button', { class: 'btn primary', onclick: save }, 'Speichern')))));
    renderBody();
    name.focus();
  }

  $('#set-new').onclick = () => openEditor(null);

  window.addEventListener('music-msg', (e) => {
    if (e.detail.type === 'music.sets') {
      const { type, ...rest } = e.detail;
      st.data = rest;
      render();
    }
  });
  window.addEventListener('music-tab', (e) => {
    if (e.detail === 'sets') {
      loadLists().then(render);
      load();
    }
  });

  load();
})();
