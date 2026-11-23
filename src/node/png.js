// Pure-JS PNG codec using Node's zlib (available in both node and browser-bundled builds
// via a small shim, see web/deflate-shim.js). Only 8-bit RGB/RGBA, non-interlaced.
import zlib from 'node:zlib';

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf) {
  let c, table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  c = -1;
  for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typ = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typ, data])), 0);
  return Buffer.concat([len, typ, data, crc]);
}

// Image representation used everywhere: {width, height, data: Uint8ClampedArray RGBA}
export function encodePNG(img) {
  const { width, height, data } = img;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter none
    for (let x = 0; x < width * 4; x++) {
      raw[y * (width * 4 + 1) + 1 + x] = data[y * width * 4 + x];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Animated PNG (APNG): a sequence of RGBA frames played natively by browsers.
// frames: [{image:{width,height,data}, delayMs}]. First frame is the default
// image (IDAT, no sequence number); later frames use fdAT with a running
// sequence counter; every fcTL carries its own sequence number.
export function encodeAPNG(frames, { loop = 0 } = {}) {
  if (!frames.length) throw new Error('encodeAPNG: no frames');
  const { width, height } = frames[0].image;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(loop, 4);
  const parts = [SIG, chunk('IHDR', ihdr), chunk('acTL', actl)];

  let seq = 0;
  const fctlChunk = (f) => {
    const b = Buffer.alloc(26);
    b.writeUInt32BE(seq++, 0);
    b.writeUInt32BE(width, 4);
    b.writeUInt32BE(height, 8);
    b.writeUInt32BE(0, 12);
    b.writeUInt32BE(0, 16);
    b.writeUInt16BE(Math.max(0, Math.round(f.delayMs ?? 40)), 20);
    b.writeUInt16BE(1000, 22);
    b[24] = 0; // dispose_op NONE
    b[25] = 0; // blend_op SOURCE
    return chunk('fcTL', b);
  };

  frames.forEach((f, idx) => {
    const { data } = f.image;
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (width * 4 + 1)] = 0;
      for (let x = 0; x < width * 4; x++) raw[y * (width * 4 + 1) + 1 + x] = data[y * width * 4 + x];
    }
    const zdata = zlib.deflateSync(raw, { level: 6 });
    parts.push(fctlChunk(f));
    if (idx === 0) {
      parts.push(chunk('IDAT', zdata));
    } else {
      const s = Buffer.alloc(4);
      s.writeUInt32BE(seq++, 0);
      parts.push(chunk('fdAT', Buffer.concat([s, zdata])));
    }
  });
  parts.push(chunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(parts);
}

export function decodePNG(buf) {
  if (!SIG.equals(buf.subarray(0, 8))) throw new Error('not a PNG');
  let off = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat = [];
  let palette = null, trns = null;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0)
    throw new Error(`unsupported PNG bitDepth=${bitDepth} interlace=${interlace}`);
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error('unsupported colorType ' + colorType);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const bpp = channels;
  const stride = width * bpp;
  const out = new Uint8ClampedArray(width * height * 4);
  const cur = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[p++];
    for (let i = 0; i < stride; i++) {
      const x = raw[p + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const pp = a + b - c;
          const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
          v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error('bad filter ' + filter);
      }
      cur[i] = v & 255;
    }
    p += stride;
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      const o = row + x * 4;
      if (colorType === 6) {
        out[o] = cur[x * 4]; out[o + 1] = cur[x * 4 + 1];
        out[o + 2] = cur[x * 4 + 2]; out[o + 3] = cur[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = cur[x * 3]; out[o + 1] = cur[x * 3 + 1];
        out[o + 2] = cur[x * 3 + 2]; out[o + 3] = 255;
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = cur[x]; out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = cur[x * 2]; out[o + 3] = cur[x * 2 + 1];
      } else if (colorType === 3) {
        const idx = cur[x];
        out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1];
        out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

export function makeImage(width, height, fill = [0, 0, 0, 0]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0]; data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2]; data[i * 4 + 3] = fill[3];
  }
  return { width, height, data };
}

export function getPixel(img, x, y) {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

export function setPixel(img, x, y, rgba) {
  const i = (y * img.width + x) * 4;
  img.data[i] = rgba[0]; img.data[i + 1] = rgba[1];
  img.data[i + 2] = rgba[2]; img.data[i + 3] = rgba[3];
}
