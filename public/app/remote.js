// Karte „Streamdeck & Fernsteuerung“: Schlüssel (X-Suite-Token) und Endpunkte zum Kopieren.
// Nutzung: RemoteCard.render(container, [['POST', '/api/intro/go', 'Trigger „go“'], …])
window.RemoteCard = (() => {
  const { h, api, toast } = window.UI;

  async function copy(text, what) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${what} kopiert`, 'ok');
    } catch {
      toast('Kopieren hat nicht geklappt – bitte von Hand markieren.', 'err');
    }
  }

  async function render(container, endpoints) {
    let info;
    try {
      info = await api('core/api-token');
    } catch (err) {
      container.replaceChildren(h('p', { class: 'warn-note' }, err.message));
      return;
    }
    let shown = false;
    const tokenBox = h('code', { class: 'remote-token no-i18n' });
    const paint = () => {
      tokenBox.textContent = shown ? info.token : '•'.repeat(Math.min(24, info.token.length));
    };
    paint();

    const regenerate = async () => {
      if (!confirm('Neuen Schlüssel erzeugen? Streamdeck-Buttons mit dem alten Schlüssel funktionieren dann nicht mehr.')) return;
      try {
        info = await api('core/api-token/regenerate', {});
        shown = true;
        paint();
        toast('Neuer Schlüssel erzeugt', 'ok');
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    const first = endpoints.find(([method]) => method === 'POST') ?? endpoints[0];
    const curl = `curl -X ${first[0]} -H "X-Suite-Token: ${info.token}" ${info.baseUrl}${first[1]}`;

    container.replaceChildren(
      h('p', { class: 'note' }, 'Für Streamdeck (Plugin „API Ninja“, „Web Requests“ o. Ä.) oder Bitfocus Companion: HTTP-Anfrage an die Adresse schicken, mit dem Header ', h('code', {}, 'X-Suite-Token'), '. Läuft nur auf diesem PC (127.0.0.1).'),
      h('div', { class: 'remote-row' },
        tokenBox,
        h('button', { class: 'btn small', onclick: () => { shown = !shown; paint(); } }, shown ? 'Verbergen' : 'Zeigen'),
        h('button', { class: 'btn small', onclick: () => copy(info.token, 'Schlüssel') }, 'Kopieren')),
      info.fromEnv
        ? h('p', { class: 'note' }, 'Der Schlüssel kommt aus der Umgebungsvariable SUITE_API_TOKEN.')
        : h('button', { class: 'link-btn', onclick: regenerate }, 'Neuen Schlüssel erzeugen'),
      h('div', { class: 'remote-list' },
        ...endpoints.map(([method, path, label]) => h('div', { class: 'remote-ep' },
          h('span', { class: `badge ${method === 'GET' ? '' : 'accent'}` }, method),
          h('code', { class: 'no-i18n', title: 'Klicken zum Kopieren', onclick: () => copy(info.baseUrl + path, 'Adresse') }, path),
          h('span', { class: 'note' }, label)))),
      h('details', {},
        h('summary', {}, h('span', { class: 'note' }, 'Beispiel mit curl')),
        h('code', { class: 'remote-curl no-i18n' }, curl)),
    );
  }

  return { render };
})();
