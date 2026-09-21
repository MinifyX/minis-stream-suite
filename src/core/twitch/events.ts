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

export interface RewardRef {
  id: string;
  title: string;
  cost: number;
}

type EventData =
  | { type: 'redemption'; redemptionId: string; user: TwitchUserRef; reward: RewardRef; input: string }
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
  | { type: 'streamoffline' };

/** `test: true` bei Events, die über einen Test-Button ausgelöst wurden. */
export type StreamEvent = EventData & { test?: boolean };
export type StreamEventType = StreamEvent['type'];
export type EventOfType<T extends StreamEventType> = Extract<StreamEvent, { type: T }>;

export const EVENT_TYPES: StreamEventType[] = [
  'redemption', 'follow', 'sub', 'resub', 'giftsub', 'cheer', 'raid', 'chat', 'channelupdate', 'streamonline', 'streamoffline',
  'chatdelete', 'chatclear',
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
      };
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
  }
}
