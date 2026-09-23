import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';
import { ChatService, duration, parseRole, renderTemplate, roleLevel, ROLE_LEVEL, type TemplateContext } from './chat';
import type { ConfigStore } from './config';
import type { CoreConfig } from './coreConfig';
import type { TwitchApi } from './twitch/api';
import type { TwitchAuth, TwitchUser } from './twitch/auth';

// ------------------------------------------------------------------ Test-Helfer

const BROADCASTER = { id: '100', login: 'mini', displayName: 'Mini' } as TwitchUser;
const BOT = { id: '200', login: 'minibot', displayName: 'MiniBot' } as TwitchUser;

const fakeAuth = (user: TwitchUser | null) => ({ user }) as unknown as TwitchAuth;

interface Call {
  method: string;
  endpoint: string;
  options: { query?: Record<string, string>; body?: Record<string, unknown> };
}

/** Falsche Twitch-API: merkt sich alle Aufrufe, Antwort kommt aus `respond` */
function fakeApi(respond: (call: Call) => unknown = () => ({ data: [] })) {
  const calls: Call[] = [];
  const api = {
    async request(method: string, endpoint: string, options: Call['options'] = {}) {
      const call = { method, endpoint, options };
      calls.push(call);
      return respond(call);
    },
  } as unknown as TwitchApi;
  return { api, calls };
}

const fakeConfig = (values: Partial<CoreConfig>) => ({ get: (key: keyof CoreConfig) => values[key] }) as unknown as ConfigStore<CoreConfig>;

// ------------------------------------------------------------------ Rollen

describe('Rollen', () => {
  test('roleLevel liest die Abzeichen', () => {
    assert.equal(roleLevel([]), ROLE_LEVEL.everyone);
    assert.equal(roleLevel(['subscriber']), ROLE_LEVEL.subscriber);
    assert.equal(roleLevel(['founder']), ROLE_LEVEL.subscriber);
    assert.equal(roleLevel(['vip']), ROLE_LEVEL.vip);
    assert.equal(roleLevel(['moderator']), ROLE_LEVEL.moderator);
    assert.equal(roleLevel(['lead_moderator']), ROLE_LEVEL.moderator);
    assert.equal(roleLevel(['broadcaster']), ROLE_LEVEL.broadcaster);
    assert.equal(roleLevel(['premium', 'glhf-pledge']), ROLE_LEVEL.everyone);
  });

  test('roleLevel nimmt die höchste Rolle', () => {
    assert.equal(roleLevel(['subscriber', 'vip']), ROLE_LEVEL.vip);
    assert.equal(roleLevel(['subscriber', 'moderator', 'vip']), ROLE_LEVEL.moderator);
    assert.equal(roleLevel(['broadcaster', 'subscriber']), ROLE_LEVEL.broadcaster);
  });

  test('roleLevel: isBroadcaster schlägt alles', () => {
    assert.equal(roleLevel([], true), ROLE_LEVEL.broadcaster);
  });

  test('Stufen sind aufsteigend sortiert', () => {
    assert.ok(ROLE_LEVEL.everyone < ROLE_LEVEL.subscriber);
    assert.ok(ROLE_LEVEL.subscriber < ROLE_LEVEL.vip);
    assert.ok(ROLE_LEVEL.vip < ROLE_LEVEL.moderator);
    assert.ok(ROLE_LEVEL.moderator < ROLE_LEVEL.broadcaster);
  });

  test('parseRole übernimmt nur bekannte Rollen', () => {
    assert.equal(parseRole('vip'), 'vip');
    assert.equal(parseRole('moderator', 'vip'), 'moderator');
    assert.equal(parseRole('admin'), 'everyone');
    assert.equal(parseRole('VIP'), 'everyone');
    assert.equal(parseRole(undefined), 'everyone');
    assert.equal(parseRole(3, 'subscriber'), 'subscriber');
  });
});

// ------------------------------------------------------------------ Dauer

describe('duration', () => {
  const MIN = 60_000;
  test('Minuten, Stunden, Tage', () => {
    assert.equal(duration(0), '0 Min.');
    assert.equal(duration(MIN - 1), '0 Min.');
    assert.equal(duration(MIN), '1 Min.');
    assert.equal(duration(59 * MIN), '59 Min.');
    assert.equal(duration(60 * MIN), '1 Std.');
    assert.equal(duration(65 * MIN), '1 Std. 5 Min.');
    assert.equal(duration(1440 * MIN), '1 Tag');
    assert.equal(duration(1445 * MIN), '1 Tag 5 Min.');
    assert.equal(duration((2 * 1440 + 3 * 60 + 5) * MIN), '2 Tage 3 Std. 5 Min.');
  });
});

// ------------------------------------------------------------------ Variablen

describe('renderTemplate', () => {
  const render = (template: string, context: TemplateContext = {}, respond?: (call: Call) => unknown, user: TwitchUser | null = BROADCASTER) => {
    const { api, calls } = fakeApi(respond);
    return renderTemplate(template, api, fakeAuth(user), context).then((text) => ({ text, calls }));
  };
  const chatter = { id: '5', name: 'Zuschauer' };

  afterEach(() => mock.restoreAll());

  test('user, touser, args, channel', async () => {
    const context = { user: chatter, args: ['@Freund', 'zwei'] };
    assert.equal((await render('{user} grüßt {touser}', context)).text, 'Zuschauer grüßt Freund');
    assert.equal((await render('{args}|{arg1}|{arg2}|{arg3}', context)).text, '@Freund zwei|@Freund|zwei|');
    assert.equal((await render('{channel}', context)).text, 'Mini');
  });

  test('touser ohne Argument ist der Zuschauer selbst', async () => {
    assert.equal((await render('{touser}', { user: chatter })).text, 'Zuschauer');
    assert.equal((await render('{touser}', { user: chatter, args: ['@'] })).text, 'Zuschauer');
  });

  test('ohne Zuschauer: der Kanal selbst – ohne Login: leer', async () => {
    assert.equal((await render('{user}')).text, 'Mini');
    assert.equal((await render('[{user}][{channel}]', {}, undefined, null)).text, '[][]');
  });

  test('Groß-/Kleinschreibung der Variablen egal', async () => {
    assert.equal((await render('{USER} {User}', { user: chatter })).text, 'Zuschauer Zuschauer');
  });

  test('feste Werte haben Vorrang', async () => {
    assert.equal((await render('{count} {user}', { user: chatter, values: { count: '5', user: 'Überschrieben' } })).text, '5 Überschrieben');
  });

  test('unbekannte Variablen bleiben stehen', async () => {
    assert.equal((await render('{gibtsnicht} {nochwas:123} {}', { user: chatter })).text, '{gibtsnicht} {nochwas:123} {}');
  });

  test('{random:min-max}', async (t) => {
    const random = t.mock.method(Math, 'random', () => 0);
    assert.equal((await render('{random:1-6}')).text, '1');
    random.mock.mockImplementation(() => 0.9999);
    assert.equal((await render('{random:1-6}')).text, '6');
    assert.equal((await render('{random}')).text, '100');
    assert.equal((await render('{random:5-5}')).text, '5');
    assert.equal((await render('{random:0-1}')).text, '1');
  });

  test('{random} mit Unsinn bleibt stehen', async () => {
    for (const template of ['{random:6-1}', '{random:abc}', '{random:1-}', '{random:x-5}']) {
      assert.equal((await render(template)).text, template);
    }
  });

  test('{random} liegt immer im Bereich', async () => {
    for (let i = 0; i < 200; i++) {
      const n = Number((await render('{random:1-6}')).text);
      assert.ok(Number.isInteger(n) && n >= 1 && n <= 6, `außerhalb: ${n}`);
    }
  });

  test('{pick:a|b|c}', async (t) => {
    const random = t.mock.method(Math, 'random', () => 0);
    assert.equal((await render('{pick:Stein| Schere |Papier}')).text, 'Stein');
    random.mock.mockImplementation(() => 0.5);
    assert.equal((await render('{pick:Stein| Schere |Papier}')).text, 'Schere');
    random.mock.mockImplementation(() => 0.9999);
    assert.equal((await render('{pick:Stein| Schere |Papier}')).text, 'Papier');
    // leere Einträge zählen nicht
    assert.equal((await render('{pick:||Nur das||}')).text, 'Nur das');
  });

  test('{pick} ohne Auswahl bleibt stehen', async () => {
    for (const template of ['{pick}', '{pick:}', '{pick:|}', '{pick: | }']) {
      assert.equal((await render(template)).text, template);
    }
  });

  test('Twitch wird nur gefragt, wenn der Text es braucht', async () => {
    const { calls } = await render('{user} {random:1-6} {pick:a|b} {args}', { user: chatter });
    assert.equal(calls.length, 0);
  });

  test('{game} und {title}: ein Aufruf für beide', async () => {
    const respond = (call: Call) => (call.endpoint === '/channels' ? { data: [{ game_name: 'Minecraft', title: 'Bauen!' }] } : { data: [] });
    const { text, calls } = await render('{game} – {title}', {}, respond);
    assert.equal(text, 'Minecraft – Bauen!');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].options.query?.broadcaster_id, BROADCASTER.id);
  });

  test('{game} ohne Kategorie oder bei Fehler', async () => {
    assert.equal((await render('{game}', {}, () => ({ data: [{ game_name: '', title: '' }] }))).text, 'keine Kategorie');
    const fail = () => {
      throw new Error('offline');
    };
    assert.equal((await render('{game}|{title}', {}, fail)).text, 'keine Kategorie|');
  });

  test('{uptime}', async () => {
    const started = new Date(Date.now() - 65 * 60_000).toISOString();
    assert.equal((await render('{uptime}', {}, () => ({ data: [{ started_at: started }] }))).text, '1 Std. 5 Min.');
    assert.equal((await render('{uptime}', {}, () => ({ data: [] }))).text, 'gerade offline');
    const fail = () => {
      throw new Error('kaputt');
    };
    assert.equal((await render('{uptime}', {}, fail)).text, 'unbekannt');
    assert.equal((await render('{uptime}', {}, undefined, null)).text, 'unbekannt');
  });

  test('{followage}', async () => {
    const now = new Date();
    const yesterday = new Date(Date.now() - 86_400_000 - 60_000).toISOString();
    const twoYears = new Date(now.getFullYear() - 2, now.getMonth(), Math.min(now.getDate(), 28)).toISOString();
    const followedAt = (at: string) => () => ({ data: [{ followed_at: at }] });

    assert.equal((await render('{followage}', { user: chatter }, followedAt(yesterday))).text, '1 Tag');
    assert.equal((await render('{followage}', { user: chatter }, followedAt(twoYears))).text, '2 Jahren');
    assert.equal((await render('{followage}', { user: chatter }, () => ({ data: [] }))).text, 'gar nicht');
    // Der Kanal selbst folgt sich nicht – Twitch wird gar nicht erst gefragt
    const self = await render('{followage}', {});
    assert.equal(self.text, 'schon immer (das ist der Kanal selbst)');
    assert.equal(self.calls.length, 0);
  });

  test('Ergebnis höchstens 500 Zeichen', async () => {
    const { text } = await render('{args}', { args: ['x'.repeat(800)] });
    assert.equal(text.length, 500);
  });
});

// ------------------------------------------------------------------ Warteschlange

describe('ChatService', () => {
  const START = 1_000_000;
  /** Alle wartenden Promises abarbeiten (echte Timer sind aus, setImmediate nicht) */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  let idCounter = 0;
  const sent = () => ({ data: [{ message_id: `msg-${++idCounter}`, is_sent: true }] });

  beforeEach(() => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START });
    // Warnungen des Loggers nicht in die Testausgabe schreiben
    mock.method(console, 'warn', () => {});
    mock.method(console, 'log', () => {});
  });
  afterEach(() => {
    mock.timers.reset();
    mock.restoreAll();
  });

  function setup(options: { bot?: boolean; botEnabled?: boolean; botFallback?: boolean; botRespond?: (call: Call) => unknown; respond?: (call: Call) => unknown } = {}) {
    const main = fakeApi(options.respond ?? sent);
    const bot = fakeApi(options.botRespond ?? sent);
    const chat = new ChatService(
      fakeAuth(BROADCASTER),
      main.api,
      fakeAuth(options.bot ? BOT : null),
      bot.api,
      fakeConfig({ botEnabled: options.botEnabled ?? !!options.bot, botFallback: options.botFallback ?? false }),
    );
    return { chat, main: main.calls, bot: bot.calls };
  }
  const message = (call: Call) => call.options.body?.message;

  test('schickt an den richtigen Endpunkt', async () => {
    const { chat, main } = setup();
    await chat.send('Hallo');
    assert.equal(main.length, 1);
    assert.equal(main[0].method, 'POST');
    assert.equal(main[0].endpoint, '/chat/messages');
    assert.deepEqual(main[0].options.body, { broadcaster_id: BROADCASTER.id, sender_id: BROADCASTER.id, message: 'Hallo' });
  });

  test('Zeilenumbrüche werden zu Leerzeichen, max. 500 Zeichen, leere Nachrichten entfallen', async () => {
    const { chat, main } = setup();
    await chat.send('  Zeile 1 \r\n   Zeile 2\nZeile 3  ');
    assert.equal(message(main[0]), 'Zeile 1 Zeile 2 Zeile 3');
    mock.timers.tick(2000);
    await chat.send('y'.repeat(600));
    assert.equal((message(main[1]) as string).length, 500);
    await chat.send('  \n  ');
    assert.equal(main.length, 2);
  });

  test('Antwort auf eine Nachricht (Kurzform und Optionen)', async () => {
    const { chat, main } = setup();
    await chat.send('a', 'parent-1');
    mock.timers.tick(2000);
    await chat.send('b', { replyTo: 'parent-2' });
    assert.equal(main[0].options.body?.reply_parent_message_id, 'parent-1');
    assert.equal(main[1].options.body?.reply_parent_message_id, 'parent-2');
  });

  test('Reihenfolge bleibt, mit Mindestabstand 1,1 s', async () => {
    const { chat, main } = setup();
    const done = [chat.send('eins'), chat.send('zwei'), chat.send('drei')];
    await flush();
    assert.deepEqual(main.map(message), ['eins']);
    mock.timers.tick(1099);
    await flush();
    assert.deepEqual(main.map(message), ['eins']);
    mock.timers.tick(1);
    await flush();
    assert.deepEqual(main.map(message), ['eins', 'zwei']);
    mock.timers.tick(1100);
    await flush();
    assert.deepEqual(main.map(message), ['eins', 'zwei', 'drei']);
    await Promise.all(done);
  });

  test('nach einer Pause wird sofort gesendet', async () => {
    const { chat, main } = setup();
    await chat.send('eins');
    mock.timers.tick(5000);
    chat.send('zwei');
    await flush();
    assert.equal(main.length, 2);
  });

  test('Bot ohne Mod-Rechte: 1,6 s Abstand – als Mod 1,1 s', async () => {
    const { chat, bot } = setup({ bot: true });
    chat.send('eins');
    chat.send('zwei');
    await flush();
    mock.timers.tick(1100);
    await flush();
    assert.equal(bot.length, 1);
    mock.timers.tick(500);
    await flush();
    assert.equal(bot.length, 2);

    chat.botIsMod = true;
    mock.timers.tick(5000);
    chat.send('drei');
    chat.send('vier');
    await flush();
    mock.timers.tick(1100);
    await flush();
    assert.equal(bot.length, 4);
  });

  test('Bot schreibt, wenn verknüpft und eingeschaltet', async () => {
    const { chat, main, bot } = setup({ bot: true });
    assert.equal(chat.activeBot?.id, BOT.id);
    await chat.send('vom Bot');
    assert.equal(main.length, 0);
    assert.equal(bot[0].options.body?.sender_id, BOT.id);
    assert.equal(bot[0].options.body?.broadcaster_id, BROADCASTER.id);
  });

  test('Bot ausgeschaltet → eigener Account', async () => {
    const { chat, main, bot } = setup({ bot: true, botEnabled: false });
    assert.equal(chat.activeBot, null);
    await chat.send('selbst');
    assert.equal(bot.length, 0);
    assert.equal(main.length, 1);
  });

  test('as: "broadcaster" schreibt immer mit dem eigenen Account', async () => {
    const { chat, main, bot } = setup({ bot: true });
    await chat.send('selbst', { as: 'broadcaster' });
    assert.equal(bot.length, 0);
    assert.equal(main[0].options.body?.sender_id, BROADCASTER.id);
  });

  test('Bot-Fehler: mit Notfall-Einstellung übernimmt der eigene Account', async () => {
    const fail = () => {
      throw new Error('gebannt');
    };
    const withFallback = setup({ bot: true, botFallback: true, botRespond: fail });
    await withFallback.chat.send('trotzdem');
    assert.equal(withFallback.bot.length, 1);
    assert.equal(withFallback.main.length, 1);

    const withoutFallback = setup({ bot: true, botFallback: false, botRespond: fail });
    await assert.rejects(withoutFallback.chat.send('geht nicht'), /gebannt/);
    assert.equal(withoutFallback.main.length, 0);
  });

  test('von Twitch verworfene Nachricht → Fehler, die Warteschlange läuft weiter', async () => {
    let first = true;
    const respond = () => {
      if (!first) return sent();
      first = false;
      return { data: [{ message_id: '', is_sent: false, drop_reason: { message: 'Spam' } }] };
    };
    const { chat, main } = setup({ respond });
    const a = chat.send('eins');
    const b = chat.send('zwei');
    await assert.rejects(a, /Spam/);
    await flush();
    mock.timers.tick(1100);
    await b;
    assert.equal(main.length, 2);
  });

  test('nicht eingeloggt → Fehler', async () => {
    const { api } = fakeApi(sent);
    const chat = new ChatService(fakeAuth(null), api, fakeAuth(null), api, fakeConfig({}));
    await assert.rejects(chat.send('hallo'), /Nicht bei Twitch eingeloggt/);
  });

  test('höchstens 15 Nachrichten warten, der Rest wird übersprungen', async () => {
    const { chat, main } = setup();
    const all = Array.from({ length: 20 }, (_, i) => chat.send(`Nr. ${i + 1}`));
    for (let i = 0; i < 20; i++) {
      await flush();
      mock.timers.tick(1100);
    }
    await Promise.all(all);
    assert.equal(main.length, 15);
    assert.deepEqual(main.map(message), Array.from({ length: 15 }, (_, i) => `Nr. ${i + 1}`));
    // Danach ist wieder Platz
    await chat.send('wieder frei');
    assert.equal(main.length, 16);
  });

  test('eigene Nachrichten werden erkannt', async () => {
    const { chat } = setup();
    idCounter = 0;
    await chat.send('hallo');
    assert.equal(chat.isOwnMessage('msg-1'), true);
    assert.equal(chat.isOwnMessage('msg-999'), false);
  });

  test('isBot erkennt den verknüpften Bot', () => {
    assert.equal(setup({ bot: true }).chat.isBot(BOT.id), true);
    assert.equal(setup({ bot: true }).chat.isBot(BROADCASTER.id), false);
    assert.equal(setup().chat.isBot(BOT.id), false);
  });
});
