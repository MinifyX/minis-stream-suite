/**
 * Einheitliche Event-Typen der Suite. EventSub liefert je Event-Art ein
 * anderes Format – hier wird alles in eine einfache, gleiche Form gebracht,
 * damit Addons sich nicht um Twitch-Details kümmern müssen.
 */

export interface TwitchUserRef {
  id: string;
  login: string;
  name: string;
}

export interface ChatFragment {
  type: 'text' | 'emote' | 'cheermote' | 'mention';
  text: string;
  /** Twitch-Emote-ID (nur bei type "emote") */
  emoteId?: string;
}

/** Wer bei einem Hype Train am meisten beigetragen hat */
export interface HypeContribution {
  user: TwitchUserRef;
  /** bits, subscription oder other */
  type: string;
  total: number;
}

/** Eine Antwort einer Vorhersage */
export interface PredictionOutcome {
  id: string;
  title: string;
  /** blue oder pink */
  color: string;
  users: number;
  channelPoints: number;
}

export interface RewardRef {
  id: string;
  title: string;
  cost: number;
}

type EventData =
  | {
    type: 'redemption';
    redemptionId: string;
    user: TwitchUserRef;
    reward: RewardRef;
    input: string;
    /** "unfulfilled" = wartet in der Warteschlange, "fulfilled" = Belohnung überspringt die Warteschlange */
    status: string;
  }
  /** Einlösung wurde erledigt oder zurückerstattet (von der Suite, im Dashboard oder von einer anderen App) */
  | { type: 'redemptionupdate'; redemptionId: string; rewardId: string; status: 'fulfilled' | 'canceled' }
  | { type: 'follow'; user: TwitchUserRef }
  | { type: 'sub'; user: TwitchUserRef; tier: string; isGift: boolean }
  | { type: 'resub'; user: TwitchUserRef; tier: string; months: number; message: string }
  | { type: 'giftsub'; user: TwitchUserRef | null; tier: string; count: number }
  | { type: 'cheer'; user: TwitchUserRef | null; bits: number; message: string }
  | { type: 'raid'; user: TwitchUserRef; viewers: number }
  | {
    type: 'chat';
    messageId: string;
    user: TwitchUserRef;
    message: string;
    /** Abzeichen-Arten, z.B. ["broadcaster", "subscriber"] */
    badges: string[];
    /** Abzeichen mit Version (für die Bilder), z.B. { set: "subscriber", id: "12" } */
    badgeInfo: { set: string; id: string }[];
    /** Namensfarbe (#RRGGBB) oder "" */
    color: string;
    /** Nachricht in Teilen: Text, Emotes, Erwähnungen */
    fragments: ChatFragment[];
    /** Kanalpunkte-Belohnung, falls die Nachricht dazu gehört */
    rewardId: string | null;
    /** z.B. "text", "channel_points_highlighted", "user_intro" */
    messageType: string;
    /** Antwort auf: Name des ursprünglichen Schreibers */
    replyTo: string | null;
  }
  /** Mod hat eine Nachricht gelöscht */
  | { type: 'chatdelete'; messageId: string }
  /** Chat geleert (userId = null) oder alle Nachrichten eines Nutzers entfernt (Timeout/Bann) */
  | { type: 'chatclear'; userId: string | null }
  /** Titel oder Kategorie (Spiel) des Kanals wurde geändert */
  | { type: 'channelupdate'; title: string; categoryId: string; categoryName: string }
  /** Stream ist live gegangen / wurde beendet */
  | { type: 'streamonline'; startedAt: string }
  | { type: 'streamoffline' }
  /** Hype Train: gestartet, Fortschritt (auch Level-Aufstieg) oder beendet */
  | {
    type: 'hypetrain';
    phase: 'begin' | 'progress' | 'end';
    level: number;
    /** Punkte insgesamt / im aktuellen Level / nötig für das nächste Level */
    total: number;
    progress: number;
    goal: number;
    topContributions: HypeContribution[];
    /** Bis wann der Zug noch fährt (ISO), bei "end" null */
    expiresAt: string | null;
    /** z.B. regular, golden_kappa, treasure */
    trainType: string;
  }
  /** Echte Twitch-Vorhersage: gestartet, neue Tipps, gesperrt (keine Tipps mehr) oder beendet */
  | {
    type: 'prediction';
    phase: 'begin' | 'progress' | 'lock' | 'end';
    predictionId: string;
    title: string;
    outcomes: PredictionOutcome[];
    /** Bei "end": resolved (Gewinner steht fest) oder canceled (Punkte zurück) */
    status: string;
    winningOutcomeId: string | null;
    locksAt: string | null;
  }
  /** Werbepause hat begonnen */
  | { type: 'adbreak'; durationSeconds: number; automatic: boolean; startedAt: string }
  /** Du (oder ein Mod) hast jemandem einen Twitch-Shoutout gegeben */
  | { type: 'shoutout'; to: TwitchUserRef; viewers: number }
  /** Echte Twitch-Umfrage: gestartet, neue Stimmen oder beendet */
  | {
    type: 'poll';
    phase: 'begin' | 'progress' | 'end';
    pollId: string;
    title: string;
    choices: { id: string; title: string; votes: number }[];
    /** Bei "end": completed (normal), terminated (vorzeitig beendet), archived (ausgeblendet) */
    status: string;
    endsAt: string | null;
  };

/** `test: true` bei Events, die über einen Test-Button ausgelöst wurden. */
export type StreamEvent = EventData & { test?: boolean };
export type StreamEventType = StreamEvent['type'];
export type EventOfType<T extends StreamEventType> = Extract<StreamEvent, { type: T }>;

export const EVENT_TYPES: StreamEventType[] = [
  'redemption', 'redemptionupdate', 'follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'chat', 'channelupdate', 'streamonline', 'streamoffline',
  'chatdelete', 'chatclear', 'poll', 'hypetrain', 'prediction', 'adbreak', 'shoutout',
];

function userRef(id?: string | null, login?: string | null, name?: string | null): TwitchUserRef | null {
  if (!id) return null;
  return { id, login: login ?? '', name: name ?? login ?? '' };
}

/** Wandelt ein rohes EventSub-Event in ein StreamEvent um (oder null, wenn unbekannt). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function normalizeEvent(subscriptionType: string, e: any): StreamEvent | null {
  switch (subscriptionType) {
    case 'channel.channel_points_custom_reward_redemption.add':
      return {
        type: 'redemption',
        redemptionId: e.id,
        user: userRef(e.user_id, e.user_login, e.user_name)!,
        reward: { id: e.reward.id, title: e.reward.title, cost: e.reward.cost },
        input: e.user_input ?? '',
        status: e.status ?? 'unfulfilled',
      };
    case 'channel.channel_points_custom_reward_redemption.update':
      return {
        type: 'redemptionupdate',
        redemptionId: e.id,
        rewardId: e.reward?.id ?? '',
        status: e.status === 'canceled' ? 'canceled' : 'fulfilled',
      };
    case 'channel.follow':
      return { type: 'follow', user: userRef(e.user_id, e.user_login, e.user_name)! };
    case 'channel.subscribe':
      return { type: 'sub', user: userRef(e.user_id, e.user_login, e.user_name)!, tier: e.tier, isGift: !!e.is_gift };
    case 'channel.subscription.message':
      return {
        type: 'resub',
        user: userRef(e.user_id, e.user_login, e.user_name)!,
        tier: e.tier,
        months: e.cumulative_months ?? 0,
        message: e.message?.text ?? '',
      };
    case 'channel.subscription.gift':
      return {
        type: 'giftsub',
        user: e.is_anonymous ? null : userRef(e.user_id, e.user_login, e.user_name),
        tier: e.tier,
        count: e.total ?? 1,
      };
    case 'channel.cheer':
      return {
        type: 'cheer',
        user: e.is_anonymous ? null : userRef(e.user_id, e.user_login, e.user_name),
        bits: e.bits,
        message: e.message ?? '',
      };
    case 'channel.raid':
      return {
        type: 'raid',
        user: userRef(e.from_broadcaster_user_id, e.from_broadcaster_user_login, e.from_broadcaster_user_name)!,
        viewers: e.viewers,
      };
    case 'channel.chat.message':
      return {
        type: 'chat',
        messageId: e.message_id,
        user: userRef(e.chatter_user_id, e.chatter_user_login, e.chatter_user_name)!,
        message: e.message?.text ?? '',
        badges: (e.badges ?? []).map((b: { set_id: string }) => b.set_id),
        badgeInfo: (e.badges ?? []).map((b: { set_id: string; id: string }) => ({ set: b.set_id, id: b.id })),
        color: typeof e.color === 'string' ? e.color : '',
        fragments: (e.message?.fragments ?? []).map((f: { type: string; text: string; emote?: { id: string } }) => ({
          type: (['emote', 'cheermote', 'mention'].includes(f.type) ? f.type : 'text') as ChatFragment['type'],
          text: f.text ?? '',
          ...(f.type === 'emote' && f.emote?.id ? { emoteId: f.emote.id } : {}),
        })),
        rewardId: e.channel_points_custom_reward_id ?? null,
        messageType: e.message_type ?? 'text',
        replyTo: e.reply?.parent_user_name ?? null,
      };
    case 'channel.chat.message_delete':
      return { type: 'chatdelete', messageId: e.message_id };
    case 'channel.chat.clear':
      return { type: 'chatclear', userId: null };
    case 'channel.chat.clear_user_messages':
      return { type: 'chatclear', userId: e.target_user_id ?? null };
    case 'channel.update':
      return { type: 'channelupdate', title: e.title ?? '', categoryId: e.category_id ?? '', categoryName: e.category_name ?? '' };
    case 'stream.online':
      return { type: 'streamonline', startedAt: e.started_at ?? new Date().toISOString() };
    case 'stream.offline':
      return { type: 'streamoffline' };
    case 'channel.poll.begin':
    case 'channel.poll.progress':
    case 'channel.poll.end':
      return {
        type: 'poll',
        phase: subscriptionType === 'channel.poll.begin' ? 'begin' : subscriptionType === 'channel.poll.end' ? 'end' : 'progress',
        pollId: e.id,
        title: e.title ?? '',
        choices: (e.choices ?? []).map((c: { id: string; title: string; votes?: number }) => ({ id: c.id, title: c.title, votes: c.votes ?? 0 })),
        status: e.status ?? 'active',
        endsAt: e.ends_at ?? null,
      };
    case 'channel.hype_train.begin':
    case 'channel.hype_train.progress':
    case 'channel.hype_train.end':
      return {
        type: 'hypetrain',
        phase: subscriptionType.endsWith('begin') ? 'begin' : subscriptionType.endsWith('end') ? 'end' : 'progress',
        level: e.level ?? 1,
        total: e.total ?? 0,
        progress: e.progress ?? 0,
        goal: e.goal ?? 0,
        topContributions: (e.top_contributions ?? []).map((c: { user_id: string; user_login: string; user_name: string; type: string; total: number }) => ({
          user: userRef(c.user_id, c.user_login, c.user_name) ?? { id: '', login: '', name: 'Anonym' },
          type: c.type ?? 'other',
          total: c.total ?? 0,
        })),
        expiresAt: subscriptionType.endsWith('end') ? null : e.expires_at ?? null,
        trainType: e.type ?? (e.is_golden_kappa_train ? 'golden_kappa' : 'regular'),
      };
    case 'channel.prediction.begin':
    case 'channel.prediction.progress':
    case 'channel.prediction.lock':
    case 'channel.prediction.end':
      return {
        type: 'prediction',
        phase: subscriptionType.slice('channel.prediction.'.length) as 'begin' | 'progress' | 'lock' | 'end',
        predictionId: e.id,
        title: e.title ?? '',
        outcomes: (e.outcomes ?? []).map((o: { id: string; title: string; color: string; users?: number; channel_points?: number }) => ({
          id: o.id,
          title: o.title,
          color: o.color ?? 'blue',
          users: o.users ?? 0,
          channelPoints: o.channel_points ?? 0,
        })),
        status: e.status ?? 'active',
        winningOutcomeId: e.winning_outcome_id ?? null,
        locksAt: e.locks_at ?? null,
      };
    case 'channel.ad_break.begin':
      return {
        type: 'adbreak',
        durationSeconds: e.duration_seconds ?? 0,
        automatic: !!e.is_automatic,
        startedAt: e.started_at ?? new Date().toISOString(),
      };
    case 'channel.shoutout.create':
      return {
        type: 'shoutout',
        to: userRef(e.to_broadcaster_user_id, e.to_broadcaster_user_login, e.to_broadcaster_user_name)!,
        viewers: e.viewer_count ?? 0,
      };
    default:
      return null;
  }
}

const TEST_USER: TwitchUserRef = { id: '0', login: 'testuser', name: 'TestUser' };

/** Erzeugt ein Fake-Event zum Testen. Optional mit einer echten Belohnung. */
export function makeTestEvent(type: StreamEventType, reward?: Partial<RewardRef>): StreamEvent {
  const base = { test: true as const };
  switch (type) {
    case 'redemption':
      return {
        ...base,
        type,
        redemptionId: 'test',
        user: TEST_USER,
        reward: {
          id: String(reward?.id ?? 'test-reward'),
          title: String(reward?.title ?? 'Test-Belohnung'),
          cost: Number(reward?.cost) || 100,
        },
        input: '',
        status: 'unfulfilled',
      };
    case 'redemptionupdate':
      return { ...base, type, redemptionId: 'test', rewardId: String(reward?.id ?? 'test-reward'), status: 'fulfilled' };
    case 'follow':
      return { ...base, type, user: TEST_USER };
    case 'sub':
      return { ...base, type, user: TEST_USER, tier: '1000', isGift: false };
    case 'resub':
      return { ...base, type, user: TEST_USER, tier: '1000', months: 12, message: 'Schon ein Jahr dabei!' };
    case 'giftsub':
      return { ...base, type, user: TEST_USER, tier: '1000', count: 5 };
    case 'cheer':
      return { ...base, type, user: TEST_USER, bits: 500, message: 'Cheer500 GG!' };
    case 'raid':
      return { ...base, type, user: TEST_USER, viewers: 42 };
    case 'chat': {
      const message = 'Hallo **Chat**, das ist [regenbogen]ein Test[/] mit *Markdown* HeyGuys';
      return {
        ...base,
        type,
        messageId: `test-${Date.now()}`,
        user: TEST_USER,
        message,
        badges: ['subscriber'],
        badgeInfo: [{ set: 'subscriber', id: '0' }],
        color: '#1E90FF',
        fragments: [
          { type: 'text', text: 'Hallo **Chat**, das ist [regenbogen]ein Test[/] mit *Markdown* ' },
          { type: 'emote', text: 'HeyGuys', emoteId: '30259' },
        ],
        rewardId: null,
        messageType: 'text',
        replyTo: null,
      };
    }
    case 'chatdelete':
      return { ...base, type, messageId: 'test' };
    case 'chatclear':
      return { ...base, type, userId: null };
    case 'channelupdate':
      return { ...base, type, title: 'Test-Stream', categoryId: '27471', categoryName: 'Minecraft' };
    case 'streamonline':
      return { ...base, type, startedAt: new Date().toISOString() };
    case 'streamoffline':
      return { ...base, type };
    case 'hypetrain':
      return {
        ...base,
        type,
        phase: 'progress',
        level: 2,
        total: 1800,
        progress: 300,
        goal: 1600,
        topContributions: [{ user: TEST_USER, type: 'bits', total: 1000 }],
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        trainType: 'regular',
      };
    case 'prediction':
      return {
        ...base,
        type,
        phase: 'progress',
        predictionId: 'test',
        title: 'Schaffe ich den Boss beim ersten Versuch?',
        outcomes: [
          { id: 'a', title: 'Ja', color: 'blue', users: 12, channelPoints: 4200 },
          { id: 'b', title: 'Niemals', color: 'pink', users: 20, channelPoints: 9100 },
        ],
        status: 'active',
        winningOutcomeId: null,
        locksAt: new Date(Date.now() + 2 * 60_000).toISOString(),
      };
    case 'adbreak':
      return { ...base, type, durationSeconds: 90, automatic: true, startedAt: new Date().toISOString() };
    case 'shoutout':
      return { ...base, type, to: TEST_USER, viewers: 42 };
    case 'poll':
      return {
        ...base,
        type,
        phase: 'progress',
        pollId: 'test',
        title: 'Test-Umfrage',
        choices: [{ id: 'a', title: 'Ja', votes: 3 }, { id: 'b', title: 'Nein', votes: 1 }],
        status: 'active',
        endsAt: null,
      };
  }
}
