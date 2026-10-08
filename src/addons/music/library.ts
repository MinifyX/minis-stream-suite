import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { flacMetadataEnd, id3TagSize, parseFlac, parseId3, parseOgg, tagsFromFileName, type TrackTags } from './tags';

/**
 * Lokale Musik: Ein Unterordner des Musik-Ordners = eine Playlist (Dateien direkt im
 * Musik-Ordner landen in der Playlist „Hauptordner“). Metadaten aus den Tags, sonst aus dem Dateinamen.
 * Cover werden einmal als Datei in den Cover-Ordner geschrieben und von dort ausgeliefert.
 */

export const AUDIO_EXTENSIONS = ['.mp3', '.flac', '.wav', '.ogg', '.opus'];

export interface LocalTrack {
  id: string;
  /** Pfad relativ zum Musik-Ordner, mit / */
  file: string;
  title: string;
  artists: string[];
  album: string | null;
  /** Dateiname im Cover-Ordner (oder null) */
  cover: string | null;
}

export interface LocalPlaylist {
  /** Ordnername relativ zum Musik-Ordner ("" = Hauptordner) */
  id: string;
  name: string;
  tracks: LocalTrack[];
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  tags: Omit<TrackTags, 'cover'>;
  cover: string | null;
}

const cache = new Map<string, CacheEntry>();
const MAX_HEAD = 16 * 1024 * 1024;

const collator = new Intl.Collator('de', { numeric: true, sensitivity: 'base' });

function readAt(fd: number, offset: number, length: number): Buffer {
  const buf = Buffer.alloc(Math.max(0, Math.min(length, MAX_HEAD)));
  const read = fs.readSync(fd, buf, 0, buf.length, offset);
  return buf.subarray(0, read);
}

/** Tags einer Datei lesen (nur den Anfang der Datei) */
export function readTags(file: string): TrackTags {
  const ext = path.extname(file).toLowerCase();
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    if (ext === '.mp3') {
      const size = id3TagSize(readAt(fd, 0, 10));
      return size ? parseId3(readAt(fd, 0, size)) : {};
    }
    if (ext === '.flac') {
      const handle = fd;
      const end = flacMetadataEnd((offset, length) => readAt(handle, offset, length));
      return end ? parseFlac(readAt(fd, 0, end)) : {};
    }
    if (ext === '.ogg' || ext === '.opus') return parseOgg(readAt(fd, 0, 512 * 1024));
    return {};
  } catch {
    return {};
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function saveCover(coverDir: string, tags: TrackTags): string | null {
  if (!tags.cover) return null;
  const ext = tags.cover.mime.includes('png') ? '.png' : tags.cover.mime.includes('webp') ? '.webp' : '.jpg';
  const name = createHash('sha1').update(tags.cover.data).digest('hex').slice(0, 20) + ext;
  const target = path.join(coverDir, name);
  try {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(coverDir, { recursive: true });
      fs.writeFileSync(target, tags.cover.data);
    }
    return name;
  } catch {
    return null;
  }
}

function trackFor(root: string, abs: string, coverDir: string): LocalTrack {
  const rel = path.relative(root, abs).split(path.sep).join('/');
  const stat = fs.statSync(abs);
  let entry = cache.get(abs);
  if (!entry || entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) {
    const tags = readTags(abs);
    const { cover: _cover, ...rest } = tags;
    entry = { mtimeMs: stat.mtimeMs, size: stat.size, tags: rest, cover: saveCover(coverDir, tags) };
    cache.set(abs, entry);
  }
  const fallback = tagsFromFileName(abs);
  return {
    id: createHash('sha1').update(rel).digest('hex').slice(0, 12),
    file: rel,
    title: entry.tags.title || fallback.title,
    artists: entry.tags.artists?.length ? entry.tags.artists : fallback.artists,
    album: entry.tags.album || null,
    cover: entry.cover,
  };
}

/** Alle Audiodateien in einem Ordner (rekursiv), sortiert wie im Explorer */
function audioFiles(dir: string, recursive: boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries.sort((a, b) => collator.compare(a.name, b.name))) {
    const full = path.join(dir, e.name);
    if (e.isFile() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) files.push(full);
    else if (recursive && e.isDirectory() && !e.name.startsWith('.')) files.push(...audioFiles(full, true));
  }
  return files;
}

/** Musik-Ordner einlesen. Unterordner = Playlists (inkl. ihrer Unterordner). */
export function scanLibrary(root: string, coverDir: string): LocalPlaylist[] {
  if (!root || !fs.existsSync(root)) return [];
  const playlists: LocalPlaylist[] = [];
  const top = audioFiles(root, false);
  if (top.length) playlists.push({ id: '', name: 'Hauptordner', tracks: top.map((f) => trackFor(root, f, coverDir)) });
  let dirs: fs.Dirent[] = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  } catch {
    // nicht lesbar
  }
  for (const dir of dirs.sort((a, b) => collator.compare(a.name, b.name))) {
    const files = audioFiles(path.join(root, dir.name), true);
    if (files.length) playlists.push({ id: dir.name, name: dir.name, tracks: files.map((f) => trackFor(root, f, coverDir)) });
  }
  return playlists;
}
