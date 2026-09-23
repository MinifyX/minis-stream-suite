// Kleine Helfer, die die App und alle Addon-Seiten nutzen können.
window.UI = (() => {
  const $ = (selector, root = document) => root.querySelector(selector);

  /** Element bauen: h('button', { class: 'btn', onclick: fn }, 'Text') */
  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'class') el.className = value;
      else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
      else if (key === 'value') el.value = value;
      else el.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child === null || child === undefined || child === false) continue;
      el.append(child instanceof Node ? child : String(child));
    }
    return el;
  }

  /** API-Aufruf: api('core/status') = GET, api('core/logout', {}) = POST */
  async function api(path, body) {
    const options = body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    const res = await fetch(`/api/${path}`, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || res.statusText);
    return data;
  }

  function toast(message, type = 'info') {
    let host = $('.toast-host');
    if (!host) host = document.body.appendChild(h('div', { class: 'toast-host' }));
    const el = h('div', { class: `toast ${type}` }, message);
    host.append(el);
    setTimeout(() => el.remove(), 3500);
  }

  /** Ein/Aus-Schalter */
  function toggle(checked, onchange, label) {
    return h('label', { class: 'switch', title: label },
      h('input', { type: 'checkbox', checked, 'aria-label': label, onchange: (e) => onchange(e.target.checked) }),
      h('span'));
  }

  return { $, h, api, toast, toggle };
})();

/**
 * Sprache der Oberfläche. Geschrieben ist alles auf Deutsch; bei „English“ ersetzt dieser Teil
 * die Texte auf der Seite mit denen aus /app/i18n/en.json – auch alles, was später dazukommt.
 *
 * en.json: { "texts": { "Deutscher Text": "English text" }, "patterns": [["^vor (\\d+) Min\\.$", "$1 min ago"]] }
 * Texte von Zuschauern (Chat-Nachrichten) und alles mit class="no-i18n" bleibt, wie es ist.
 */
window.I18N = (() => {
  const KEY = 'suite-lang';
  const read = () => {
    try {
      return localStorage.getItem(KEY) === 'en' ? 'en' : 'de';
    } catch {
      return 'de';
    }
  };
  const lang = read();
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  const SKIP = 'script, style, textarea, code, .no-i18n, .cr-msg, .cr-text, .q-input';
  let texts = null;
  let patterns = [];

  /** Einen Text übersetzen (unbekannte Texte bleiben Deutsch) */
  function tr(text) {
    if (!texts || typeof text !== 'string') return text;
    const trimmed = text.trim();
    if (!trimmed) return text;
    // Zeilenumbrüche/Einrückung (z.B. aus dem HTML) zählen wie ein Leerzeichen
    const key = trimmed.replace(/\s+/g, ' ');
    let out = texts[key];
    if (out === undefined) {
      for (const [re, replacement] of patterns) {
        if (re.test(key)) {
          out = key.replace(re, replacement);
          break;
        }
      }
    }
    if (out === undefined) return text;
    // Leerzeichen am Rand erhalten (wichtig zwischen Elementen)
    return text.slice(0, text.indexOf(trimmed[0])) + out + text.slice(text.lastIndexOf(trimmed.at(-1)) + 1);
  }

  function translateAttrs(el) {
    for (const attr of ATTRS) {
      const value = el.getAttribute(attr);
      if (!value) continue;
      const next = tr(value);
      if (next !== value) el.setAttribute(attr, next);
    }
  }

  function translateNode(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.parentElement?.closest(SKIP)) return;
      const next = tr(node.nodeValue);
      if (next !== node.nodeValue) node.nodeValue = next;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE || node.closest(SKIP)) return;
    translateAttrs(node);
    for (const child of node.childNodes) translateNode(child);
  }

  async function start() {
    try {
      const dict = await fetch('/app/i18n/en.json').then((r) => r.json());
      texts = dict.texts ?? {};
      patterns = (dict.patterns ?? []).map(([re, replacement]) => [new RegExp(re), replacement]);
    } catch {
      return;
    }
    document.documentElement.lang = 'en';
    document.title = tr(document.title);
    translateNode(document.body);
    new MutationObserver((changes) => {
      for (const change of changes) {
        if (change.type === 'childList') change.addedNodes.forEach(translateNode);
        else if (change.type === 'characterData') translateNode(change.target);
        else if (!change.target.closest(SKIP)) translateAttrs(change.target);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    // Rückfragen und Hinweise des Browsers
    for (const name of ['confirm', 'alert', 'prompt']) {
      const original = window[name].bind(window);
      window[name] = (message, ...rest) => original(tr(String(message ?? '')), ...rest);
    }
  }

  if (lang === 'en') {
    if (document.body) start();
    else document.addEventListener('DOMContentLoaded', start);
  }

  /** Sprache umstellen – gilt für alle Seiten der Suite, danach neu laden */
  function setLang(next) {
    try {
      localStorage.setItem(KEY, next === 'en' ? 'en' : 'de');
    } catch {
      // ohne Speicher bleibt es bei Deutsch
    }
  }

  return { lang, tr, setLang };
})();
