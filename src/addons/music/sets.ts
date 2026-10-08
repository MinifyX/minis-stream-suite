import { randomUUID } from 'node:crypto';
import { HttpError } from '../../core/server';
import { parseSpotifySource } from './spotify';

/**
 * Musik-Sets: benannte Musikquellen, die zu bestimmten Spielen (Twitch-Kategorien) laufen.
 *
 *  - verknüpft („linked“): zeigt auf eine Spotify-Playlist/-Album oder einen lokalen Ordner
 *    (local:<Ordner>). Die Titel pflegt man in Spotify bzw. im Ordner.
 *  - eigene Liste („custom“): Titel direkt in der Suite zusammengestellt, Spotify und lokal gemischt.
 *
 * Ohne Electron/Twitch, damit man es testen kann.
 */

export interface Game {
  id: string;
  name: string;
}

/** Ein abspielbarer Titel – aus einer eigenen Liste oder einem Songwunsch */
export interface QueueItem {
  kind: 'spotify' | 'local';
  /** spotify:track:… bzw. Pfad relativ zum Musik-Ordner */
  ref: string;
  title: string;
  artists: string[];
  durationMs: number;
  image: string | null;
}

export interface MusicSet {
  id: string;
  name: string;
  type: 'linked' | 'custom';
  /** linked: Spotify-URI oder local:<Ordner> */
  source: string;
  /** custom: die Titel */
  tracks: QueueItem[];
  /** Läuft automatisch, wenn eine dieser Kategorien gestreamt wird */
  games: Game[];
}

export interface SetSettings {
  sets: MusicSet[];
  /** Läuft bei Spielen ohne eigenes Set ("" = dann nichts ändern) */
  defaultSetId: string;
  /** Beim Kategoriewechsel automatisch umschalten (nur wenn gerade Musik läuft) */
  switchOnGameChange: boolean;
}

export const SET_DEFAULTS: SetSettings = { sets: [], defaultSetId: '', switchOnGameChange: true };

export const MAX_SETS = 50;
export const MAX_SET_TRACKS = 500;

const str = (value: unknown, max = 200) => String(value ?? '').trim().slice(0, max);

/** Spotify-Track-ID aus einer URI („spotify:track:abc“ → „abc“) */
export function spotifyTrackId(uri: string): string | null {
  return /^spotify:track:([A-Za-z0-9]+)$/.exec(uri)?.[1] ?? null;
}

/** ID, unter der ein Provider den Titel als „läuft gerade“ meldet (zum Wiedererkennen) */
export function itemTrackId(item: QueueItem, localId: (file: string) => string): string {
  return item.kind === 'spotify' ? (spotifyTrackId(item.ref) ?? item.ref) : localId(item.ref);
}

export function cleanItem(input: unknown): QueueItem {
  const t = (input ?? {}) as Record<string, unknown>;
  const kind = t.kind === 'local' ? 'local' : 'spotify';
  const ref = str(t.ref, 500);
  if (kind === 'spotify' && !spotifyTrackId(ref)) throw new HttpError(400, `„${ref}“ ist kein Spotify-Titel.`);
  if (kind === 'local' && (!ref || ref.startsWith('/') || /^[a-z]:/i.test(ref) || ref.split('/').includes('..'))) {
    throw new HttpError(400, 'Ungültiger Pfad für einen lokalen Titel.');
  }
  return {
    kind,
    ref,
    title: str(t.title) || ref,
    artists: (Array.isArray(t.artists) ? t.artists : []).map((a) => str(a, 100)).filter(Boolean).slice(0, 10),
    durationMs: Math.max(0, Math.round(Number(t.durationMs) || 0)),
    image: typeof t.image === 'string' && /^(https:\/\/|\/addon-data\/)/.test(t.image) ? t.image.slice(0, 500) : null,
  };
}

function cleanGames(input: unknown): Game[] {
  return (Array.isArray(input) ? input : [])
    .filter((g: Partial<Game>) => typeof g?.id === 'string' && g.id && typeof g.name === 'string')
    .map((g: Game) => ({ id: g.id.slice(0, 40), name: g.name.slice(0, 100) }))
    .slice(0, 100);
}

/** Set aus der Oberfläche prüfen */
export function cleanSet(input: unknown): MusicSet {
  const s = (input ?? {}) as Record<string, unknown>;
  const name = str(s.name, 60);
  if (!name) throw new HttpError(400, 'Bitte gib dem Set einen Namen.');
  const type = s.type === 'custom' ? 'custom' : 'linked';
  let source = '';
  let tracks: QueueItem[] = [];
  if (type === 'linked') {
    const raw = str(s.source, 500);
    if (raw.startsWith('local:')) source = raw;
    else {
      source = parseSpotifySource(raw) ?? '';
      if (!source || /^spotify:(track|episode):/.test(source)) {
        throw new HttpError(400, 'Bitte eine Spotify-Playlist, ein Album oder einen Musik-Ordner auswählen.');
      }
    }
  } else {
    const list = Array.isArray(s.tracks) ? s.tracks : [];
    if (list.length > MAX_SET_TRACKS) throw new HttpError(400, `Höchstens ${MAX_SET_TRACKS} Titel pro Set.`);
    tracks = list.map(cleanItem);
  }
  return {
    id: typeof s.id === 'string' && s.id ? s.id.slice(0, 60) : randomUUID(),
    name,
    type,
    source,
    tracks,
    games: cleanGames(s.games),
  };
}

/**
 * Welches Set passt zum Spiel? Das erste Set, dem die Kategorie zugeordnet ist,
 * sonst das Standard-Set – oder null (= nichts ändern).
 */
export function setForGame(settings: SetSettings, game: Game | null): MusicSet | null {
  if (game) {
    const match = settings.sets.find((s) => s.games.some((g) => g.id === game.id));
    if (match) return match;
  }
  return settings.sets.find((s) => s.id === settings.defaultSetId) ?? null;
}

/** Eine Kategorie gehört höchstens zu einem Set – beim Speichern aus den anderen entfernen */
export function claimGames(sets: MusicSet[], owner: MusicSet): MusicSet[] {
  const ids = new Set(owner.games.map((g) => g.id));
  return sets.map((s) => (s.id === owner.id ? s : { ...s, games: s.games.filter((g) => !ids.has(g.id)) }));
}
