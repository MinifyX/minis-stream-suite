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
