const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/commands';

const PERMISSIONS = [
  ['everyone', 'Alle'],
  ['subscriber', 'Subs'],
  ['vip', 'VIPs'],
  ['moderator', 'Mods'],
  ['broadcaster', 'Nur du'],
];
const permissionLabel = (p) => PERMISSIONS.find(([v]) => v === p)?.[1] ?? p;

const VARIABLES = [
  ['{user}', 'Name von dem, der den Command schreibt'],
  ['{touser}', 'Erwähnter Name (z.B. !hug @maxart), sonst der Schreiber'],
  ['{args}', 'Alles, was nach dem Command steht'],
  ['{arg1}', 'Erstes Wort nach dem Command ({arg2} usw. genauso)'],
  ['{count}', 'Wie oft der Command benutzt wurde'],
  ['{random:1-6}', 'Zufallszahl im Bereich'],
  ['{pick:Ja|Nein|Vielleicht}', 'Zufällige Auswahl'],
  ['{game}', 'Aktuelles Spiel / Kategorie'],
  ['{title}', 'Stream-Titel'],
  ['{uptime}', 'Wie lange der Stream schon läuft'],
  ['{followage}', 'Wie lange der Schreiber schon folgt'],
  ['{channel}', 'Dein Kanalname'],
  ['{commands}', 'Liste aller Commands für alle'],
];

const TEMPLATES = [
  { name: 'discord', aliases: ['dc'], response: 'Komm auf meinen Discord: https://discord.gg/DEIN-LINK 💜', note: 'Link anpassen!' },
  { name: 'lurk', response: '{user} ist jetzt im Lurk-Modus. Danke fürs Dableiben! 💜' },
  { name: 'uptime', response: 'Der Stream läuft seit {uptime}.' },
  { name: 'followage', response: '{user} folgt seit {followage}.', cooldownUser: 30 },
  { name: 'game', response: 'Gerade läuft: {game}' },
  { name: 'dice', aliases: ['würfel'], response: '{user} würfelt eine {random:1-6}! 🎲', cooldownUser: 10 },
  { name: '8ball', response: '🎱 {pick:Ja|Nein|Vielleicht|Frag später nochmal|Auf jeden Fall|Eher nicht}', cooldownUser: 10 },
  { name: 'hug', response: '{user} umarmt {touser}! 🤗', cooldownUser: 10 },
  { name: 'so', aliases: ['shoutout'], response: 'Schaut mal bei {touser} vorbei: https://twitch.tv/{touser} 💜', permission: 'moderator' },
  { name: 'tod', aliases: ['death'], response: 'Schon {count}-mal gestorben 💀', permission: 'moderator', cooldownGlobal: 5 },
  { name: 'commands', response: 'Commands: {commands}', cooldownGlobal: 30 },
];

const state = { settings: null, history: [], search: '', satellite: null };

// ============================================================ Laden

async function load() {
  try {
    const data = await api(`${BASE}/state`);
    state.settings = data.settings;
    state.history = data.history;
  } catch (err) {
    toast(err.message, 'err');
  }
  render();
}

async function loadSatellite() {
  try {
    state.satellite = await api('core/satellite');
  } catch {
    state.satellite = null;
  }
}

// ============================================================ Kopf (Einstellungen)

function renderSettings() {
  const s = state.settings;
  const prefix = h('input', { type: 'text', value: s.prefix, maxlength: 3, title: 'Zeichen vor jedem Command' });
  prefix.onchange = async () => {
    try {
      state.settings = await api(`${BASE}/settings`, { prefix: prefix.value });
      toast('Präfix gespeichert', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'err');
      prefix.value = s.prefix;
    }
  };
  $('#settings-row').replaceChildren(
    h('label', {}, 'Präfix', prefix),
    h('label', {},
      toggle(s.modsIgnoreCooldown, async (on) => {
        try {
          state.settings = await api(`${BASE}/settings`, { modsIgnoreCooldown: on });
        } catch (err) {
          toast(err.message, 'err');
        }
      }, 'Mods ignorieren Cooldowns'),
      'Mods und du ignorieren Cooldowns'),
    h('span', { class: 'note' }, 'Antworten schreibt die Suite mit deinem Twitch-Account in den Chat.'));
}

// ============================================================ Liste

function renderCommands() {
  const box = $('#commands');
  const { commands, prefix } = state.settings;
  if (!commands.length) {
    box.replaceChildren(h('div', { class: 'cmd-empty' },
      h('p', {}, 'Noch keine Commands.'),
      h('div', { class: 'btn-row', style: { justifyContent: 'center' } },
        h('button', { class: 'btn', onclick: openTemplates }, '📋 Aus Vorlage'),
        h('button', { class: 'btn primary', onclick: () => openEditor(null) }, '＋ Neuer Command'))));
    return;
  }
  const q = state.search.toLowerCase();
  const list = commands
    .filter((c) => !q || c.name.includes(q) || c.aliases.some((a) => a.includes(q)) || c.response.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  box.replaceChildren(h('div', { class: 'cmd-list' }, ...list.map((c) =>
    h('div', { class: `cmd${c.enabled ? '' : ' off'}` },
      toggle(c.enabled, async (on) => {
        try {
          await api(`${BASE}/commands/toggle`, { id: c.id, enabled: on });
          c.enabled = on;
          renderCommands();
        } catch (err) {
          toast(err.message, 'err');
        }
      }, `${prefix}${c.name} an/aus`),
      h('div', { class: 'cmd-main' },
        h('div', {},
          h('span', { class: 'cmd-name' }, `${prefix}${c.name}`),
          c.aliases.length ? h('span', { class: 'cmd-alias' }, c.aliases.map((a) => prefix + a).join(' ')) : null),
        c.response ? h('div', { class: 'cmd-response', title: c.response }, c.response) : h('div', { class: 'cmd-response' }, '(keine Antwort)'),
        h('div', { class: 'cmd-meta' },
          c.permission !== 'everyone' ? h('span', { class: 'badge warn' }, `🔒 ${permissionLabel(c.permission)}`) : h('span', { class: 'badge' }, '👥 Alle'),
          c.cooldownGlobal ? h('span', { class: 'badge', title: 'Cooldown für alle' }, `⏱ ${c.cooldownGlobal} s`) : null,
          c.cooldownUser ? h('span', { class: 'badge', title: 'Cooldown pro Zuschauer' }, `👤⏱ ${c.cooldownUser} s`) : null,
          c.reply ? h('span', { class: 'badge', title: 'Antwortet im Thread auf die Nachricht' }, '↩ Antwort') : null,
          c.keybind ? h('span', { class: `badge${c.keybind.enabled ? ' accent' : ''}` },
            `${c.keybind.target === 'satellite' ? '🛰' : '⌨'} ${window.KeyUI.stepsLabel(c.keybind.steps)}`) : null,
          h('span', { class: 'badge', title: 'So oft benutzt' }, `# ${c.count}`))),
      h('div', { class: 'cmd-actions' },
        h('button', { class: 'icon-btn', title: 'Bearbeiten', onclick: () => openEditor(c) }, '✎'),
        h('button', { class: 'icon-btn', title: 'Duplizieren', onclick: () => openEditor({ ...structuredClone(c), id: null, name: `${c.name}2`, aliases: [], count: 0 }) }, '⧉'),
        h('button', { class: 'icon-btn', title: 'Löschen', onclick: () => deleteCommand(c) }, '🗑'))))));
}

async function deleteCommand(c) {
  if (!confirm(`Command ${state.settings.prefix}${c.name} löschen?`)) return;
  try {
    await api(`${BASE}/commands/delete`, { id: c.id });
    toast('Gelöscht', 'ok');
    await load();
  } catch (err) {
    toast(err.message, 'err');
  }
}

// ============================================================ Verlauf

const RESULT_ICONS = { ok: '✅', 'no-permission': '🔒', cooldown: '⏱', error: '⚠️' };

function renderHistory() {
  const box = $('#history');
  if (!state.history.length) {
    box.replaceChildren(h('div', { class: 'note' }, 'Noch keine Commands benutzt, seit die Suite läuft.'));
    return;
  }
  box.replaceChildren(...state.history.slice(0, 30).map((e) =>
    h('div', { class: 'h-row', title: e.detail },
      h('span', { class: 'h-time' }, new Date(e.time).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })),
      h('span', {}, RESULT_ICONS[e.result] ?? '•'),
      h('span', { class: 'h-text' }, h('b', {}, e.user), ` ${state.settings.prefix}${e.command} `, h('span', { class: 'muted' }, e.detail)))));
}

// ============================================================ Testen

async function runTest() {
  const message = $('#test-message').value.trim();
  const box = $('#test-result');
  if (!message) return;
  try {
    const r = await api(`${BASE}/test`, { message, role: $('#test-role').value });
    if (!r.matched) {
      box.replaceChildren(h('div', { class: 'bubble warn' }, 'Kein Command erkannt. Stimmt das Präfix und ist der Command aktiv?'));
    } else if (r.result === 'ok') {
      box.replaceChildren(h('div', { class: 'bubble ok' },
        r.response
          ? h('div', { class: 'chat-line' }, h('b', {}, 'Antwort: '), r.response)
          : h('div', { class: 'note' }, 'Keine Chat-Antwort.'),
        r.keybind ? h('div', { class: 'note' }, `${r.keybind.target === 'satellite' ? '🛰 Satellite' : '⌨ Dieser PC'} drückt: ${window.KeyUI.stepsLabel(r.keybind.steps)} (im Test nicht ausgeführt)`) : null));
    } else {
      const reason = r.result === 'no-permission' ? `🔒 Keine Berechtigung (${r.detail})` : `⏱ Cooldown (${r.detail})`;
      box.replaceChildren(h('div', { class: 'bubble warn' }, reason));
    }
  } catch (err) {
    box.replaceChildren(h('div', { class: 'bubble warn' }, err.message));
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

async function openEditor(command) {
  await loadSatellite();
  const isNew = !command?.id;
  const prefix = state.settings.prefix;
  const c = structuredClone(command ?? {
    name: '', aliases: [], enabled: true, response: '', reply: false, permission: 'everyone',
    cooldownGlobal: 0, cooldownUser: 0, count: 0, keybind: null,
  });
  const kb = structuredClone(c.keybind ?? { enabled: true, steps: [], target: 'local' });
  let useKeybind = !!c.keybind;

  const name = h('input', { type: 'text', value: c.name, placeholder: 'discord', maxlength: 30 });
  const aliases = h('input', { type: 'text', value: c.aliases.join(', '), placeholder: 'dc, disc' });
  const response = h('textarea', { rows: 3, maxlength: 500, placeholder: 'Komm auf meinen Discord: …' });
  response.value = c.response;
  const counter = h('div', { class: 'counter' }, `${c.response.length}/500`);
  response.oninput = () => { counter.textContent = `${response.value.length}/500`; };
  const insert = (token) => {
    const pos = response.selectionStart ?? response.value.length;
    response.value = response.value.slice(0, pos) + token + response.value.slice(response.selectionEnd ?? pos);
    response.focus();
    response.setSelectionRange(pos + token.length, pos + token.length);
    response.oninput();
  };
  const permission = h('select', {}, ...PERMISSIONS.map(([v, l]) => h('option', { value: v, selected: v === c.permission }, l)));
  const numInput = (value) => h('input', { type: 'number', min: 0, max: 86400, value });
  const cdGlobal = numInput(c.cooldownGlobal);
  const cdUser = numInput(c.cooldownUser);
  const count = numInput(c.count);
  count.max = 1000000000;

  const editor = window.KeyUI.stepsEditor(kb.steps);
  const kbBox = h('div', { class: 'kb-box' });
  const renderKb = () => {
    kbBox.hidden = !useKeybind;
    kbBox.replaceChildren(
      h('div', { class: 'opt-row' }, toggle(kb.enabled, (on) => { kb.enabled = on; }, 'Keybind aktiv'), h('span', {}, 'Aktiv')),
      h('div', { class: 'sub' }, 'AUSFÜHREN AUF'),
      window.KeyUI.targetPicker(kb, state.satellite, null),
      h('div', { class: 'sub' }, 'TASTENFOLGE'),
      editor.el,
      h('button', {
        class: 'btn small',
        onclick: async () => {
          editor.stop();
          const steps = editor.clean();
          if (!steps.length) return toast('Erst eine Taste aufnehmen.', 'err');
          try {
            await api(`${BASE}/keybind-test`, { steps, target: kb.target });
            toast(kb.target === 'satellite' ? 'In 3 Sekunden drückt der Satellite die Tasten.' : 'In 3 Sekunden werden die Tasten gedrückt, wechsle ins Ziel-Fenster…');
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      }, '▶ Keybind testen (3 s)'),
      window.KeyUI.tips());
  };
  renderKb();

  const save = async () => {
    editor.stop();
    const payload = {
      id: c.id,
      name: name.value,
      aliases: aliases.value.split(/[\s,]+/).filter(Boolean),
      enabled: c.enabled,
      response: response.value,
      reply: c.reply,
      permission: permission.value,
      cooldownGlobal: Number(cdGlobal.value),
      cooldownUser: Number(cdUser.value),
      count: Number(count.value),
      keybind: useKeybind ? { enabled: kb.enabled, steps: editor.clean(), target: kb.target } : null,
    };
    if (useKeybind && !payload.keybind.steps.length) return toast('Keybind: erst eine Taste aufnehmen oder den Keybind ausschalten.', 'err');
    try {
      await api(`${BASE}/commands/save`, { command: payload });
    } catch (err) {
      return toast(err.message, 'err');
    }
    toast(isNew ? 'Command angelegt' : 'Gespeichert', 'ok');
    close();
    await load();
  };

  const close = modal(isNew ? 'Neuer Command' : `${prefix}${c.name} bearbeiten`, [
    h('div', { class: 'f-row' },
      field('Name', h('div', { class: 'name-input' }, h('span', {}, prefix), name)),
      field('Aliase (optional)', aliases)),
    field('Antwort im Chat', response,
      h('div', { class: 'chips' }, ...VARIABLES.map(([token, desc]) => h('button', { class: 'chip', title: desc, onclick: () => insert(token) }, token))),
      counter),
    h('div', { class: 'note' }, 'Fahr mit der Maus über eine Variable, um zu sehen, was sie macht. Leer lassen, wenn der Command nur einen Keybind auslösen soll.'),
    h('div', { class: 'opt-row' }, toggle(c.reply, (on) => { c.reply = on; }, 'Als Antwort'), h('span', {}, 'Als Antwort auf die Nachricht schicken (Thread)')),
    h('div', { class: 'f-row3' },
      field('Wer darf ihn benutzen?', permission),
      field('Cooldown für alle (s)', cdGlobal),
      field('Cooldown pro Zuschauer (s)', cdUser)),
    field('Zähler {count}', count),
    h('div', { class: 'opt-row' },
      toggle(useKeybind, (on) => { useKeybind = on; renderKb(); }, 'Keybind'),
      h('span', {}, '⌨ Zusätzlich Tasten drücken (z.B. OBS-Szene wechseln)')),
    kbBox,
  ], [
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => { editor.stop(); close(); } }, 'Abbrechen'),
    h('button', { class: 'btn primary', onclick: save }, isNew ? 'Anlegen' : 'Speichern'),
  ]);
  setTimeout(() => (isNew ? name : response).focus(), 0);
}

function openTemplates() {
  const existing = new Set(state.settings.commands.flatMap((c) => [c.name, ...c.aliases]));
  const prefix = state.settings.prefix;
  modal('📋 Vorlagen', [
    h('p', { class: 'note' }, 'Beliebte Commands zum Übernehmen. Danach kannst du sie frei anpassen.'),
    h('div', { class: 'tpl-list' }, ...TEMPLATES.map((t) => {
      const taken = existing.has(t.name);
      return h('div', { class: 'tpl' },
        h('div', { class: 'cmd-main' },
          h('div', {}, h('span', { class: 'cmd-name' }, prefix + t.name),
            t.permission ? h('span', { class: 'badge warn', style: { marginLeft: '8px' } }, `🔒 ${permissionLabel(t.permission)}`) : null,
            t.note ? h('span', { class: 'badge accent', style: { marginLeft: '8px' } }, t.note) : null),
          h('div', { class: 'cmd-response' }, t.response)),
        taken
          ? h('span', { class: 'badge ok' }, '✓ vorhanden')
          : h('button', {
            class: 'btn small',
            onclick: () => openEditor({
              name: t.name, aliases: (t.aliases ?? []).filter((a) => !existing.has(a)), enabled: true, response: t.response, reply: false,
              permission: t.permission ?? 'everyone', cooldownGlobal: t.cooldownGlobal ?? 0, cooldownUser: t.cooldownUser ?? 0, count: 0, keybind: null,
            }),
          }, 'Übernehmen…'));
    })),
  ]);
}

// ============================================================ Start

function render() {
  if (!state.settings) return;
  renderSettings();
  renderCommands();
  renderHistory();
}

(async () => {
  $('#new-command').onclick = () => openEditor(null);
  $('#templates').onclick = openTemplates;
  $('#search').oninput = (e) => {
    state.search = e.target.value;
    renderCommands();
  };
  $('#test-run').onclick = runTest;
  $('#test-message').onkeydown = (e) => { if (e.key === 'Enter') runTest(); };
  window.KeyUI.onLayoutReady(() => render());
  await load();
  // Verlauf regelmäßig aktualisieren
  setInterval(async () => {
    if ($('#modal-host').childElementCount) return;
    try {
      const data = await api(`${BASE}/state`);
      state.history = data.history;
      state.settings.commands = data.settings.commands;
      renderHistory();
      if (document.activeElement !== $('#search')) renderCommands();
    } catch {
      // egal
    }
  }, 5000);
})();
