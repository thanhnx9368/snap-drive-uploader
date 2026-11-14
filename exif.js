// ═══════════════════════════════════════════
// Đọc ngày chụp (EXIF DateTimeOriginal) từ JPG / TIFF / RAW dạng TIFF (NEF, ARW, CR2, DNG...)
// Không cần thư viện ngoài: chỉ đọc 256KB đầu file.
// ═══════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const HEAD_BYTES = 256 * 1024;
const IMAGE_EXT = /\.(jpe?g|tiff?|nef|arw|cr2|dng|orf|rw2|pef|raf)$/i;

function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n);
  } finally {
    fs.closeSync(fd);
  }
}

// Đọc các tag ASCII cần thiết từ một khối TIFF (bắt đầu bằng "II*\0" hoặc "MM\0*")
function parseTiff(buf, base) {
  if (base + 8 > buf.length) return null;
  const order = buf.toString('latin1', base, base + 2);
  const le = order === 'II';
  if (!le && order !== 'MM') return null;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  if (u16(base + 2) !== 42) return null;

  const readIfd = (offset) => {
    const tags = {};
    const start = base + offset;
    if (start + 2 > buf.length) return tags;
    const count = u16(start);
    for (let i = 0; i < count; i++) {
      const e = start + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e);
      const type = u16(e + 2);
      const len = u32(e + 4);
      if (type === 2) { // ASCII
        const at = len <= 4 ? e + 8 : base + u32(e + 8);
        if (at + len <= buf.length) tags[tag] = buf.toString('latin1', at, at + len).replace(/\0+$/, '');
      } else if (type === 4 || type === 13) { // LONG / IFD
        tags[tag] = u32(e + 8);
      }
    }
    return tags;
  };

  const ifd0 = readIfd(u32(base + 4));
  const exif = ifd0[0x8769] ? readIfd(ifd0[0x8769]) : {};
  return exif[0x9003] || exif[0x9004] || ifd0[0x0132] || null;
}

function exifDateString(buf) {
  // TIFF / RAW dạng TIFF
  const head = buf.toString('latin1', 0, 4);
  if (head === 'II*\0' || head === 'MM\0*') return parseTiff(buf, 0);

  // JPEG: tìm APP1 "Exif\0\0"
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let o = 2;
  while (o + 4 <= buf.length) {
    if (buf[o] !== 0xff) return null;
    const marker = buf[o + 1];
    const size = buf.readUInt16BE(o + 2);
    if (marker === 0xe1 && buf.toString('latin1', o + 4, o + 10) === 'Exif\0\0') {
      return parseTiff(buf, o + 10);
    }
    if (marker === 0xda) return null; // bắt đầu dữ liệu ảnh, không còn metadata
    o += 2 + size;
  }
  return null;
}

// "2026:11:14 18:30:00" → "2026-11-14"
function toIsoDate(s) {
  const m = /^(\d{4})[:\-](\d{2})[:\-](\d{2})/.exec(s || '');
  if (!m || m[1] === '0000') return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

function readShootDate(file) {
  try { return toIsoDate(exifDateString(readHead(file))); } catch { return null; }
}

/**
 * Ngày chụp của cả folder: đọc tối đa `sample` ảnh, lấy ngày xuất hiện nhiều nhất
 * (bằng nhau thì lấy ngày sớm hơn).
 */
function folderShootDate(folderPath, sample = 30) {
  let names = [];
  try { names = fs.readdirSync(folderPath).filter((n) => !n.startsWith('.') && IMAGE_EXT.test(n)).sort(); } catch { /* skip */ }
  const counts = new Map();
  let read = 0;
  for (const n of names) {
    if (read >= sample) break;
    read++;
    const d = readShootDate(path.join(folderPath, n));
    if (d) counts.set(d, (counts.get(d) || 0) + 1);
  }
  let best = null;
  for (const [d, c] of counts) {
    if (!best || c > best.c || (c === best.c && d < best.d)) best = { d, c };
  }
  return { date: best ? best.d : null, images: names.length, read, withDate: [...counts.values()].reduce((a, b) => a + b, 0) };
}

module.exports = { folderShootDate, readShootDate, exifDateString };
