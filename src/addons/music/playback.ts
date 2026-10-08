import type { ProviderId } from './model';
import type { SongRequest } from './requests';
import type { QueueItem } from './sets';

/**
 * Wiedergabe-Queue der Suite: Songwünsche und eigene Titellisten (Musik-Sets vom Typ „custom“).
 *
 * Warum eine eigene Queue? Aus Spotifys Warteschlange kann man nichts wieder entfernen. Deshalb
 * behält die Suite Wünsche bei sich (umsortieren, löschen, freigeben geht jederzeit) und übergibt
 * den nächsten Titel erst kurz vor dem Ende des laufenden Titels:
 *  - gleicher Provider: einreihen (Spotify: /me/player/queue, lokal: „als Nächstes“ im Host, mit Crossfade)
 *  - anderer Provider (gemischte eigene Liste): am Ende umschalten und dort starten
 *
 * Zwei Betriebsarten:
 *  - Kontext: Ein Provider spielt selbst eine Playlist/einen Ordner. Wünsche werden dazwischengeschoben,
 *    danach spielt der Provider seine Playlist weiter.
 *  - Liste: Eine eigene Titelliste der Suite läuft Titel für Titel; Wünsche kommen vor dem nächsten Listentitel.
 */

export interface PlaybackState {
  trackId: string;
  positionMs: number;
  durationMs: number;
  isPlaying: boolean;
  provider: ProviderId;
  /** Zeitpunkt der Meldung (ms) */
  at: number;
}

export interface Entry {
  item: QueueItem;
  /** Songwunsch – oder null für einen Titel aus der eigenen Liste */
  request: SongRequest | null;
  /** Position in der Reihenfolge der Liste (nur Listentitel) */
  listPos?: number;
}

export interface PlaybackDeps {
  now(): number;
  state(): PlaybackState | null;
  /** So früh vor dem Titelende wird der nächste Titel übergeben */
  prequeueMs(): number;
  /** Unter dieser ID meldet der Provider den Titel als „läuft gerade“ */
  trackId(item: QueueItem): string;
  /** Titel sofort starten (wechselt bei Bedarf den Provider) */
  playNow(item: QueueItem): Promise<void>;
  /** Titel beim gerade spielenden Provider als nächsten einreihen; false = geht nicht (anderer Provider) */
  enqueueNext(item: QueueItem): Promise<boolean>;
  /** Ein Titel aus der Queue hat angefangen */
  started(entry: Entry): void;
  changed(): void;
  error(message: string): void;
}

interface ListState {
  name: string;
  items: QueueItem[];
  order: number[];
  /** Position des laufenden Titels in `order` */
  pos: number;
  shuffle: boolean;
  repeat: boolean;
}

interface Committed {
  entry: Entry;
  trackId: string;
  /** enqueued = beim Provider eingereiht; handoff = wird am Titelende auf dem anderen Provider gestartet */
  mode: 'enqueued' | 'handoff';
  handoffAt: number;
}

function shuffled(n: number): number[] {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export class PlaybackQueue {
  /** Freigegebene Wünsche in Reihenfolge */
  requests: Entry[] = [];
  list: ListState | null = null;
  committed: Committed | null = null;
  /** Läuft gerade ein Titel aus der Queue? (Wunsch oder Listentitel) */
  current: Entry | null = null;
  private lastTrackId = '';
  private busy = false;

  constructor(private deps: PlaybackDeps) {}

  // -------------------------------------------------------------- Liste (eigenes Set)

  /** Eigene Titelliste starten (ersetzt eine laufende Liste, Wünsche bleiben) */
  async startList(name: string, items: QueueItem[], options: { shuffle: boolean; repeat: boolean }): Promise<void> {
    if (!items.length) throw new Error(`Das Set „${name}“ hat keine Titel.`);
    const order = options.shuffle ? shuffled(items.length) : [...items.keys()];
    this.list = { name, items, order, pos: 0, shuffle: options.shuffle, repeat: options.repeat };
    this.dropCommittedListEntry();
    // Ein offener Wunsch kommt zuerst
    const first: Entry = this.requests.length ? this.requests.shift()! : { item: items[order[0]], request: null, listPos: 0 };
    await this.playEntry(first);
  }

  /** Provider spielt wieder selbst (verknüpftes Set, Playlist) – Wünsche bleiben */
  clearList(): void {
    this.list = null;
    this.dropCommittedListEntry();
    if (this.current && !this.current.request) this.current = null;
    this.deps.changed();
  }

  private dropCommittedListEntry(): void {
    // Ein schon übergebener Listentitel bleibt beim Provider – wir vergessen ihn nur nicht als Wunsch
    if (this.committed && !this.committed.entry.request && this.committed.mode === 'handoff') this.committed = null;
  }

  /** Nächster Listentitel (mit Wiederholen) – oder null */
  private nextListEntry(): Entry | null {
    const list = this.list;
    if (!list) return null;
    let pos = list.pos + 1;
    if (pos >= list.order.length) {
      if (!list.repeat) return null;
      pos = 0;
    }
    return { item: list.items[list.order[pos]], request: null, listPos: pos };
  }

  /** Was kommt als Nächstes? Wünsche vor der Liste. */
  peekNext(): Entry | null {
    return this.requests[0] ?? this.nextListEntry();
  }

  // -------------------------------------------------------------- Wünsche

  addRequest(request: SongRequest, front = false): number {
    const entry: Entry = { item: request.item, request };
    if (front) this.requests.unshift(entry);
    else this.requests.push(entry);
    this.deps.changed();
    return this.position(request.id);
  }

  /** Platz in der Queue (1 = als Nächstes), 0 = nicht drin */
  position(requestId: string): number {
    const offset = this.committed?.entry.request ? 1 : 0;
    if (this.committed?.entry.request?.id === requestId) return 1;
    const index = this.requests.findIndex((e) => e.request?.id === requestId);
    return index < 0 ? 0 : index + 1 + offset;
  }

  /** Wunsch entfernen. Gibt false zurück, wenn er schon an den Provider übergeben ist. */
  removeRequest(requestId: string): boolean {
    if (this.committed?.entry.request?.id === requestId && this.committed.mode === 'enqueued') return false;
    if (this.committed?.entry.request?.id === requestId) this.committed = null;
    const before = this.requests.length;
    this.requests = this.requests.filter((e) => e.request?.id !== requestId);
    if (this.requests.length !== before) this.deps.changed();
    return true;
  }

  moveRequest(requestId: string, delta: number): void {
    const index = this.requests.findIndex((e) => e.request?.id === requestId);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= this.requests.length) return;
    const [entry] = this.requests.splice(index, 1);
    this.requests.splice(target, 0, entry);
    this.deps.changed();
  }

  // -------------------------------------------------------------- Ablauf

  private async playEntry(entry: Entry): Promise<void> {
    this.committed = null;
    await this.deps.playNow(entry.item);
    this.begin(entry);
  }

  private begin(entry: Entry): void {
    this.current = entry;
    this.committed = null;
    this.lastTrackId = this.deps.trackId(entry.item);
    if (!entry.request && this.list && entry.listPos !== undefined) this.list.pos = entry.listPos;
    this.deps.started(entry);
    this.deps.changed();
  }

  /** Übergabe vorbereiten: Eintrag aus der Queue nehmen und beim Provider einreihen (oder Umschalten planen) */
  private async commit(entry: Entry, remainingMs: number): Promise<void> {
    if (entry.request) this.requests = this.requests.filter((e) => e !== entry);
    const trackId = this.deps.trackId(entry.item);
    let ok = false;
    try {
      ok = await this.deps.enqueueNext(entry.item);
    } catch (err) {
      // Einreihen ging schief → am Titelende direkt starten
      this.deps.error(`Einreihen fehlgeschlagen, starte am Titelende direkt: ${(err as Error).message}`);
    }
    this.committed = { entry, trackId, mode: ok ? 'enqueued' : 'handoff', handoffAt: this.deps.now() + Math.max(0, remainingMs - 150) };
    this.deps.changed();
  }

  /** Regelmäßig aufrufen (z.B. alle 500 ms) und bei jeder neuen Meldung des Providers */
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.step();
    } finally {
      this.busy = false;
    }
  }

  private async step(): Promise<void> {
    const s = this.deps.state();
    const now = this.deps.now();
    if (!s) return;

    // Titelwechsel erkennen
    if (s.trackId && s.trackId !== this.lastTrackId) {
      this.lastTrackId = s.trackId;
      if (this.committed && this.committed.trackId === s.trackId) {
        this.begin(this.committed.entry);
        return;
      }
      if (this.current && this.deps.trackId(this.current.item) !== s.trackId) {
        this.current = null;
        this.deps.changed();
      }
    }

    const remaining = s.durationMs > 0 ? s.durationMs - (s.positionMs + (s.isPlaying ? now - s.at : 0)) : Infinity;

    // Umschalten auf den anderen Provider, wenn der Titel zu Ende ist
    if (this.committed?.mode === 'handoff' && (now >= this.committed.handoffAt || remaining <= 150)) {
      const entry = this.committed.entry;
      try {
        await this.playEntry(entry);
      } catch (err) {
        this.committed = null;
        this.deps.error(`„${entry.item.title}“ konnte nicht starten: ${(err as Error).message}`);
      }
      return;
    }

    // Liste: Titel ist zu Ende, aber nichts wurde übergeben (z.B. Länge unbekannt) → nächsten starten
    if (this.list && !this.committed && !s.isPlaying && this.current && s.trackId === this.deps.trackId(this.current.item)
      && s.durationMs > 0 && s.positionMs >= s.durationMs - 1500) {
      const next = this.peekNext();
      if (next) {
        if (next.request) this.requests.shift();
        await this.playEntry(next).catch((err) => this.deps.error(`„${next.item.title}“ konnte nicht starten: ${(err as Error).message}`));
      }
      return;
    }

    // Kurz vor Titelende: nächsten Titel übergeben
    if (!this.committed && s.isPlaying && remaining <= this.deps.prequeueMs()) {
      const next = this.peekNext();
      if (next) await this.commit(next, remaining);
    }
  }

  /**
   * „Weiter“: Ist der nächste Titel schon beim Provider eingereiht, macht der Provider einfach weiter
   * (Rückgabe 'provider'). Sonst startet die Queue den nächsten Titel selbst ('queue') –
   * oder es gibt nichts in der Queue ('none').
   */
  async skip(): Promise<'provider' | 'queue' | 'none'> {
    if (this.committed?.mode === 'enqueued') return 'provider';
    const next = this.committed?.entry ?? this.peekNext();
    if (!next) return 'none';
    if (!this.committed && next.request) this.requests.shift();
    await this.playEntry(next);
    return 'queue';
  }

  /** Für die Oberfläche: was kommt als Nächstes (übergebener Titel zuerst) */
  upcoming(): Entry[] {
    return [...(this.committed ? [this.committed.entry] : []), ...this.requests];
  }
}
