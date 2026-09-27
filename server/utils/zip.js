'use strict';
/**
 * A minimal zip archive (deflate, UTF-8 names, no zip64) for the account export (ADR-033): a handful of JSON files,
 * well under 4 GB. build(entries) → Buffer; read(buffer) → { name: Buffer } (tests, and a check after writing).
 */
const zlib = require('zlib');

function dos(d) {
    return {
        time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
        date: ((Math.max(1980, d.getUTCFullYear()) - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    };
}

/** entries: [{ name, data: Buffer|string }] */
function build(entries, { date = new Date() } = {}) {
    const { time, date: day } = dos(date);
    const locals = [];
    const central = [];
    let offset = 0;
    for (const e of entries) {
        const name = Buffer.from(e.name, 'utf8');
        const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
        const crc = zlib.crc32(raw);
        const body = zlib.deflateRawSync(raw);
        const h = Buffer.alloc(30);
        h.writeUInt32LE(0x04034b50, 0);
        h.writeUInt16LE(20, 4);
        h.writeUInt16LE(0x0800, 6);                 // UTF-8 names
        h.writeUInt16LE(8, 8);                      // deflate
        h.writeUInt16LE(time, 10);
        h.writeUInt16LE(day, 12);
        h.writeUInt32LE(crc, 14);
        h.writeUInt32LE(body.length, 18);
        h.writeUInt32LE(raw.length, 22);
        h.writeUInt16LE(name.length, 26);
        locals.push(h, name, body);
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0);
        c.writeUInt16LE(20, 4);
        c.writeUInt16LE(20, 6);
        c.writeUInt16LE(0x0800, 8);
        c.writeUInt16LE(8, 10);
        c.writeUInt16LE(time, 12);
        c.writeUInt16LE(day, 14);
        c.writeUInt32LE(crc, 16);
        c.writeUInt32LE(body.length, 20);
        c.writeUInt32LE(raw.length, 24);
        c.writeUInt16LE(name.length, 28);
        c.writeUInt32LE(offset, 42);
        central.push(c, name);
        offset += 30 + name.length + body.length;
    }
    const dir = Buffer.concat(central);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(dir.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, dir, end]);
}

function read(buf) {
    const endAt = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (endAt < 0) throw new Error('zip: no end record');
    const count = buf.readUInt16LE(endAt + 10);
    let p = buf.readUInt32LE(endAt + 16);
    const out = {};
    for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('zip: bad central entry');
        const method = buf.readUInt16LE(p + 10);
        const crc = buf.readUInt32LE(p + 16);
        const size = buf.readUInt32LE(p + 20);
        const nameLen = buf.readUInt16LE(p + 28);
        const extra = buf.readUInt16LE(p + 30);
        const comment = buf.readUInt16LE(p + 32);
        const local = buf.readUInt32LE(p + 42);
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
        const body = buf.subarray(start, start + size);
        const data = method === 8 ? zlib.inflateRawSync(body) : Buffer.from(body);
        if (zlib.crc32(data) !== crc) throw new Error(`zip: crc mismatch in ${name}`);
        out[name] = data;
        p += 46 + nameLen + extra + comment;
    }
    return out;
}

module.exports = { build, read };
