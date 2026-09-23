const { $, h, api, toast, toggle } = window.UI;
const BASE = 'addons/streaminfo';

const MAX_TITLE = 140;
const MAX_TAGS = 10;
const MAX_TAG_LEN = 25;
/** Twitch erlaubt in Tags nur Buchstaben und Zahlen */
const TAG_RE = /^[\p{L}\p{N}]+$/u;
const LANGUAGES = [
  ['de', 'Deutsch'], ['en', 'Englisch'], ['es', 'Spanisch'], ['fr', 'Französisch'], ['it', 'Italienisch'],
  ['nl', 'Niederländisch'], ['pl', 'Polnisch'], ['pt', 'Portugiesisch'], ['tr', 'Türkisch'], ['ru', 'Russisch'],
  ['uk', 'Ukrainisch'], ['sv', 'Schwedisch'], ['da', 'Dänisch'], ['no', 'Norwegisch'], ['fi', 'Finnisch'],
  ['cs', 'Tschechisch'], ['sk', 'Slowakisch'], ['hu', 'Ungarisch'], ['ro', 'Rumänisch'], ['bg', 'Bulgarisch'],
  ['el', 'Griechisch'], ['ar', 'Arabisch'], ['hi', 'Hindi'], ['ja', 'Japanisch'], ['ko', 'Koreanisch'],
  ['zh', 'Chinesisch'], ['th', 'Thai'], ['vi', 'Vietnamesisch'], ['id', 'Indonesisch'], ['ms', 'Malaiisch'],
  ['tl', 'Tagalog'], ['ca', 'Katalanisch'], ['other', 'Andere'],
];
const langName = (code) => LANGUAGES.find(([c]) => c === code)?.[1] ?? code;
const ROLE_NAMES = { vip: 'VIPs, Mods und du', moderator: 'Mods und du', broadcaster: 'nur du' };

/**
 * data  = letzter Stand vom Server (Vorlagen, Einstellungen …)
 * info  = so ist es gerade bei Twitch
 * draft = was im „Jetzt“-Bereich eingestellt ist (noch nicht gespeichert)
 */
const state = { data: null, info: null, draft: null, busy: false };

const FIELDS = ['title', 'category', 'tags', 'language'];

/** Gleicher Wert? (Kategorie nach ID, Tags als Liste) */
function same(key, a, b) {
  if (key === 'category') return (a?.id ?? '') === (b?.id ?? '');
  if (key === 'tags') return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
  return a === b;
}

async function call(path, body) {
  try {
    applyState(await api(`${BASE}${path}`, body));
    return true;
  } catch (err) {
    toast(err.message, 'err');
    return false;
  }
}

const load = () => call('/state');

function applyState(data) {
  state.data = data;
  applyInfo(data.info);
  renderStatus();
  renderPresets();
  renderHelp();
}

/**
 * Neuer Stand von Twitch. Felder, die du gerade bearbeitest, bleiben stehen –
 * alle anderen übernehmen den neuen Wert (z.B. wenn im Dashboard etwas geändert wurde).
 */
function applyInfo(info) {
  const old = state.info;
  state.info = info ? structuredClone(info) : null;
  if (!info) {
    state.draft = null;
  } else if (!state.draft || !old) {
    state.draft = structuredClone(info);
  } else {
    for (const key of FIELDS) {
      if (same(key, state.draft[key], old[key])) state.draft[key] = structuredClone(info[key]);
    }
  }
  renderNow();
}

/** Was hat sich gegenüber Twitch geändert? */
function diff() {
  const d = state.draft;
  const i = state.info;
  if (!d || !i) return {};
  const out = {};
  if (d.title.trim() !== i.title) out.title = d.title.trim();
  if (!same('category', d.category, i.category)) out.category = d.category;
  if (!same('tags', d.tags, i.tags)) out.tags = d.tags;
  if (d.language !== i.language) out.language = d.language;
  return out;
}

// ============================================================ Kleine Bausteine

function modal(title, body, footer) {
  const host = $('#modal-host');
  const close = () => host.replaceChildren();
  host.replaceChildren(h('div', { class: 'modal-back', onclick: (e) => { if (e.target === e.currentTarget) close(); } },
    h('div', { class: 'modal' },
      h('div', { class: 'modal-head' }, h('h2', {}, title), h('button', { class: 'icon-btn', title: 'Schließen', onclick: close }, '✕')),
      h('div', { class: 'modal-body' }, ...body.filter(Boolean)),
      footer ? h('div', { class: 'modal-foot' }, ...footer) : null)));
  return close;
}

const field = (label, ...controls) => h('div', { class: 'field' }, h('label', {}, label), ...controls);
const art = (category, cls) => (category?.image
  ? h('img', { class: cls, src: category.image, alt: '' })
  : h('div', { class: cls }, '🎮'));

function languageSelect(value, withKeep) {
  const options = [...LANGUAGES];
  if (value && value !== '' && !options.some(([c]) => c === value)) options.unshift([value, value]);
  const select = h('select', {},
    withKeep ? h('option', { value: '' }, '— bleibt, wie sie ist —') : null,
    ...options.map(([code, name]) => h('option', { value: code }, name)));
  select.value = value ?? '';
  return select;
}

/** Zähler „12 / 140“ */
function countText(length) {
  return `${length} / ${MAX_TITLE}`;
}

/**
 * Tag-Eingabe mit Chips. Enter, Komma oder Leerzeichen macht aus dem Text einen Tag.
 * Gibt { el, set(tags) } zurück. onChange bekommt die neue Liste.
 */
function tagEditor(initial, onChange) {
  let tags = [...initial];
  const input = h('input', { type: 'text', placeholder: 'Tag hinzufügen…', maxlength: 60 });
  const box = h('div', { class: 'tag-box', onclick: (e) => { if (e.target === box) input.focus(); } });
  const error = h('div', { class: 'tag-err' });

  const renderChips = () => {
    box.replaceChildren(
      ...tags.map((tag) => h('span', { class: 'tag-chip no-i18n' }, tag,
        h('button', { title: 'Entfernen', onclick: () => { tags = tags.filter((t) => t !== tag); changed(); } }, '✕'))),
      input);
    input.hidden = tags.length >= MAX_TAGS;
  };
  const changed = () => {
    renderChips();
    onChange([...tags]);
  };

  /** Text in Tags verwandeln. Gibt false zurück, wenn etwas nicht ging. */
  const add = (text) => {
    error.textContent = '';
    const parts = text.split(/[\s,;]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
    let ok = true;
    for (const tag of parts) {
      if (tags.length >= MAX_TAGS) { error.textContent = `Höchstens ${MAX_TAGS} Tags.`; ok = false; break; }
      if (tag.length > MAX_TAG_LEN) { error.textContent = `„${tag}“ ist zu lang (höchstens ${MAX_TAG_LEN} Zeichen).`; ok = false; continue; }
      if (!TAG_RE.test(tag)) { error.textContent = `„${tag}“ geht nicht – nur Buchstaben und Zahlen, keine Sonderzeichen.`; ok = false; continue; }
      if (tags.some((t) => t.toLowerCase() === tag.toLowerCase())) continue;
      tags.push(tag);
    }
    changed();
    return ok;
  };

  input.onkeydown = (e) => {
    if (['Enter', ',', ';', ' '].includes(e.key)) {
      e.preventDefault();
      if (input.value.trim() && add(input.value)) input.value = '';
      input.focus();
    } else if (e.key === 'Backspace' && !input.value && tags.length) {
      tags.pop();
      changed();
      input.focus();
    }
  };
  // Eingefügter Text mit mehreren Tags („a b c“)
  input.oninput = () => {
    if (/[\s,;]/.test(input.value) && add(input.value)) input.value = '';
  };
  input.onblur = () => {
    if (input.value.trim() && add(input.value)) input.value = '';
  };

  renderChips();
  return {
    el: h('div', { class: 'opt-block' }, box, error),
    set(next) {
      if (JSON.stringify(next) === JSON.stringify(tags)) return;
      tags = [...next];
      renderChips();
    },
  };
}

/** Dialog zum Suchen einer Kategorie (wie im Kanalpunkte-Addon). onPick bekommt { id, name, image }. */
function gamePicker(title, onPick) {
  const input = h('input', { type: 'search', placeholder: 'Spiel oder Kategorie suchen, z.B. Just Chatting…' });
  const results = h('div', { class: 'game-results' });

  // Bei verschachtelten Dialogen (Vorlagen-Editor) den alten Inhalt merken und danach wiederherstellen
  const host = $('#modal-host');
  const previous = [...host.childNodes];
  const back = () => {
    close();
    host.replaceChildren(...previous);
  };
  const pick = (game) => {
    back();
    onPick({ id: game.id, name: game.name, image: game.image ?? '' });
  };
  const row = (game) => h('button', { class: 'game-result', onclick: () => pick(game) },
    game.image ? h('img', { src: game.image, alt: '' }) : h('span', { class: 'game-ph' }, '🎮'),
    h('span', {}, game.name));

  const showRecent = () => {
    const recent = state.data?.recentCategories ?? [];
    results.replaceChildren(...(recent.length ? [h('div', { class: 'note' }, 'Zuletzt benutzt:'), ...recent.map(row)] : []));
  };

  let timer = null;
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (!q) {
        showRecent();
        return;
      }
      try {
        const found = await api(`${BASE}/categories/search?q=${encodeURIComponent(q)}`);
        if (input.value.trim() !== q) return;
        results.replaceChildren(...(found.length ? found.map(row) : [h('div', { class: 'note' }, 'Nichts gefunden.')]));
      } catch (err) {
        results.replaceChildren(h('div', { class: 'warn-note' }, err.message));
      }
    }, 300);
  };

  const close = modal(title, [input, results],
    previous.length ? [h('button', { class: 'btn', onclick: back }, 'Zurück')] : null);
  showRecent();
  setTimeout(() => input.focus(), 0);
}

// ============================================================ „Jetzt“

let tags = null;

function renderStatus() {
  const d = state.data;
  let text = '';
  if (!d.loggedIn) text = '⚠ Du bist nicht bei Twitch eingeloggt. Verbinde dich zuerst in der Übersicht – dann kannst du hier Titel und Kategorie ändern.';
  else if (d.error) text = `⚠ ${d.error}`;
  $('#status').replaceChildren(...(text ? [h('div', { class: 'status' }, text)] : []));
  $('#counter-now').textContent = `als Nächstes: ${d.counter + 1}`;
  $('#cp-note').textContent = d.channelPointsActive
    ? '🎯 Spiel-Regeln aus dem Kanalpunkte-Addon schalten sich automatisch um, sobald du hier die Kategorie wechselst.'
    : '🎯 Tipp: Mit den Spiel-Regeln im Kanalpunkte-Addon schalten sich Belohnungen automatisch um, sobald du hier die Kategorie wechselst.';
}

function renderNow() {
  const d = state.draft;
  const i = state.info;
  const disabled = !d;
  for (const id of ['#title', '#language', '#cat-change', '#cat-clear', '#to-preset', '#recent-toggle']) $(id).disabled = disabled;

  // Kategorie
  const category = d?.category ?? null;
  const catChanged = d && !same('category', d.category, i?.category);
  $('#cat-art').replaceChildren(art(category, 'box-art'));
  const name = $('#cat-name');
  name.textContent = category ? category.name : d ? 'Keine Kategorie' : '–';
  name.className = `cat-name${category ? '' : ' none'}${catChanged ? ' changed' : ''}`;
  $('#cat-clear').hidden = !category;
  renderRecentCats();

  // Titel (nur setzen, wenn anders – sonst springt der Cursor)
  const title = $('#title');
  if (title.value !== (d?.title ?? '')) title.value = d?.title ?? '';
  title.classList.toggle('changed', !!d && d.title.trim() !== i?.title);
  renderTitleInfo();
  renderRecentTitles();

  // Tags
  if (!tags) {
    tags = tagEditor(d?.tags ?? [], (next) => {
      if (!state.draft) return;
      state.draft.tags = next;
      renderDirty();
    });
    $('#tags').replaceChildren(tags.el);
  } else {
    tags.set(d?.tags ?? []);
  }

  // Sprache
  const lang = d?.language ?? 'de';
  const select = languageSelect(lang, false);
  $('#language').replaceChildren(...select.children);
  $('#language').value = lang;

  renderDirty();
}

function renderTitleInfo() {
  const text = state.draft?.title ?? '';
  const count = $('#title-count');
  count.textContent = countText(text.trim().length);
  count.classList.toggle('over', text.trim().length > MAX_TITLE);
  $('#title-hint').textContent = /\{\w+/.test(text) ? 'Variablen wie {datum} gehen nur in Vorlagen – hier wird der Text genau so gespeichert.' : '';
}

function renderDirty() {
  const changes = Object.keys(diff());
  const dirty = changes.length > 0;
  const tooLong = (state.draft?.title.trim().length ?? 0) > MAX_TITLE;
  $('#save').disabled = !dirty || tooLong || state.busy;
  $('#discard').disabled = !dirty || state.busy;
  $('#dirty-note').hidden = !dirty;
  $('#tag-count').textContent = state.draft ? `(${state.draft.tags.length} / ${MAX_TAGS})` : '';
  $('#title').classList.toggle('changed', changes.includes('title'));
}

function renderRecentCats() {
  const recent = (state.data?.recentCategories ?? []).slice(0, 8);
  const box = $('#recent-cats');
  if (!recent.length || !state.draft) {
    box.replaceChildren();
    return;
  }
  box.replaceChildren(h('span', { class: 'note' }, 'Zuletzt:'), ...recent.map((c) =>
    h('button', {
      class: `quick-cat${state.draft.category?.id === c.id ? ' on' : ''}`,
      title: c.name,
      onclick: () => setCategory(c),
    }, c.image ? h('img', { src: c.image, alt: '' }) : h('span', { class: 'ph' }, '🎮'), h('span', {}, c.name))));
}

function renderRecentTitles() {
  const recent = state.data?.recentTitles ?? [];
  const box = $('#recent-titles');
  $('#recent-toggle').disabled = !state.draft || !recent.length;
  if (!recent.length) box.hidden = true;
  box.replaceChildren(...recent.map((t) => h('div', { class: 'recent-title' },
    h('button', {
      class: 'pick no-i18n', title: t,
      onclick: () => {
        state.draft.title = t;
        $('#title').value = t;
        box.hidden = true;
        renderTitleInfo();
        renderDirty();
      },
    }, t),
    h('button', { class: 'icon-btn', title: 'Aus der Liste entfernen', onclick: () => call('/recent/remove', { kind: 'title', value: t }) }, '✕'))));
}

function setCategory(category) {
  if (!state.draft) return;
  state.draft.category = category;
  renderNow();
}

async function save() {
  const changes = diff();
  if (!Object.keys(changes).length) return;
  if (changes.title !== undefined && !changes.title) {
    toast('Der Titel darf nicht leer sein.', 'err');
    return;
  }
  state.busy = true;
  renderDirty();
  try {
    const data = await api(`${BASE}/save`, changes);
    state.draft = null; // Gespeichertes übernehmen
    applyState(data);
    toast('Bei Twitch gespeichert ✔', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    state.busy = false;
    renderDirty();
  }
}

function discard() {
  state.draft = state.info ? structuredClone(state.info) : null;
  renderNow();
}

// ============================================================ Vorlagen

function presetMeta(p) {
  const parts = [];
  parts.push(p.category ? p.category.name : 'Kategorie bleibt');
  if (p.tags === null) parts.push('Tags bleiben');
  else if (!p.tags.length) parts.push('keine Tags');
  else parts.push(p.tags.join(', '));
  if (p.language) parts.push(langName(p.language));
  return parts.join(' · ');
}

function renderPresets() {
  const list = state.data.presets;
  const box = $('#presets');
  if (!list.length) {
    box.replaceChildren(h('div', { class: 'empty' },
      'Noch keine Vorlagen. Stell oben alles ein und klick auf „＋ Als Vorlage“ – beim nächsten Mal reicht dann ein Klick.'));
    return;
  }
  const canApply = !!state.data.loggedIn;
  box.replaceChildren(h('div', { class: 'presets-list' }, ...list.map((p, index) =>
    h('div', { class: 'preset' },
      art(p.category, 'art'),
      h('div', { class: 'p-main' },
        h('div', { class: 'p-name no-i18n' }, p.name),
        h('div', { class: `p-title${p.title ? '' : ' muted'}`, title: p.title }, p.title || 'Titel bleibt'),
        h('div', { class: 'p-meta', title: presetMeta(p) }, presetMeta(p))),
      h('div', { class: 'p-actions' },
        h('button', { class: 'icon-btn', title: 'Nach oben', disabled: index === 0, onclick: () => move(index, -1) }, '↑'),
        h('button', { class: 'icon-btn', title: 'Nach unten', disabled: index === list.length - 1, onclick: () => move(index, 1) }, '↓'),
        h('button', { class: 'icon-btn', title: 'Bearbeiten', onclick: () => openPresetEditor(p) }, '✎'),
        h('button', { class: 'icon-btn', title: 'Duplizieren', onclick: () => call('/presets/duplicate', { id: p.id }) }, '⧉'),
        h('button', {
          class: 'icon-btn', title: 'Löschen',
          onclick: () => { if (confirm(`Vorlage „${p.name}“ löschen?`)) call('/presets/delete', { id: p.id }); },
        }, '🗑')),
      h('button', { class: 'btn primary small', disabled: !canApply, onclick: (e) => applyPreset(p, e.currentTarget) }, '▶ Anwenden')))));
}

function move(index, dir) {
  const ids = state.data.presets.map((p) => p.id);
  const [id] = ids.splice(index, 1);
  ids.splice(index + dir, 0, id);
  call('/presets/order', { ids });
}

async function applyPreset(preset, button) {
  if (Object.keys(diff()).length && !confirm('Oben sind noch ungespeicherte Änderungen. Die gehen verloren, wenn du die Vorlage anwendest. Trotzdem?')) return;
  button.disabled = true;
  try {
    const data = await api(`${BASE}/presets/apply`, { id: preset.id });
    state.draft = null;
    applyState(data);
    toast(`Vorlage „${preset.name}“ angewendet ✔`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
    button.disabled = false;
  }
}

/** Vorlage bearbeiten. preset = null → neue Vorlage (optional mit Startwerten aus prefill). */
function openPresetEditor(preset, prefill) {
  const p = structuredClone(preset ?? {
    id: '',
    name: prefill?.category?.name ?? '',
    title: prefill?.title ?? '',
    category: prefill?.category ?? null,
    tags: prefill ? [...prefill.tags] : null,
    language: prefill?.language ?? '',
  });
  const isNew = !preset;

  const name = h('input', { type: 'text', value: p.name, placeholder: 'z.B. Minecraft-Abend', maxlength: 60 });
  const title = h('input', { type: 'text', value: p.title, placeholder: 'leer = Titel bleibt, wie er ist', maxlength: 500 });
  const preview = h('div', { class: 'preview' });
  const count = h('span', { class: 'counter' });
  const catBox = h('div', { class: 'cat-row' });
  const tagBlock = h('div', {});
  const tagsOn = h('div', { class: 'opt-row' });
  const language = languageSelect(p.language, true);

  let timer = null;
  const updatePreview = () => {
    clearTimeout(timer);
    const text = title.value.trim();
    if (!text) {
      preview.hidden = true;
      count.textContent = '';
      return;
    }
    timer = setTimeout(async () => {
      try {
        const r = await api(`${BASE}/preview`, { title: text, category: p.category });
        preview.hidden = false;
        preview.textContent = `Vorschau: ${r.title}`;
        preview.classList.toggle('over', r.length > MAX_TITLE);
        count.textContent = countText(r.length);
        count.classList.toggle('over', r.length > MAX_TITLE);
      } catch {
        preview.hidden = true;
      }
    }, 250);
  };
  title.oninput = updatePreview;

  const renderCat = () => {
    catBox.replaceChildren(
      // replaceChildren macht aus null den Text „null“ → leeren Text statt null
      p.category ? h('img', { class: 'game-ph', src: p.category.image || '', alt: '', hidden: !p.category.image }) : '',
      h('div', { class: `cat-name${p.category ? '' : ' none'}` }, p.category ? p.category.name : 'bleibt, wie sie ist'),
      h('button', {
        class: 'btn small',
        onclick: () => gamePicker('Kategorie für die Vorlage', (c) => { p.category = c; renderCat(); updatePreview(); }),
      }, 'Auswählen…'),
      p.category ? h('button', { class: 'icon-btn', title: 'Kategorie nicht ändern', onclick: () => { p.category = null; renderCat(); updatePreview(); } }, '✕') : '');
  };

  const renderTags = () => {
    tagsOn.replaceChildren(
      toggle(p.tags !== null, (on) => { p.tags = on ? (p.tags ?? []) : null; renderTags(); }, 'Tags setzen'),
      h('span', {}, p.tags === null ? 'Tags bleiben, wie sie sind' : 'Tags ersetzen durch:'));
    tagBlock.replaceChildren(...(p.tags === null ? [] : [tagEditor(p.tags, (next) => { p.tags = next; }).el]));
  };

  const save = async () => {
    const body = { ...p, name: name.value, title: title.value, language: language.value };
    try {
      applyState(await api(`${BASE}/presets/save`, body));
      toast(isNew ? 'Vorlage angelegt' : 'Vorlage gespeichert', 'ok');
      close();
    } catch (err) {
      toast(err.message, 'err');
    }
  };

  const close = modal(isNew ? '＋ Neue Vorlage' : `✎ ${p.name}`, [
    field('Name', name),
    h('div', { class: 'field' },
      h('div', { class: 'title-foot' }, h('label', { style: { flex: 1, fontWeight: 600 } }, 'Titel'), count),
      title, preview,
      h('div', { class: 'note' }, 'Variablen: ', ['{datum}', '{wochentag}', '{nr}', '{game}', '{channel}', '{random:1-6}', '{pick:a|b}'].map((v, i) => [i ? ', ' : '', h('code', {}, v)]))),
    field('Kategorie', catBox),
    h('div', { class: 'field' }, h('label', {}, 'Tags'), tagsOn, tagBlock),
    field('Sprache', language),
    h('p', { class: 'note' }, 'Was du leer lässt, bleibt beim Anwenden so, wie es gerade bei Twitch ist.'),
  ], [
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', { class: 'btn primary', onclick: save }, 'Speichern'),
  ]);
  renderCat();
  renderTags();
  updatePreview();
  setTimeout(() => name.focus(), 0);
}

// ============================================================ Chat & Einstellungen

function renderHelp() {
  const c = state.data.chat;
  const box = $('#chat-help');
  const key = JSON.stringify(c);
  if (box.dataset.key === key) return;
  box.dataset.key = key;
  if (!c.enabled || (!c.titleCmd && !c.gameCmd)) {
    box.replaceChildren(h('div', { class: 'note' }, 'Chat-Commands sind aus. Einschalten unter ⚙ Einstellungen.'));
  } else {
    box.replaceChildren(...[
      c.titleCmd ? h('div', {}, h('code', {}, `!${c.titleCmd} <Text>`), ' – setzt den Titel') : null,
      c.gameCmd ? h('div', {}, h('code', {}, `!${c.gameCmd} <Name>`), ' – setzt die Kategorie (bester Suchtreffer), z.B. ', h('code', {}, `!${c.gameCmd} minecraft`)) : null,
      h('div', { class: 'note' }, `Ändern dürfen: ${ROLE_NAMES[c.minRole] ?? c.minRole}.`),
      h('div', { class: 'note' }, c.everyoneCanAsk
        ? 'Ohne Text zeigen die Commands den aktuellen Titel bzw. die Kategorie – das darf jeder (alle 10 s).'
        : 'Ohne Text zeigen die Commands den aktuellen Stand – nur für die, die auch ändern dürfen.'),
    ].filter(Boolean));
  }
  void checkConflicts();
}

/** Gibt es im Commands-Addon einen Command mit gleichem Namen? Dann würden zwei Antworten kommen. */
async function checkConflicts() {
  const c = state.data.chat;
  const names = c.enabled ? [c.titleCmd, c.gameCmd].filter(Boolean) : [];
  let clash = [];
  if (names.length) {
    try {
      const cmds = await api('addons/commands/state');
      clash = cmds.settings.commands
        .filter((x) => x.enabled && [x.name, ...x.aliases].some((n) => names.includes(n)))
        .map((x) => `${cmds.settings.prefix}${x.name}`);
    } catch {
      // Commands-Addon ist aus → kein Konflikt
    }
  }
  $('#conflict').replaceChildren(...(clash.length
    ? [h('div', { class: 'conflict' }, `⚠ Im Chat-Commands-Addon gibt es auch ${clash.join(', ')}. Dann antworten beide. Schalte den Command dort aus oder benenne ihn hier um.`)]
    : []));
}

function openSettings() {
  const c = structuredClone(state.data.chat);
  const titleCmd = h('input', { type: 'text', value: c.titleCmd, maxlength: 30, placeholder: '(aus)' });
  const gameCmd = h('input', { type: 'text', value: c.gameCmd, maxlength: 30, placeholder: '(aus)' });
  const role = h('select', {}, ...Object.entries(ROLE_NAMES).map(([value, label]) => h('option', { value }, label)));
  role.value = c.minRole;
  const counter = h('input', { type: 'number', min: 0, max: 1000000, value: state.data.counter });

  const save = async () => {
    const ok = await call('/settings', {
      chat: { enabled: c.enabled, titleCmd: titleCmd.value, gameCmd: gameCmd.value, minRole: role.value, everyoneCanAsk: c.everyoneCanAsk },
      counter: Number(counter.value),
    });
    if (ok) {
      toast('Gespeichert', 'ok');
      close();
    }
  };

  const close = modal('⚙ Stream-Info-Einstellungen', [
    h('div', { class: 'sub' }, 'CHAT-COMMANDS'),
    h('div', { class: 'opt-row' }, toggle(c.enabled, (on) => { c.enabled = on; }, 'Chat-Commands an/aus'), h('span', {}, 'Titel und Kategorie per Chat ändern')),
    h('div', { class: 'f-row' }, field('Titel-Command (ohne !)', titleCmd), field('Kategorie-Command (ohne !)', gameCmd)),
    field('Wer darf ändern?', role),
    h('div', { class: 'opt-row' },
      toggle(c.everyoneCanAsk, (on) => { c.everyoneCanAsk = on; }, 'Alle dürfen fragen'),
      h('span', {}, 'Alle dürfen ohne Text nach dem aktuellen Titel/der Kategorie fragen')),
    h('div', { class: 'sub' }, 'STREAM-ZÄHLER'),
    field('Letzte Stream-Nummer ({nr})', counter),
    h('p', { class: 'note' }, 'Beim nächsten Anwenden einer Vorlage mit {nr} wird daraus diese Zahl + 1.'),
  ], [
    h('span', { class: 'spacer' }),
    h('button', { class: 'btn', onclick: () => close() }, 'Abbrechen'),
    h('button', { class: 'btn primary', onclick: save }, 'Speichern'),
  ]);
}

// ============================================================ Live-Updates

/** Der Server meldet sich, sobald sich bei Twitch etwas ändert (auch im Dashboard) */
function connect() {
  const ws = new WebSocket(`ws://${location.host}/ws?channel=streaminfo`);
  ws.onmessage = (e) => {
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === 'info') void load();
  };
  ws.onclose = () => setTimeout(connect, 3000);
}

// ============================================================ Start

(async () => {
  $('#refresh').onclick = () => call('/refresh', {});
  $('#open-settings').onclick = openSettings;
  $('#save').onclick = save;
  $('#discard').onclick = discard;
  $('#new-preset').onclick = () => openPresetEditor(null);
  $('#to-preset').onclick = () => openPresetEditor(null, state.draft);
  $('#cat-change').onclick = () => gamePicker('Kategorie wählen', setCategory);
  $('#cat-clear').onclick = () => setCategory(null);
  $('#recent-toggle').onclick = () => { $('#recent-titles').hidden = !$('#recent-titles').hidden; };
  $('#title').oninput = (e) => {
    if (!state.draft) return;
    state.draft.title = e.target.value;
    renderTitleInfo();
    renderDirty();
  };
  $('#title').onkeydown = (e) => { if (e.key === 'Enter' && !$('#save').disabled) save(); };
  $('#language').onchange = (e) => {
    if (!state.draft) return;
    state.draft.language = e.target.value;
    renderDirty();
  };

  await load();
  connect();
  // Nicht eingeloggt oder Fehler? Ab und zu nachsehen, ob es jetzt klappt.
  setInterval(() => {
    if (state.data && state.data.loggedIn && !state.data.error) return;
    if ($('#modal-host').childElementCount) return;
    void load();
  }, 15000);
})();
