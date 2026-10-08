// Reiter „Songwünsche“: Vorschläge freigeben, Queue sortieren, Regeln, Kanalpunkte, Chat-Texte.
(() => {
  const { $, h, api, toast, toggle } = window.UI;
  const BASE = 'addons/music';

  const ROLES = [['everyone', 'Alle'], ['subscriber', 'Subs'], ['vip', 'VIPs'], ['moderator', 'Mods'], ['broadcaster', 'Nur du']];
  const MESSAGES = [
    ['queued', 'In der Queue', '{user} {title} {artist} {pos}'],
    ['suggested', 'Als Vorschlag gespeichert', '{user} {title} {artist}'],
    ['approved', 'Vorschlag angenommen', '{user} {title} {artist} {pos}'],
    ['rejected', 'Abgelehnt', '{user} {title} {artist}'],
    ['notFound', 'Nichts gefunden', '{user}'],
    ['denied', 'Geht nicht (Grund)', '{user} {reason}'],
    ['song', '!song', '{title} {artist} {requested}'],
    ['nothing', '!song, wenn nichts läuft', ''],
    ['removed', '!wrongsong', '{user} {title}'],
    ['queueList', '!queue', '{list}'],
    ['queueEmpty', '!queue, wenn leer', ''],
  ];

  const st = { data: null };
  const fill = (el, ...children) => el.replaceChildren(...children.flat().filter((c) => c !== null && c !== undefined && c !== false));
  const fmt = (ms) => {
    if (!ms) return '';
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  const ago = (ts) => {
    const min = Math.floor((Date.now() - ts) / 60000);
    return min < 1 ? 'gerade eben' : `vor ${min} Min.`;
  };

  async function load() {
    try {
      st.data = await api(`${BASE}/requests`);
    } catch (err) {
      toast(err.message, 'err');
      return;
    }
    render();
  }

  async function post(path, body, message) {
    try {
      st.data = await api(`${BASE}/${path}`, body);
      if (message) toast(message, 'ok');
      render();
      return true;
    } catch (err) {
      toast(err.message, 'err');
      return false;
    }
  }

  const sourceIcon = (r) => ({ chat: '💬', reward: '💜', panel: '🎛' }[r.source] ?? '');

  function row(r, actions) {
    const t = r.item;
    return h('div', { class: `req${r.status === 'playing' ? ' playing' : ''}` },
      t.image ? h('img', { src: t.image, alt: '' }) : h('span', { class: 'track-icon' }, t.kind === 'local' ? '📁' : '🟢'),
      h('div', { class: 'track-main no-i18n' }, h('b', {}, t.title), h('span', {}, t.artists.join(', '))),
      h('div', { class: 'req-meta' }, h('span', { class: 'no-i18n' }, `${sourceIcon(r)} ${r.user.name}`), h('span', { class: 'note' }, `${fmt(t.durationMs)} · ${ago(r.at)}`)),
      h('div', { class: 'req-actions' }, ...actions));
  }

  function render() {
    if (!st.data) return;
    const { open, history, settings: rs, list } = st.data;
    const pending = open.filter((r) => r.status === 'pending');
    const queued = open.filter((r) => r.status === 'queued' || r.status === 'playing').sort((a, b) => (a.status === 'playing' ? -1 : b.status === 'playing' ? 1 : a.position - b.position));

    const badge = $('#pending-badge');
    badge.hidden = !pending.length;
    badge.textContent = pending.length;

    $('#req-status').textContent = rs.enabled ? `an · ${rs.command}` : 'aus';
    fill($('#req-pending'), pending.length
      ? pending.map((r) => row(r, [
        h('button', { class: 'btn small primary', title: 'Annehmen', onclick: () => post('requests/approve', { id: r.id }) }, '✓'),
        h('button', { class: 'btn small', title: 'Ablehnen', onclick: () => post('requests/reject', { id: r.id }) }, '✕'),
      ]))
      : h('div', { class: 'empty' }, 'Keine offenen Vorschläge.'));

    $('#req-list-info').textContent = list ? `danach eigene Liste „${list.name}“` : '';
    fill($('#req-queue'), queued.length
      ? queued.map((r) => row(r, r.status === 'playing'
        ? [h('span', { class: 'badge ok' }, '▶ läuft')]
        : [
          h('span', { class: 'req-pos' }, `#${r.position}`),
          r.locked ? h('span', { class: 'badge', title: 'Schon an Spotify übergeben – kommt als Nächstes' }, '🔒') : null,
          h('button', { class: 'icon-btn', title: 'Nach oben', disabled: r.locked, onclick: () => post('requests/move', { id: r.id, delta: -1 }) }, '↑'),
          h('button', { class: 'icon-btn', title: 'Nach unten', disabled: r.locked, onclick: () => post('requests/move', { id: r.id, delta: 1 }) }, '↓'),
          h('button', { class: 'icon-btn', title: 'Entfernen (Kanalpunkte gibt es zurück)', disabled: r.locked, onclick: () => post('requests/reject', { id: r.id, announce: false }) }, '✕'),
        ]))
      : h('div', { class: 'empty' }, 'Die Queue ist leer.'));

    const statusText = { played: '✓ gespielt', rejected: '✕ abgelehnt', removed: '– entfernt' };
    fill($('#req-history'), history.length
      ? history.map((r) => row(r, [h('span', { class: 'note' }, statusText[r.status] ?? r.status)]))
      : h('div', { class: 'empty' }, 'Noch nichts.'));

    // Formulare nur neu bauen, wenn sich die Einstellungen geändert haben (sonst geht beim Tippen der Fokus verloren)
    const key = JSON.stringify(rs);
    if (key !== st.settingsKey) {
      st.settingsKey = key;
      renderSettings(rs);
      renderReward(rs);
      renderMessages(rs);
    }
  }

  // ============================================================ Einstellungen

  const roleSelect = (value, onchange) => h('select', { onchange: (e) => onchange(e.target.value) },
    ...ROLES.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));

  function renderSettings(rs) {
    const save = (patch) => post('requests/settings', patch);
    const number = (key, label, min, max, factor = 1) => h('div', { class: 'field' }, h('label', {}, label),
      h('input', { type: 'number', min, max, value: rs[key] / factor, onchange: (e) => save({ [key]: Number(e.target.value) * factor }) }));
    const command = h('input', { type: 'text', class: 'no-i18n', value: rs.command, onchange: () => save({ command: command.value }) });
    const block = h('textarea', { class: 'no-i18n', rows: 3, placeholder: 'ein Wort oder Artist pro Zeile' });
    block.value = rs.blocklist.join('\n');
    block.onchange = () => save({ blocklist: block.value });

    fill($('#req-settings'),
      h('div', { class: 'opt-row' }, h('span', {}, 'Songwünsche an'), toggle(rs.enabled, (on) => save({ enabled: on }), 'Songwünsche an')),
      h('div', { class: 'f-row' },
        h('div', { class: 'field' }, h('label', {}, 'Chat-Command'), command),
        h('div', { class: 'field' }, h('label', {}, 'Wo suchen'),
          h('select', { onchange: (e) => save({ source: e.target.value }) },
            ...[['auto', 'passend zur Quelle'], ['spotify', 'Spotify'], ['local', 'Eigene Musik']].map(([v, l]) => h('option', { value: v, selected: v === rs.source }, l))))),
      h('div', { class: 'f-row' },
        h('div', { class: 'field' }, h('label', {}, 'Wer darf wünschen'), roleSelect(rs.whoCanRequest, (v) => save({ whoCanRequest: v }))),
        h('div', { class: 'field' }, h('label', {}, 'Direkt in die Queue ab'), roleSelect(rs.directRole, (v) => save({ directRole: v })))),
      h('p', { class: 'note' }, 'Darunter wird ein Wunsch zum Vorschlag, den du (oder ein Mod hier in der Suite) freigibst.'),
      h('div', { class: 'f-row' },
        number('maxPerUser', 'Offene Wünsche pro Zuschauer', 1, 50),
        number('maxQueue', 'Queue max.', 1, 200)),
      h('div', { class: 'f-row' },
        number('maxDurationSec', 'Max. Länge (Min., 0 = egal)', 0, 60, 60),
        number('userCooldownSec', 'Wartezeit pro Zuschauer (Sek.)', 0, 3600)),
      h('div', { class: 'opt-row' }, h('span', {}, 'Explizite Songs erlauben'), toggle(rs.allowExplicit, (on) => save({ allowExplicit: on }), 'Explizite Songs erlauben')),
      h('div', { class: 'opt-row' }, h('span', {}, 'Im Chat antworten'), toggle(rs.reply, (on) => save({ reply: on }), 'Im Chat antworten')),
      h('div', { class: 'field' }, h('label', {}, 'Sperrliste'), block),
      h('p', { class: 'note' }, `Im Chat: ${rs.command} Songname oder Spotify-Link · !song · !wrongsong · !queue · !skip (Mods). Mods und du haben keine Limits.`),
    );
  }

  function renderReward(rs) {
    const title = h('input', { type: 'text', class: 'no-i18n', value: rs.rewardTitle, maxlength: 45 });
    const cost = h('input', { type: 'number', min: 1, value: rs.rewardCost });
    fill($('#req-reward'),
      h('p', { class: 'note' }, 'Die Suite legt die Belohnung selbst an – nur so kann sie bei Ablehnung die Punkte zurückgeben. Zuschauer geben beim Einlösen den Song ein.'),
      h('div', { class: 'f-row' },
        h('div', { class: 'field' }, h('label', {}, 'Name'), title),
        h('div', { class: 'field' }, h('label', {}, 'Kosten'), cost)),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn small primary', onclick: () => post('requests/reward', { title: title.value, cost: Number(cost.value) }, rs.rewardId ? 'Belohnung geändert' : 'Belohnung angelegt') },
          rs.rewardId ? 'Speichern' : '＋ Belohnung anlegen'),
        rs.rewardId ? h('button', { class: 'btn small', onclick: () => {
          if (confirm('Belohnung bei Twitch löschen?')) post('requests/reward/delete', {}, 'Belohnung gelöscht');
        } }, 'Löschen') : null),
      rs.rewardId ? h('p', { class: 'note' }, '✓ Belohnung ist angelegt.') : null,
      h('div', { class: 'opt-row' }, h('span', {}, 'Kanalpunkte-Wünsche direkt in die Queue'), toggle(rs.rewardDirect, (on) => post('requests/settings', { rewardDirect: on }), 'Direkt in die Queue')),
    );
  }

  function renderMessages(rs) {
    fill($('#req-messages'),
      h('p', { class: 'note' }, 'Platzhalter stehen jeweils dabei. Leer = Standardtext.'),
      ...MESSAGES.map(([key, label, vars]) => {
        const input = h('input', { type: 'text', class: 'no-i18n', value: rs.messages[key] });
        input.onchange = () => post('requests/settings', { messages: { [key]: input.value } }, 'Gespeichert');
        return h('div', { class: 'field' }, h('label', {}, label, vars ? h('span', { class: 'note no-i18n' }, `  ${vars}`) : null), input);
      }));
  }

  // ============================================================ Ausprobieren

  function renderTest() {
    const q = h('input', { type: 'text', class: 'no-i18n', placeholder: 'z.B. daft punk one more time' });
    let role = 'everyone';
    let reward = false;
    const send = async () => {
      if (await post('requests/test', { query: q.value, role, reward })) q.value = '';
    };
    q.onkeydown = (e) => {
      if (e.key === 'Enter') send();
    };
    fill($('#req-test'),
      h('p', { class: 'note' }, 'Wunsch eines Test-Zuschauers – es geht nichts in den Chat, die Antwort steht im Log (Reiter „Player“).'),
      q,
      h('div', { class: 'f-row' },
        roleSelect(role, (v) => {
          role = v;
        }),
        h('label', { class: 'opt-row' }, toggle(false, (on) => {
          reward = on;
        }, 'per Kanalpunkte'), h('span', {}, 'per Kanalpunkte'))),
      h('button', { class: 'btn small', onclick: send }, '🧪 Wunsch schicken'));
  }

  $('#req-add').onclick = async () => {
    const input = $('#req-add-q');
    if (await post('requests/add', { query: input.value }, 'Eingereiht')) input.value = '';
  };
  $('#req-add-q').onkeydown = (e) => {
    if (e.key === 'Enter') $('#req-add').click();
  };

  window.addEventListener('music-msg', (e) => {
    if (e.detail.type === 'music.requests') {
      const { type, ...rest } = e.detail;
      st.data = rest;
      render();
    }
  });

  setInterval(() => {
    // „vor X Min.“ aktuell halten
    if (st.data && !document.hidden) render();
  }, 60_000);

  renderTest();
  load();
})();
