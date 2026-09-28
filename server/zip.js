// Minimal zip writer for folder downloads, so Nova needs no zip dependency. Each file is
// read and deflated on its own (stored if that's smaller), with UTF-8 names. No zip64:
// callers keep the total under 4 GB and 65,535 files.
import fs from 'node:fs';
import zlib from 'node:zlib';

function dosTime(ms) {
  const d = new Date(ms);
  const year = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

// files: [{ abs, name, mtime }] with name the path inside the zip, using forward slashes.
export async function zipTo(out, files) {
  let offset = 0;
  const write = (buf) => new Promise((resolve, reject) => {
    if (out.destroyed) return reject(new Error('The download was cancelled.'));
    offset += buf.length;
    if (out.write(buf)) return resolve();
    const done = () => { out.off('close', gone); resolve(); };
    const gone = () => { out.off('drain', done); reject(new Error('The download was cancelled.')); };
    out.once('drain', done);
    out.once('close', gone);
  });

  const central = [];
  for (const f of files) {
    let data;
    try { data = await fs.promises.readFile(f.abs); } catch { continue; } // gone since it was listed
    const crc = zlib.crc32(data);
    const deflated = zlib.deflateRawSync(data);
    const method = deflated.length < data.length ? 8 : 0;
    const body = method ? deflated : data;
    const name = Buffer.from(f.name, 'utf8');
    const { time, date } = dosTime(f.mtime);
    const at = offset;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // flags: UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    await write(local);
    await write(name);
    await write(body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);          // made by
    entry.writeUInt16LE(20, 6);          // version needed
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(at, 42);         // offset of the local header
    central.push(entry, name);
  }

  const start = offset;
  for (const buf of central) await write(buf);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(offset - start, 12);
  end.writeUInt32LE(start, 16);
  await write(end);
  out.end();
}
