import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { id3TagSize, parseFlac, parseId3, parseOgg, parseVorbisComment, tagsFromFileName } from './tags';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);

function synchsafe(n: number): Buffer {
  return Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
}

/** ID3v2.3/2.4-Tag aus Frames bauen */
function id3(version: 3 | 4, frames: Array<[string, Buffer]>): Buffer {
  const body = Buffer.concat(frames.map(([id, data]) => {
    const size = version === 4 ? synchsafe(data.length) : Buffer.from([0, 0, 0, 0].map((_, i) => (data.length >> (24 - i * 8)) & 0xff));
    return Buffer.concat([Buffer.from(id, 'latin1'), size, Buffer.from([0, 0]), data]);
  }));
  const padded = Buffer.concat([body, Buffer.alloc(32)]);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([version, 0, 0]), synchsafe(padded.length), padded]);
}

const text = (encoding: number, value: string) => {
  if (encoding === 1) return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), Buffer.from(value, 'utf16le')]);
  return Buffer.concat([Buffer.from([encoding]), Buffer.from(value, encoding === 3 ? 'utf8' : 'latin1')]);
};

function vorbisBlock(entries: string[]): Buffer {
  const parts = [Buffer.alloc(4), Buffer.alloc(4)];
  parts[0].writeUInt32LE(0);
  parts[1].writeUInt32LE(entries.length);
  for (const e of entries) {
    const b = Buffer.from(e, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32LE(b.length);
    parts.push(len, b);
  }
  return Buffer.concat(parts);
}

function flacPicture(mime: string, data: Buffer): Buffer {
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32BE(n);
    return b;
  };
  return Buffer.concat([u32(3), u32(mime.length), Buffer.from(mime, 'latin1'), u32(0), u32(1), u32(1), u32(24), u32(0), u32(data.length), data]);
}

describe('tagsFromFileName', () => {
  it('liest „Artist - Titel“', () => {
    assert.deepEqual(tagsFromFileName('C:\\Musik\\Chill\\Lofi Girl - Snowman.mp3'), { title: 'Snowman', artists: ['Lofi Girl'] });
  });
  it('wirft Tracknummern weg', () => {
    assert.deepEqual(tagsFromFileName('03 - Nur der Titel.flac'), { title: 'Nur der Titel', artists: [] });
    assert.deepEqual(tagsFromFileName('07. Band - Song_Name.ogg'), { title: 'Song Name', artists: ['Band'] });
  });
});

describe('ID3v2', () => {
  it('liest Titel, Artists, Album und Cover (v2.3, UTF-16)', () => {
    const apic = Buffer.concat([Buffer.from([0]), Buffer.from('image/jpeg\0', 'latin1'), Buffer.from([3]), Buffer.from('\0', 'latin1'), JPEG]);
    const tag = id3(3, [['TIT2', text(1, 'Grüße')], ['TPE1', text(0, 'A / B')], ['TALB', text(0, 'Album')], ['APIC', apic]]);
    assert.equal(id3TagSize(tag), tag.length);
    const tags = parseId3(tag);
    assert.equal(tags.title, 'Grüße');
    assert.deepEqual(tags.artists, ['A', 'B']);
    assert.equal(tags.album, 'Album');
    assert.equal(tags.cover?.mime, 'image/jpeg');
    assert.deepEqual(tags.cover?.data, JPEG);
  });

  it('liest v2.4 mit UTF-8 und mehreren Artists (\\0-getrennt)', () => {
    const tags = parseId3(id3(4, [['TIT2', text(3, 'Tänzchen')], ['TPE1', text(3, 'Eins\u0000Zwei')]]));
    assert.equal(tags.title, 'Tänzchen');
    assert.deepEqual(tags.artists, ['Eins', 'Zwei']);
  });

  it('kommt mit Dateien ohne Tag klar', () => {
    assert.equal(id3TagSize(Buffer.from([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0, 0, 0])), 0);
    assert.deepEqual(parseId3(Buffer.alloc(20)), {});
  });
});

describe('FLAC & OGG', () => {
  it('liest Vorbis-Kommentare und PICTURE aus FLAC', () => {
    const comment = vorbisBlock(['TITLE=Song', 'ARTIST=X', 'artist=Y', 'ALBUM=Platte']);
    const picture = flacPicture('image/png', JPEG);
    const block = (type: number, data: Buffer, last: boolean) => Buffer.concat([
      Buffer.from([(last ? 0x80 : 0) | type, (data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff]), data,
    ]);
    const file = Buffer.concat([Buffer.from('fLaC', 'latin1'), block(0, Buffer.alloc(34), false), block(4, comment, false), block(6, picture, true)]);
    const tags = parseFlac(file);
    assert.equal(tags.title, 'Song');
    assert.deepEqual(tags.artists, ['X', 'Y']);
    assert.equal(tags.album, 'Platte');
    assert.equal(tags.cover?.mime, 'image/png');
  });

  it('liest den Kommentar-Header aus OGG Vorbis', () => {
    const packet = Buffer.concat([Buffer.from('\x03vorbis', 'latin1'), vorbisBlock(['TITLE=Ogg-Song', 'ARTIST=Z'])]);
    const page = Buffer.concat([
      Buffer.from('OggS', 'latin1'), Buffer.alloc(22), Buffer.from([1, packet.length]), packet,
    ]);
    const tags = parseOgg(page);
    assert.equal(tags.title, 'Ogg-Song');
    assert.deepEqual(tags.artists, ['Z']);
  });

  it('übersteht kaputte Kommentar-Blöcke', () => {
    assert.deepEqual(parseVorbisComment(Buffer.from([1, 2])), {});
  });
});
