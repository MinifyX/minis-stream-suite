// Hintergrund-Teil der Erweiterung: lädt Emote- und Abzeichen-Listen für das Chat-Skript.
// Nur diese Adressen sind erlaubt – sonst könnte die Seite die Erweiterung als Proxy missbrauchen.
const ALLOWED = [
  'https://7tv.io/v3/',
  'https://api.betterttv.net/3/',
  'https://api.frankerfacez.com/v1/',
  'https://api.ivr.fi/v2/twitch/badges/',
];

const ext = globalThis.browser ?? globalThis.chrome;

ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'fetchJson' || typeof msg.url !== 'string' || !ALLOWED.some((prefix) => msg.url.startsWith(prefix))) {
    return false;
  }
  fetch(msg.url)
    .then(async (res) => sendResponse(res.ok ? { ok: true, data: await res.json() } : { ok: false }))
    .catch(() => sendResponse({ ok: false }));
  return true; // Antwort kommt asynchron
});
