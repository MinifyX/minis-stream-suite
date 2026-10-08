/**
 * Metadaten aus Audiodateien lesen – ohne Abhängigkeiten, nur was die Musik-Bibliothek braucht:
 * Titel, Artists, Album und Cover.
 *
 *  - MP3: ID3v2.2 / 2.3 / 2.4 (TIT2, TPE1, TALB, APIC)
 *  - FLAC: VORBIS_COMMENT + PICTURE
 *  - OGG (Vorbis/Opus): Kommentar-Header, Cover als METADATA_BLOCK_PICTURE
 *  - alles andere (z.B. WAV) und fehlende Tags: aus dem Dateinamen („Artist - Titel.mp3“)
 *
 * Alle Funktionen hier arbeiten nur auf Buffern (testbar); das Lesen der Dateien steckt in library.ts.
 */

export interface Cover {
  mime: string;
  data: Buffer;
}

export interface TrackTags {
  title?: string;
  artists?: string[];
  album?: string;
  cover?: Cover;
}

// ------------------------------------------------------------------ Dateiname

/** „01 - Artist - Titel.mp3“ → { title: 'Titel', artists: ['Artist'] } */
export function tagsFromFileName(fileName: string): { title: string; artists: string[] } {
  let base = fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  // Tracknummer vorne weg: "01 ", "01. ", "01 - "
  base = base.replace(/^\d{1,3}\s*(?:[.)-]\s*|\s+)/, '').trim();
  const parts = base.split(/\s+[-–]\s+/);
  if (parts.length >= 2) {
    const artist = parts.shift()!.trim();
    return { title: parts.join(' - ').trim() || base, artists: artist ? [artist] : [] };
  }
  return { title: base || fileName, artists: [] };
}

// ------------------------------------------------------------------ ID3v2 (MP3)

/** Größe des ID3v2-Tags inkl. Kopf (10 Bytes reichen), oder 0 wenn keiner da ist */
export function id3TagSize(head: Buffer): number {
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return 0;
  const footer = head[5] & 0x10 ? 10 : 0;
  return 10 + synchsafe(head, 6) + footer;
}

function synchsafe(buf: Buffer, offset: number): number {
  return ((buf[offset] & 0x7f) << 21) | ((buf[offset + 1] & 0x7f) << 14) | ((buf[offset + 2] & 0x7f) << 7) | (buf[offset + 3] & 0x7f);
}

/** Unsynchronisation rückgängig machen: 0xFF 0x00 → 0xFF */
function deUnsync(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length);
  let j = 0;
  for (let i = 0; i < buf.length; i++) {
    out[j++] = buf[i];
    if (buf[i] === 0xff && buf[i + 1] === 0x00) i++;
  }
  return out.subarray(0, j);
}

function decodeText(buf: Buffer, encoding: number): string {
  let text: string;
  if (encoding === 1 || encoding === 2) {
    // UTF-16 (mit BOM) bzw. UTF-16BE
    let data = buf;
    let le = encoding === 1;
    if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
      le = true;
      data = data.subarray(2);
    } else if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
      le = false;
      data = data.subarray(2);
    }
    if (!le) {
      const swapped = Buffer.from(data.subarray(0, data.length - (data.length % 2)));
      swapped.swap16();
      data = swapped;
    }
    text = data.subarray(0, data.length - (data.length % 2)).toString('utf16le');
  } else {
    text = buf.toString(encoding === 3 ? 'utf8' : 'latin1');
  }
  return text;
}

/** Text bis zum (passenden) Null-Terminator; gibt den Text und die Länge inkl. Terminator zurück */
function readTerminated(buf: Buffer, offset: number, encoding: number): { text: string; next: number } {
  const wide = encoding === 1 || encoding === 2;
  let end = offset;
  if (wide) {
    while (end + 1 < buf.length && !(buf[end] === 0 && buf[end + 1] === 0)) end += 2;
    return { text: decodeText(buf.subarray(offset, end), encoding), next: Math.min(buf.length, end + 2) };
  }
  while (end < buf.length && buf[end] !== 0) end++;
  return { text: decodeText(buf.subarray(offset, end), encoding), next: Math.min(buf.length, end + 1) };
}

/** Mehrere Werte (ID3v2.4: \0-getrennt, v2.3 oft „A / B“ oder „A; B“) */
function splitValues(text: string): string[] {
  return text.split('\u0000').flatMap((v) => v.split(/\s*[/;]\s*/)).map((v) => v.trim()).filter(Boolean);
}

/** ID3v2-Tag lesen (buf beginnt mit „ID3“, enthält den ganzen Tag) */
export function parseId3(buf: Buffer): TrackTags {
  const tags: TrackTags = {};
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return tags;
  const version = buf[3];
  const flags = buf[5];
  const size = synchsafe(buf, 6);
  let body = buf.subarray(10, Math.min(buf.length, 10 + size));
  if (flags & 0x80 && version < 4) body = deUnsync(body);
  let pos = 0;
  if (flags & 0x40) {
    // Erweiterter Kopf überspringen
    const extSize = version === 4 ? synchsafe(body, 0) : body.readUInt32BE(0) + 4;
    pos = extSize;
  }

  const idLen = version === 2 ? 3 : 4;
  const headLen = version === 2 ? 6 : 10;
  while (pos + headLen <= body.length) {
    const id = body.toString('latin1', pos, pos + idLen);
    if (!/^[A-Z0-9]+$/.test(id)) break; // Füllbytes erreicht
    let frameSize: number;
    if (version === 2) frameSize = (body[pos + 3] << 16) | (body[pos + 4] << 8) | body[pos + 5];
    else if (version === 4) frameSize = synchsafe(body, pos + 4);
    else frameSize = body.readUInt32BE(pos + 4);
    const frameFlags = version === 2 ? 0 : body.readUInt16BE(pos + 8);
    const start = pos + headLen;
    let frame = body.subarray(start, Math.min(body.length, start + frameSize));
    pos = start + frameSize;
    if (frameSize <= 0) continue;
    // v2.4: Unsynchronisation pro Frame
    if (version === 4 && frameFlags & 0x02) frame = deUnsync(frame);
    // Komprimierte/verschlüsselte Frames lassen wir aus
    if (version === 3 && frameFlags & 0x00c0) continue;
    if (version === 4 && frameFlags & 0x000c) continue;
    // v2.4: Länge vor den Daten (Data length indicator)
    if (version === 4 && frameFlags & 0x01) frame = frame.subarray(4);

    const key = version === 2 ? { TT2: 'TIT2', TP1: 'TPE1', TAL: 'TALB', PIC: 'APIC' }[id] : id;
    if (key === 'TIT2' || key === 'TPE1' || key === 'TALB') {
      const value = decodeText(frame.subarray(1), frame[0]).replace(/\u0000+$/, '').trim();
      if (!value) continue;
      if (key === 'TIT2') tags.title ??= value.split('\u0000')[0];
      if (key === 'TALB') tags.album ??= value.split('\u0000')[0];
      if (key === 'TPE1') tags.artists ??= splitValues(value);
    } else if (key === 'APIC' && !tags.cover) {
      const encoding = frame[0];
      let mime: string;
      let p: number;
      if (version === 2) {
        // PIC: 3 Zeichen Format statt MIME
        const format = frame.toString('latin1', 1, 4).toLowerCase();
        mime = format === 'png' ? 'image/png' : 'image/jpeg';
        p = 4;
      } else {
        const m = readTerminated(frame, 1, 0);
        mime = m.text.toLowerCase() || 'image/jpeg';
        if (!mime.includes('/')) mime = `image/${mime === 'jpg' ? 'jpeg' : mime}`;
        p = m.next;
      }
      p += 1; // Bildart (Front-Cover usw.)
      const desc = readTerminated(frame, p, encoding);
      const data = frame.subarray(desc.next);
      if (data.length > 16) tags.cover = { mime, data: Buffer.from(data) };
    }
  }
  return tags;
}

// ------------------------------------------------------------------ Vorbis-Kommentare (FLAC, OGG)

/** Vorbis-Kommentar-Block (Little Endian: Vendor, Anzahl, „KEY=Wert“) */
export function parseVorbisComment(buf: Buffer): TrackTags {
  const tags: TrackTags = {};
  try {
    let p = 0;
    const vendorLen = buf.readUInt32LE(p);
    p += 4 + vendorLen;
    const count = buf.readUInt32LE(p);
    p += 4;
    const artists: string[] = [];
    for (let i = 0; i < count && p + 4 <= buf.length; i++) {
      const len = buf.readUInt32LE(p);
      p += 4;
      const entry = buf.toString('utf8', p, Math.min(buf.length, p + len));
      p += len;
      const eq = entry.indexOf('=');
      if (eq < 0) continue;
      const key = entry.slice(0, eq).toUpperCase();
      const value = entry.slice(eq + 1).trim();
      if (!value) continue;
      if (key === 'TITLE') tags.title ??= value;
      else if (key === 'ALBUM') tags.album ??= value;
      else if (key === 'ARTIST') artists.push(value);
      else if (key === 'METADATA_BLOCK_PICTURE' && !tags.cover) {
        tags.cover = parseFlacPicture(Buffer.from(value, 'base64')) ?? undefined;
      }
    }
    if (artists.length) tags.artists = artists;
  } catch {
    // kaputter Block – was wir haben, nehmen wir
  }
  return tags;
}

/** FLAC-PICTURE-Block (Big Endian) */
export function parseFlacPicture(buf: Buffer): Cover | null {
  try {
    let p = 4; // Bildart
    const mimeLen = buf.readUInt32BE(p);
    p += 4;
    const mime = buf.toString('latin1', p, p + mimeLen) || 'image/jpeg';
    p += mimeLen;
    const descLen = buf.readUInt32BE(p);
    p += 4 + descLen + 16; // Beschreibung, Breite, Höhe, Farbtiefe, Farben
    const len = buf.readUInt32BE(p);
    p += 4;
    const data = buf.subarray(p, p + len);
    return data.length > 16 ? { mime, data: Buffer.from(data) } : null;
  } catch {
    return null;
  }
}

/** Metadaten-Blöcke einer FLAC-Datei (buf = Dateianfang, so viel wie die Blöcke lang sind) */
export function parseFlac(buf: Buffer): TrackTags {
  if (buf.toString('latin1', 0, 4) !== 'fLaC') return {};
  let tags: TrackTags = {};
  let p = 4;
  while (p + 4 <= buf.length) {
    const header = buf[p];
    const type = header & 0x7f;
    const len = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
    const block = buf.subarray(p + 4, p + 4 + len);
    if (type === 4) tags = { ...parseVorbisComment(block), cover: tags.cover };
    if (type === 6 && !tags.cover) tags.cover = parseFlacPicture(block) ?? undefined;
    p += 4 + len;
    if (header & 0x80) break; // letzter Block
  }
  return tags;
}

/** Wie viele Bytes am Dateianfang braucht parseFlac? (aus den Blockköpfen, buf = erste Bytes) */
export function flacMetadataEnd(readAt: (offset: number, length: number) => Buffer): number {
  if (readAt(0, 4).toString('latin1') !== 'fLaC') return 0;
  let p = 4;
  for (let i = 0; i < 128; i++) {
    const head = readAt(p, 4);
    if (head.length < 4) break;
    const len = (head[1] << 16) | (head[2] << 8) | head[3];
    p += 4 + len;
    if (head[0] & 0x80) break;
  }
  return p;
}

/** OGG (Vorbis oder Opus): Seiten-Inhalte aneinanderhängen und den Kommentar-Header suchen */
export function parseOgg(buf: Buffer): TrackTags {
  const payload: Buffer[] = [];
  let p = 0;
  while (p + 27 <= buf.length && buf.toString('latin1', p, p + 4) === 'OggS') {
    const segments = buf[p + 26];
    let size = 0;
    for (let i = 0; i < segments; i++) size += buf[p + 27 + i];
    const start = p + 27 + segments;
    payload.push(buf.subarray(start, Math.min(buf.length, start + size)));
    p = start + size;
  }
  const all = Buffer.concat(payload);
  const vorbis = all.indexOf(Buffer.from('\x03vorbis', 'latin1'));
  if (vorbis >= 0) return parseVorbisComment(all.subarray(vorbis + 7));
  const opus = all.indexOf(Buffer.from('OpusTags', 'latin1'));
  if (opus >= 0) return parseVorbisComment(all.subarray(opus + 8));
  return {};
}
