import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { EVENT_TYPES, makeTestEvent, normalizeEvent, type EventOfType, type StreamEvent, type StreamEventType } from './events';

/** normalizeEvent mit Typ-Prüfung: das Ergebnis muss die erwartete Event-Art haben */
function normalize<T extends StreamEventType>(type: T, subscriptionType: string, payload: unknown): EventOfType<T> {
  const event = normalizeEvent(subscriptionType, payload);
  assert.ok(event, `${subscriptionType} → null`);
  assert.equal(event.type, type);
  return event as EventOfType<T>;
}

/** Findet Felder mit undefined (die gibt es in einem sauberen Event nicht) */
function undefinedPaths(value: unknown, path = ''): string[] {
  if (value === undefined) return [path || '(Wurzel)'];
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => undefinedPaths(child, `${path}.${key}`));
}

describe('normalizeEvent: Kanalpunkte', () => {
  const redemption = {
    id: 'red-1',
    user_id: '11',
    user_login: 'zuschauer',
    user_name: 'Zuschauer',
    user_input: 'Hallo!',
    status: 'fulfilled',
    reward: { id: 'rw-1', title: 'Hydrate', cost: 500, prompt: 'Trink was' },
    redeemed_at: '2026-09-23T12:00:00Z',
  };

  test('Einlösung mit Status', () => {
    assert.deepEqual(normalize('redemption', 'channel.channel_points_custom_reward_redemption.add', redemption), {
      type: 'redemption',
      redemptionId: 'red-1',
      user: { id: '11', login: 'zuschauer', name: 'Zuschauer' },
      reward: { id: 'rw-1', title: 'Hydrate', cost: 500 },
      input: 'Hallo!',
      status: 'fulfilled',
    });
  });

  test('Einlösung ohne Status und Text → wartet, leerer Text', () => {
    const { status, user_input, ...rest } = redemption;
    const event = normalize('redemption', 'channel.channel_points_custom_reward_redemption.add', rest);
    assert.equal(event.status, 'unfulfilled');
    assert.equal(event.input, '');
  });

  test('Einlösung erledigt oder zurückerstattet', () => {
    const update = (status: string, reward: unknown = { id: 'rw-1' }) =>
      normalize('redemptionupdate', 'channel.channel_points_custom_reward_redemption.update', { id: 'red-1', status, reward });
    assert.deepEqual(update('canceled'), { type: 'redemptionupdate', redemptionId: 'red-1', rewardId: 'rw-1', status: 'canceled' });
    assert.equal(update('fulfilled').status, 'fulfilled');
    // Alles, was nicht "canceled" ist, gilt als erledigt
    assert.equal(update('irgendwas').status, 'fulfilled');
    assert.equal(update('canceled', null).rewardId, '');
  });
});

describe('normalizeEvent: Abos, Bits, Raids', () => {
  test('anonyme Gift-Abos und Cheers haben keinen Nutzer', () => {
    assert.equal(normalize('giftsub', 'channel.subscription.gift', { is_anonymous: true, user_id: null, tier: '1000', total: 5 }).user, null);
    assert.equal(normalize('cheer', 'channel.cheer', { is_anonymous: true, bits: 100 }).user, null);
    assert.equal(normalize('giftsub', 'channel.subscription.gift', { user_id: '1', user_login: 'a', user_name: 'A', tier: '1000' }).count, 1);
  });

  test('Resub', () => {
    const event = normalize('resub', 'channel.subscription.message', {
      user_id: '1',
      user_login: 'a',
      user_name: 'A',
      tier: '2000',
      cumulative_months: 14,
      message: { text: 'Danke!' },
    });
    assert.equal(event.months, 14);
    assert.equal(event.message, 'Danke!');
  });

  test('Name fehlt → Login als Name', () => {
    const event = normalize('follow', 'channel.follow', { user_id: '1', user_login: 'nur_login' });
    assert.deepEqual(event.user, { id: '1', login: 'nur_login', name: 'nur_login' });
  });
});

describe('normalizeEvent: Umfrage', () => {
  const poll = {
    id: 'poll-1',
    title: 'Welches Spiel?',
    choices: [
      { id: 'a', title: 'Minecraft', votes: 7, channel_points_votes: 2 },
      { id: 'b', title: 'Tetris' },
    ],
    started_at: '2026-09-23T12:00:00Z',
    ends_at: '2026-09-23T12:02:00Z',
  };

  test('Phasen aus dem Abo-Typ', () => {
    assert.equal(normalize('poll', 'channel.poll.begin', poll).phase, 'begin');
    assert.equal(normalize('poll', 'channel.poll.progress', poll).phase, 'progress');
    assert.equal(normalize('poll', 'channel.poll.end', { ...poll, status: 'completed' }).phase, 'end');
  });

  test('Stimmen fehlen am Anfang → 0', () => {
    assert.deepEqual(normalize('poll', 'channel.poll.begin', poll), {
      type: 'poll',
      phase: 'begin',
      pollId: 'poll-1',
      title: 'Welches Spiel?',
      choices: [
        { id: 'a', title: 'Minecraft', votes: 7 },
        { id: 'b', title: 'Tetris', votes: 0 },
      ],
      status: 'active',
      endsAt: '2026-09-23T12:02:00Z',
    });
  });

  test('Ende mit Status', () => {
    const { ends_at, ...ended } = poll;
    const event = normalize('poll', 'channel.poll.end', { ...ended, status: 'terminated' });
    assert.equal(event.status, 'terminated');
    assert.equal(event.endsAt, null);
  });
});

describe('normalizeEvent: Hype Train (v2)', () => {
  const contribution = (id: string | null, total: number, type = 'bits') => ({ user_id: id, user_login: id ? `user${id}` : null, user_name: id ? `User${id}` : null, type, total });
  const begin = {
    id: 'ht-1',
    total: 700,
    progress: 700,
    goal: 1800,
    level: 1,
    all_time_high_level: 4,
    all_time_high_total: 9000,
    top_contributions: [contribution('1', 500), contribution('2', 200, 'subscription')],
    shared_train_participants: null,
    type: 'golden_kappa',
    is_shared_train: false,
    started_at: '2026-09-23T12:00:00Z',
    expires_at: '2026-09-23T12:05:00Z',
  };

  test('Start', () => {
    assert.deepEqual(normalize('hypetrain', 'channel.hype_train.begin', begin), {
      type: 'hypetrain',
      phase: 'begin',
      level: 1,
      total: 700,
      progress: 700,
      goal: 1800,
      topContributions: [
        { user: { id: '1', login: 'user1', name: 'User1' }, type: 'bits', total: 500 },
        { user: { id: '2', login: 'user2', name: 'User2' }, type: 'subscription', total: 200 },
      ],
      expiresAt: '2026-09-23T12:05:00Z',
      trainType: 'golden_kappa',
    });
  });

  test('Fortschritt', () => {
    const event = normalize('hypetrain', 'channel.hype_train.progress', { ...begin, level: 3, type: 'treasure' });
    assert.equal(event.phase, 'progress');
    assert.equal(event.level, 3);
    assert.equal(event.trainType, 'treasure');
  });

  test('Ende: kein Ablauf-Zeitpunkt mehr', () => {
    const { expires_at, progress, goal, ...rest } = begin;
    const event = normalize('hypetrain', 'channel.hype_train.end', { ...rest, level: 5, ended_at: '2026-09-23T12:20:00Z', cooldown_ends_at: '2026-09-23T13:20:00Z' });
    assert.equal(event.phase, 'end');
    assert.equal(event.level, 5);
    assert.equal(event.expiresAt, null);
    assert.equal(event.progress, 0);
    assert.equal(event.goal, 0);
  });

  test('alte Version (v1): Golden Kappa über is_golden_kappa_train', () => {
    const { type, ...v1 } = begin;
    assert.equal(normalize('hypetrain', 'channel.hype_train.begin', { ...v1, is_golden_kappa_train: true }).trainType, 'golden_kappa');
    assert.equal(normalize('hypetrain', 'channel.hype_train.begin', v1).trainType, 'regular');
  });

  test('anonymer Beitrag und fehlende Werte', () => {
    const event = normalize('hypetrain', 'channel.hype_train.progress', { top_contributions: [contribution(null, 100)] });
    assert.deepEqual(event.topContributions, [{ user: { id: '', login: '', name: 'Anonym' }, type: 'bits', total: 100 }]);
    assert.equal(event.level, 1);
    assert.equal(event.total, 0);
    assert.equal(event.expiresAt, null);
  });
});

describe('normalizeEvent: Vorhersage', () => {
  const prediction = {
    id: 'pred-1',
    title: 'Schaffe ich den Boss?',
    outcomes: [
      { id: 'o1', title: 'Ja', color: 'blue' },
      { id: 'o2', title: 'Nein', color: 'pink' },
    ],
    started_at: '2026-09-23T12:00:00Z',
    locks_at: '2026-09-23T12:02:00Z',
  };

  test('Start: noch keine Tipps', () => {
    assert.deepEqual(normalize('prediction', 'channel.prediction.begin', prediction), {
      type: 'prediction',
      phase: 'begin',
      predictionId: 'pred-1',
      title: 'Schaffe ich den Boss?',
      outcomes: [
        { id: 'o1', title: 'Ja', color: 'blue', users: 0, channelPoints: 0 },
        { id: 'o2', title: 'Nein', color: 'pink', users: 0, channelPoints: 0 },
      ],
      status: 'active',
      winningOutcomeId: null,
      locksAt: '2026-09-23T12:02:00Z',
    });
  });

  test('alle Phasen', () => {
    for (const phase of ['begin', 'progress', 'lock', 'end'] as const) {
      assert.equal(normalize('prediction', `channel.prediction.${phase}`, prediction).phase, phase);
    }
  });

  test('Fortschritt mit Tipps', () => {
    const outcomes = [{ ...prediction.outcomes[0], users: 3, channel_points: 1500, top_predictors: [] }, prediction.outcomes[1]];
    const event = normalize('prediction', 'channel.prediction.progress', { ...prediction, outcomes });
    assert.deepEqual(event.outcomes[0], { id: 'o1', title: 'Ja', color: 'blue', users: 3, channelPoints: 1500 });
  });

  test('Ende mit Gewinner oder abgebrochen', () => {
    const { locks_at, ...ended } = prediction;
    const resolved = normalize('prediction', 'channel.prediction.end', { ...ended, status: 'resolved', winning_outcome_id: 'o2' });
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.winningOutcomeId, 'o2');
    assert.equal(resolved.locksAt, null);
    const canceled = normalize('prediction', 'channel.prediction.end', { ...ended, status: 'canceled', winning_outcome_id: null });
    assert.equal(canceled.status, 'canceled');
    assert.equal(canceled.winningOutcomeId, null);
  });
});

describe('normalizeEvent: Werbung, Shoutout, Kanal', () => {
  test('Werbepause', () => {
    assert.deepEqual(
      normalize('adbreak', 'channel.ad_break.begin', { duration_seconds: 90, started_at: '2026-09-23T12:00:00Z', is_automatic: true, requester_user_id: '1' }),
      { type: 'adbreak', durationSeconds: 90, automatic: true, startedAt: '2026-09-23T12:00:00Z' },
    );
    const manual = normalize('adbreak', 'channel.ad_break.begin', { duration_seconds: 30, is_automatic: false });
    assert.equal(manual.automatic, false);
    assert.ok(!Number.isNaN(Date.parse(manual.startedAt)), 'Startzeit fehlt → jetzt');
  });

  test('Shoutout', () => {
    assert.deepEqual(
      normalize('shoutout', 'channel.shoutout.create', {
        to_broadcaster_user_id: '77',
        to_broadcaster_user_login: 'freundin',
        to_broadcaster_user_name: 'Freundin',
        moderator_user_id: '1',
        viewer_count: 123,
        started_at: '2026-09-23T12:00:00Z',
      }),
      { type: 'shoutout', to: { id: '77', login: 'freundin', name: 'Freundin' }, viewers: 123 },
    );
    assert.equal(normalize('shoutout', 'channel.shoutout.create', { to_broadcaster_user_id: '77' }).viewers, 0);
  });

  test('Kanal-Update und Chat-Löschungen', () => {
    assert.deepEqual(normalize('channelupdate', 'channel.update', { title: 'Neu', category_id: '27471', category_name: 'Minecraft' }), {
      type: 'channelupdate',
      title: 'Neu',
      categoryId: '27471',
      categoryName: 'Minecraft',
    });
    assert.deepEqual(normalize('chatclear', 'channel.chat.clear', {}), { type: 'chatclear', userId: null });
    assert.deepEqual(normalize('chatclear', 'channel.chat.clear_user_messages', { target_user_id: '9' }), { type: 'chatclear', userId: '9' });
  });

  test('Chat-Nachricht: Abzeichen, Emotes, Antwort', () => {
    const event = normalize('chat', 'channel.chat.message', {
      message_id: 'm1',
      chatter_user_id: '5',
      chatter_user_login: 'chatter',
      chatter_user_name: 'Chatter',
      color: '',
      badges: [{ set_id: 'subscriber', id: '12', info: '14' }],
      message: {
        text: 'Hi Kappa @Mini',
        fragments: [
          { type: 'text', text: 'Hi ' },
          { type: 'emote', text: 'Kappa', emote: { id: '25' } },
          { type: 'mention', text: '@Mini', mention: { user_id: '1' } },
          { type: 'etwas_neues', text: '?' },
        ],
      },
      message_type: 'text',
      reply: { parent_user_name: 'Mini' },
      channel_points_custom_reward_id: null,
    });
    assert.deepEqual(event.badges, ['subscriber']);
    assert.deepEqual(event.badgeInfo, [{ set: 'subscriber', id: '12' }]);
    assert.deepEqual(event.fragments, [
      { type: 'text', text: 'Hi ' },
      { type: 'emote', text: 'Kappa', emoteId: '25' },
      { type: 'mention', text: '@Mini' },
      { type: 'text', text: '?' },
    ]);
    assert.equal(event.replyTo, 'Mini');
    assert.equal(event.rewardId, null);
  });

  test('unbekannter Abo-Typ → null', () => {
    assert.equal(normalizeEvent('channel.gibts.nicht', {}), null);
  });
});

describe('makeTestEvent', () => {
  test('EVENT_TYPES ohne Doppelte', () => {
    assert.equal(new Set(EVENT_TYPES).size, EVENT_TYPES.length);
  });

  test('liefert für jede Event-Art ein gültiges Test-Event', () => {
    for (const type of EVENT_TYPES) {
      const event: StreamEvent = makeTestEvent(type);
      assert.ok(event, `${type}: kein Event`);
      assert.equal(event.type, type);
      assert.equal(event.test, true, `${type}: test fehlt`);
      assert.deepEqual(undefinedPaths(event), [], `${type}: Felder mit undefined`);
      // Muss unverändert durch JSON (WebSocket zum Overlay) passen
      assert.deepEqual(JSON.parse(JSON.stringify(event)), event, `${type}: nicht JSON-fest`);
    }
  });

  test('Test-Einlösung mit echter Belohnung', () => {
    const event = makeTestEvent('redemption', { id: 'rw-9', title: 'Tanz!', cost: 250 }) as EventOfType<'redemption'>;
    assert.deepEqual(event.reward, { id: 'rw-9', title: 'Tanz!', cost: 250 });
    const fallback = makeTestEvent('redemption', { cost: Number.NaN }) as EventOfType<'redemption'>;
    assert.equal(fallback.reward.cost, 100);
    assert.equal((makeTestEvent('redemptionupdate', { id: 'rw-9' }) as EventOfType<'redemptionupdate'>).rewardId, 'rw-9');
  });
});
