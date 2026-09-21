const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/timers';

const VARIABLES = [
  ['{channel}', 'Dein Kanalname'],
  ['{game}', 'Aktuelles Spiel / Kategorie'],
  ['{title}', 'Stream-Titel'],
  ['{uptime}', 'Wie lange der Stream schon läuft'],
  ['{random:1-100}', 'Zufallszahl im Bereich'],
  ['{pick:a|b|c}', 'Zufällige Auswahl'],
];

const TEMPLATES = [
  { name: 'Discord', messages: ['Komm auf meinen Discord: https://discord.gg/DEIN-LINK 💜'], intervalMinutes: 20, minChatLines: 5, note: 'Link anpassen!' },
  { name: 'Follow-Erinnerung', messages: ['Gefällt dir der Stream? Lass gern einen Follow da, das hilft mir sehr! 💜'], intervalMinutes: 30, minChatLines: 10 },
  { name: 'Trinken!', messages: ['💧 Trinkpause! Denkt dran, genug zu trinken.', '💧 Hydrate-Check: Wann hast du zuletzt was getrunken?'], intervalMinutes: 45, minChatLines: 0, order: 'random' },
  { name: 'Socials', messages: ['Folg mir auch auf Instagram: @DEIN-NAME 📸', 'Neue Clips gibt es auf TikTok: @DEIN-NAME 🎬'], intervalMinutes: 25, minChatLines: 5, note: 'Namen anpassen!' },
  { name: 'Commands-Hinweis', messages: ['Tipp: Mit !commands siehst du alle Chat-Commands 💬'], intervalMinutes: 40, minChatLines: 8 },
];

const state = { data: null };

// ============================================================ Laden

async function load() {
  try {
    state.data = await api(`${BASE}/state`);
  } catch (err) {
    toast(err.message, 'err');
  }
  render();
}

// ============================================================ Kopf

function renderInfo() {
  const { live, game, settings } = state.data;
  const gap = h('input', { type: 'number', min: 0, max: 3600, value: settings.minGapSeconds, title: 'Mindestabstand zwischen zwei Timer-Nachrichten' });
  gap.onchange = async () => {
    try {
      state.data.settings = await api(`${BASE}/settings`, { minGapSeconds: Number(gap.value) });
      toast('Gespeichert', 'ok');
    } catch (err) {
      toast(err.message, 'err');
    }
  };
  $('#info-row').replaceChildren(...[
    live === null
      ? h('span', { class: 'badge' }, '⏳ Live-Status wird geladen…')
      : live ? h('span', { class: 'badge live' }, '🔴 Live') : h('span', { class: 'badge' }, '⚫ Offline'),
    game?.name ? h('span', { class: 'badge accent' }, `🎮 ${game.name}`) : null,
    h('label', {}, 'Mindestabstand zwischen Timern', gap, 's'),
    h('span', { class: 'note' }, 'Nachrichten gehen mit deinem Twitch-Account in den Chat.'),
  ].filter(Boolean));
}

// ============================================================ Liste

function statusLine(t, s) {
  if (!s) return null;
  const minutes = (ms) => Math.max(1, Math.ceil(ms / 60_000));
  switch (s.waiting) {
    case 'disabled': return h('span', { class: 't-status off' }, 'Ausgeschaltet');
    case 'offline': return h('span', { class: 't-status off' }, '⚫ Wartet auf Stream-Start');
    case 'game': return h('span', { class: 't-status off' }, `🎮 Wartet auf ${t.games.map((g) => g.name).join(' / ')}`);
    case 'time': return h('span', { class: 't-status ok' }, `⏱ Nächste in ca. ${minutes(s.nextAt - Date.now())} Min.`);
    case 'lines': return h('span', { class: 't-status wait' }, `💬 Wartet auf Chat (${s.linesSince}/${t.minChatLines} Nachrichten)`);
    case 'gap': return h('span', { class: 't-status wait' }, '⏳ Gleich (Mindestabstand zu anderem Timer)');
    case 'ready': return h('span', { class: 't-status ok' }, '📤 Wird gleich gesendet');
  }
  return null;
}

function renderTimers() {
  const box = $('#timers');
  const { timers } = state.data.settings;
  if (!timers.length) {
    box.replaceChildren(h('div', { class: 'tm-empty' },
      h('p', {}, 'Noch keine Timer.'),
      h('div', { class: 'btn-row', style: { justifyContent: 'center' } },
        h('button', { class: 'btn', onclick: openTemplates }, '📋 Aus Vorlage'),
        h('button', { class: 'btn primary', onclick: () => openEditor(null) }, '＋ Neuer Timer'))));
    return;
  }
  box.replaceChildren(h('div', { class: 'timer-list' }, ...timers.map((t) =>
    h('div', { class: `timer${t.enabled ? '' : ' off'}` },
      toggle(t.enabled, async (on) => {
        try {
          await api(`${BASE}/timers/toggle`, { id: t.id, enabled: on });
          await load();
        } catch (err) {
          toast(err.message, 'err');
        }
      }, `${t.name} an/aus`),
      h('div', { class: 't-main' },
        h('div', { class: 't-name' }, t.name),
        h('div', { class: 't-msg', title: t.messages.join('\n') }, t.messages[0], t.messages.length > 1 ? `  (+${t.messages.length - 1} weitere)` : ''),
        h('div', { class: 't-meta' },
          h('span', { class: 'badge' }, `⏱ alle ${t.intervalMinutes} Min.`),
          t.minChatLines ? h('span', { class: 'badge' }, `💬 ab ${t.minChatLines} Chat-Nachrichten`) : null,
          t.onlyLive ? h('span', { class: 'badge' }, '🔴 nur live') : h('span', { class: 'badge warn' }, 'auch offline'),
          t.messages.length > 1 ? h('span', { class: 'badge' }, t.order === 'random' ? '🔀 zufällig' : '🔁 der Reihe nach') : null,
          t.games.length ? h('span', { class: 'badge accent' }, `🎮 nur bei ${t.games.map((g) => g.name).join(', ')}`) : null),
        statusLine(t, state.data.status[t.id])),
      h('div', { class: 't-actions' },
        h('button', { class: 'btn small', title: 'Nächste Nachricht sofort in den Chat schicken', onclick: () => sendNow(t) }, '📤 Jetzt senden'),
        h('button', { class: 'icon-btn', title: 'Bearbeiten', onclick: () => openEditor(t) }, '✎'),
        h('button', { class: 'icon-btn', title: 'Löschen', onclick: () => deleteTimer(t) }, '🗑'))))));
}

async function sendNow(t) {
  if (!confirm(`Die nächste Nachricht von „${t.name}“ jetzt in deinen Chat schicken?`)) return;
  try {
    await api(`${BASE}/timers/send-now`, { id: t.id });
    toast('Gesendet', 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function deleteTimer(t) {
  if (!confirm(`Timer „${t.name}“ löschen?`)) return;
  try {
    await api(`${BASE}/timers/delete`, { id: t.id });
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================ Dialoge

function modal(title, body, footer) {
  const host = $('#modal-host');
  const close = () => host.replaceChildren();
  host.replaceChildren(h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Schließen', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, ...body.filter(Boolean)),
      footer ? h('div', { class: 'modal-foot' }, ...footer.filter(Boolean)) : null)));
  return close;
}

const field = (label, ...controls) => h('div', { class: 'field' }, h('label', {}, label), ...controls);

function openEditor(timer) {
  const isNew = !timer?.id;
  const t = structuredClone(timer ?? {
    name: '', enabled: true, messages: [''], order: 'sequence', intervalMinutes: 15, minChatLines: 5, onlyLive: true, games: [],
  });
  if (!t.messages.length) t.messages.push('');

  const name = h('input', { type: 'text', value: t.name, maxlength: 40, placeholder: 'z.B. Discord' });
  const msgList = h('div', { class: 'msg-list' });
  let lastFocused = null;
  const preview = h('div', { class: 'preview', hidden: true });

  const renderMessages = () => {
    msgList.replaceChildren(...t.messages.map((msg, i) => {
      const area = h('textarea', { rows: 2, maxlength: 500, placeholder: 'Nachricht…' });
      area.value = msg;
      area.oninput = () => { t.messages[i] = area.value; };
      area.onfocus = () => { lastFocused = area; };
      return h('div', { class: 'msg-row' },
        h('span', { class: 'num' }, i + 1),
        area,
        t.messages.length > 1 ? h('button', { class: 'icon-btn', title: 'Nachricht entfernen', onclick: () => { t.messages.splice(i, 1); renderMessages(); } }, '✕') : null);
    }));
  };
  renderMessages();

  const insert = (token) => {
    const area = lastFocused?.isConnected ? lastFocused : msgList.querySelector('textarea');
    const pos = area.selectionStart ?? area.value.length;
    area.value = area.value.slice(0, pos) + token + area.value.slice(area.selectionEnd ?? pos);
    area.focus();
    area.setSelectionRange(pos + token.length, pos + token.length);
    area.oninput();
  };

  const order = h('select', {},
    h('option', { value: 'sequence', selected: t.order === 'sequence' }, '🔁 Der Reihe nach'),
    h('option', { value: 'random', selected: t.order === 'random' }, '🔀 Zufällig'));
  const interval = h('input', { type: 'number', min: 1, max: 720, value: t.intervalMinutes });
  const lines = h('input', { type: 'number', min: 0, max: 500, value: t.minChatLines });

  const gameRow = h('div', { class: 'game-row' });
  const gameSearch = h('div', { hidden: true });
  const renderGames = () => {
    gameRow.replaceChildren(...[
      ...t.games.map((g) => h('span', { class: 'game-chip' }, g.name,
        h('button', { class: 'chip-x', title: 'Entfernen', onclick: () => { t.games = t.games.filter((x) => x.id !== g.id); renderGames(); } }, '✕'))),
      h('button', { class: 'btn small', onclick: () => { gameSearch.hidden = !gameSearch.hidden; gameSearch.querySelector('input')?.focus(); } }, '＋ Spiel'),
      t.games.length ? null : h('span', { class: 'note' }, 'Kein Spiel gewählt: läuft bei jedem Spiel.'),
    ].filter(Boolean));
  };
  const searchInput = h('input', { type: 'search', placeholder: 'Spiel suchen, z.B. Minecraft…' });
  const results = h('div', { class: 'game-results' });
  let searchTimer = null;
  searchInput.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = searchInput.value.trim();
      if (!q) return results.replaceChildren();
      try {
        const found = await api(`${BASE}/games/search?q=${encodeURIComponent(q)}`);
        results.replaceChildren(...found.map((g) => h('button', {
          class: 'game-result',
          onclick: () => {
            if (!t.games.some((x) => x.id === g.id)) t.games.push({ id: g.id, name: g.name });
            gameSearch.hidden = true;
            searchInput.value = '';
            results.replaceChildren();
            renderGames();
          },
        }, g.image ? h('img', { src: g.image, alt: '' }) : null, h('span', {}, g.name))));
      } catch (err) {
        results.replaceChildren(h('div', { class: 'note' }, err.message));
      }
    }, 300);
  };
  gameSearch.append(searchInput, results);
  renderGames();

  const showPreview = async () => {
    const area = lastFocused?.isConnected ? lastFocused : msgList.querySelector('textarea');
    try {
      const { text } = await api(`${BASE}/preview`, { message: area.value });
      preview.hidden = false;
      preview.textContent = text || '(leer)';
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const save = async () => {
    const payload = {
      id: t.id,
      name: name.value,
      enabled: t.enabled,
      messages: t.messages,
      order: order.value,
      intervalMinutes: Number(interval.value),
      minChatLines: Number(lines.value),
      onlyLive: t.onlyLive,
      games: t.games,
    };
    try {
      await api(`${BASE}/timers/save`, { timer: payload });
    } catch (err) {
      return toast(err.message, 'err');
    }
    toast(isNew ? 'Timer angelegt' : 'Gespeichert', 'ok');
    close();
    await load();
  };

  const close = modal(isNew ? 'Neuer Timer' : `${t.name} bearbeiten`, [
    field('Name', name),
    h('div', { class: 'sub' }, 'NACHRICHTEN'),
    msgList,
    h('div', { class: 'btn-row' },
      h('button', { class: 'btn small', onclick: () => { t.messages.push(''); renderMessages(); } }, '＋ Nachricht'),
      h('button', { class: 'btn small', onclick: showPreview }, '👁 Vorschau')),
    h('div', { class: 'chips' }, ...VARIABLES.map(([token, desc]) => h('button', { class: 'chip', title: desc, onclick: () => insert(token) }, token))),
    preview,
    h('div', { class: 'sub' }, 'WANN'),
    h('div', { class: 'f-row3' },
      field('Alle … Minuten', interval),
      field('Mindestens … Chat-Nachrichten dazwischen', lines),
      field('Reihenfolge (bei mehreren)', order)),
    h('div', { class: 'note' }, 'Beispiel: alle 20 Minuten, aber nur, wenn seit der letzten Timer-Nachricht mindestens 5 Leute etwas geschrieben haben. So spammt der Timer keinen leeren Chat voll.'),
    h('div', { class: 'opt-row' }, toggle(t.onlyLive, (on) => { t.onlyLive = on; }, 'Nur live'), h('span', {}, 'Nur wenn der Stream live ist')),
    h('div', { class: 'sub' }, 'NUR BEI SPIEL'),
    gameRow,
    gameSearch,
  ], [
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', { class: 'btn primary', onclick: save }, isNew ? 'Anlegen' : 'Speichern'),
  ]);
  setTimeout(() => (isNew ? name : msgList.querySelector('textarea')).focus(), 0);
}

function openTemplates() {
  const existing = new Set(state.data.settings.timers.map((t) => t.name.toLowerCase()));
  modal('📋 Vorlagen', [
    h('p', { class: 'note' }, 'Beliebte Timer zum Übernehmen. Danach kannst du sie frei anpassen.'),
    h('div', { class: 'tpl-list' }, ...TEMPLATES.map((t) =>
      h('div', { class: 'tpl' },
        h('div', { class: 't-main' },
          h('div', {}, h('span', { class: 't-name' }, t.name),
            h('span', { class: 'badge', style: { marginLeft: '8px' } }, `alle ${t.intervalMinutes} Min.`),
            t.note ? h('span', { class: 'badge accent', style: { marginLeft: '6px' } }, t.note) : null),
          h('div', { class: 't-msg' }, t.messages[0])),
        existing.has(t.name.toLowerCase())
          ? h('span', { class: 'badge ok' }, '✓ vorhanden')
          : h('button', {
            class: 'btn small',
            onclick: () => openEditor({ enabled: true, order: 'sequence', onlyLive: true, games: [], ...structuredClone(t), note: undefined }),
          }, 'Übernehmen…')))),
  ]);
}

// ============================================================ Start

function render() {
  if (!state.data) return;
  if (!$('#info-row').contains(document.activeElement)) renderInfo();
  renderTimers();
}

(async () => {
  $('#new-timer').onclick = () => openEditor(null);
  $('#templates').onclick = openTemplates;
  await load();
  // Status regelmäßig aktualisieren (nicht während ein Dialog offen ist)
  setInterval(() => {
    if (!$('#modal-host').childElementCount) load();
  }, 5000);
})();
