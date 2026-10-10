// Silinx - Spartan-3E configuration bitstreams (.bit files): reading and writing (browser + Node).
//
// A .bit file is a short header (design name, part, date, time) followed by the configuration
// packets of UG332 (Spartan-3 Generation Configuration User Guide): a sync word, Type 1 / Type 2
// packet headers and register writes (CMD, FLR, COR, IDCODE, MASK, FAR, FDRI, CTL, CRC). The frame
// data is written to FDRI in one Type 2 packet; the packet sequence written here is the one ISE's
// bitgen writes for an XC3S250E with its default options, so a design with the same frame data
// gives a byte-identical file.
//
// Frame data: Uint32Array of frames * frameWords words, as written to FDRI. Bit b of a frame is bit
// (31 - b % 32) of word floor(b / 32) (the first bit of a frame is the most significant bit).

/** The XC3S250E: frames of 73 words (FLR = 72), 578 frames written to FDRI. */
export const XC3S250E = { device: 'xc3s250e', part: '3s250ecp132', idcode: 0x01c1a093, frameWords: 73, frames: 578 };

// configuration registers (UG332)
export const REG = { CRC: 0, FAR: 1, FDRI: 2, FDRO: 3, CMD: 4, CTL: 5, MASK: 6, STAT: 7, LOUT: 8, COR: 9, MFWR: 10, FLR: 11, KEY: 12, CBC: 13, IDCODE: 14 };
const REG_NAME = Object.fromEntries(Object.entries(REG).map(([k, v]) => [v, k]));
// commands written to CMD
const CMD = { WCFG: 1, LFRM: 3, START: 5, RCRC: 7, SWITCH: 9, GRESTORE: 10, DESYNC: 13 };
const NOOP = 0x20000000;
const type1 = (reg, n) => (0x30000000 | (reg << 13) | n) >>> 0;   // Type 1 write of n words
const type2 = n => (0x50000000 | n) >>> 0;                          // Type 2 write of n words

/** The configuration CRC after one register write: CRC-16 (polynomial 0x8005, bit-reversed form
 *  0xA001), fed with the 32 data bits then the 5 register-address bits, least significant first. */
export function crcUpdate(crc, reg, word) {
  let c = crc;
  for (let i = 0; i < 37; i++) {
    const bit = i < 32 ? (word >>> i) & 1 : (reg >>> (i - 32)) & 1;
    const fb = (c ^ bit) & 1;
    c >>>= 1;
    if (fb) c ^= 0xa001;
  }
  return c;
}

/** The value of the COR register for the bitgen options used here: the default startup sequence;
 *  StartUpClk Cclk (default) / UserClk / JtagClk; CRC checked unless crc is false. */
export function corValue({ crc = true, startupClk = 'Cclk' } = {}) {
  let cor = 0x000031e5;
  const clk = String(startupClk).toLowerCase();
  if (clk === 'jtagclk') cor |= 0x00010000;
  else if (clk === 'userclk') cor |= 0x00008000;
  if (!crc) cor |= 0x20000000;
  return cor >>> 0;
}

/** Read and set single bits of frame data. */
export function getBit(frames, fw, frame, bit) {
  const w = frame * fw + (bit >> 5);
  return (frames[w] >>> (31 - (bit & 31))) & 1;
}
export function setBit(frames, fw, frame, bit, value = 1) {
  const w = frame * fw + (bit >> 5);
  const m = 1 << (31 - (bit & 31));
  if (value) frames[w] = (frames[w] | m) >>> 0; else frames[w] = (frames[w] & ~m) >>> 0;
}

const ascii = s => Array.from(String(s), ch => ch.charCodeAt(0) & 0xff);

/** The .bit file of a configuration: { frames, name ('top.ncd'), part ('3s250ecp132'), date
 *  ('2026/10/10'), time ('12:00:00'), crc (true: bitgen's default; false: -g CRC:Disable),
 *  startupClk ('Cclk' | 'UserClk' | 'JtagClk') }. Returns a Uint8Array. */
export function writeBit({ frames, name = 'design.ncd', part = XC3S250E.part, date = '2026/01/01', time = '00:00:00', crc = true, startupClk = 'Cclk', device = XC3S250E }) {
  const fw = device.frameWords;
  if (frames.length !== device.frames * fw) throw new Error(`frame data: ${frames.length} words, expected ${device.frames * fw}`);
  const words = [0xffffffff, 0xaa995566];
  let c = 0;
  // a register write (Type 1), updating the CRC as the device does
  const write = (reg, ...data) => {
    words.push(type1(reg, data.length), ...data);
    for (const d of data) {
      if (reg === REG.CMD && d === CMD.RCRC) { c = 0; continue; }
      c = crcUpdate(c, reg, d);
    }
  };
  write(REG.CMD, CMD.RCRC);
  write(REG.FLR, fw - 1);
  write(REG.COR, corValue({ crc, startupClk }));
  write(REG.IDCODE, device.idcode);
  write(REG.MASK, 0);
  write(REG.CMD, CMD.SWITCH);
  write(REG.FAR, 0);
  write(REG.CMD, CMD.WCFG);
  // the frames: an empty Type 1 FDRI header, then a Type 2 packet with all the frame data
  words.push(type1(REG.FDRI, 0), type2(frames.length));
  for (let i = 0; i < frames.length; i++) { words.push(frames[i] >>> 0); c = crcUpdate(c, REG.FDRI, frames[i] >>> 0); }
  // the CRC check word that follows the frame data (a fixed value when the CRC is not checked)
  words.push(crc ? c : 0xdefc);
  c = 0;
  write(REG.CMD, CMD.GRESTORE);
  write(REG.CMD, CMD.LFRM);
  for (let i = 0; i < fw; i++) words.push(NOOP);
  write(REG.CMD, CMD.START);
  write(REG.CTL, 0);
  words.push(type1(REG.CRC, 1), crc ? c : 0xdefc);
  c = 0;
  write(REG.CMD, CMD.DESYNC);
  for (let i = 0; i < 4; i++) words.push(NOOP);
  // header: a field preamble, then the fields a (design), b (part), c (date), d (time), e (length)
  const head = [0x00, 0x09, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x0f, 0xf0, 0x00, 0x00, 0x01];
  const field = (key, s) => { const b = [...ascii(s), 0]; head.push(key.charCodeAt(0), b.length >> 8, b.length & 0xff, ...b); };
  field('a', name); field('b', part); field('c', date); field('d', time);
  const len = words.length * 4;
  head.push('e'.charCodeAt(0), (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  const out = new Uint8Array(head.length + len);
  out.set(head, 0);
  let p = head.length;
  for (const w of words) { out[p++] = w >>> 24; out[p++] = (w >>> 16) & 0xff; out[p++] = (w >>> 8) & 0xff; out[p++] = w & 0xff; }
  return out;
}

/** Read a .bit file: { header: { a, b, c, d }, packets: [{ reg, words }], frames (Uint32Array, the
 *  FDRI data), cor, crcChecks: [{ expected, computed }] }. Throws if there is no sync word. */
export function readBit(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const header = {};
  // header fields: after the 13-byte preamble, key byte + 16-bit length + text (e: 32-bit length)
  let p = 13;
  while (p < b.length) {
    const key = String.fromCharCode(b[p]);
    if (key === 'e') break;
    if (!'abcd'.includes(key)) break;
    const n = (b[p + 1] << 8) | b[p + 2];
    header[key] = String.fromCharCode(...b.subarray(p + 3, p + 3 + n - 1));
    p += 3 + n;
  }
  let s = -1;
  for (let i = 0; i + 3 < b.length; i++) if (b[i] === 0xaa && b[i + 1] === 0x99 && b[i + 2] === 0x55 && b[i + 3] === 0x66) { s = i + 4; break; }
  if (s < 0) throw new Error('no sync word');
  const words = [];
  for (let i = s; i + 4 <= b.length; i += 4) words.push(((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0);
  const packets = [], crcChecks = [];
  let last = 0, fdri = [], cor = null, c = 0;
  for (let k = 0; k < words.length;) {
    const h = words[k++];
    const t = h >>> 29;
    if (t === 1) {
      const reg = (h >>> 13) & 0x3fff, n = h & 0x7ff;
      last = reg;
      const data = words.slice(k, k + n); k += n;
      if (reg === REG.CRC) { for (const d of data) { crcChecks.push({ expected: d, computed: c }); c = 0; } } else for (const d of data) c = reg === REG.CMD && d === CMD.RCRC ? 0 : crcUpdate(c, reg, d);
      if (h === NOOP) continue;
      packets.push({ reg: REG_NAME[reg] ?? reg, words: data });
      if (reg === REG.COR && n) cor = data[0];
      if (reg === REG.FDRI) fdri = fdri.concat(data);
    } else if (t === 2) {
      const n = h & 0x7ffffff;
      const data = words.slice(k, k + n); k += n;
      for (const d of data) c = crcUpdate(c, last, d);
      packets.push({ reg: REG_NAME[last] ?? last, words: [`${n} words`] });
      if (last === REG.FDRI) {
        fdri = fdri.concat(data);
        // the CRC check word after the frame data
        crcChecks.push({ expected: words[k], computed: c }); k++; c = 0;
      }
    } else if (h !== 0xffffffff) packets.push({ unknown: h });
  }
  return { header, packets, frames: Uint32Array.from(fdri), cor, crcChecks };
}

/** The bits that differ between two frame data arrays: [{ frame, bit, value (in b) }]. */
export function diffFrames(a, b, fw = XC3S250E.frameWords) {
  const out = [];
  const n = Math.max(a.length, b.length);
  for (let w = 0; w < n; w++) {
    const x = ((a[w] ?? 0) ^ (b[w] ?? 0)) >>> 0;
    if (!x) continue;
    for (let i = 0; i < 32; i++) if ((x >>> (31 - i)) & 1) out.push({ frame: Math.floor(w / fw), bit: (w % fw) * 32 + i, value: ((b[w] ?? 0) >>> (31 - i)) & 1 });
  }
  return out;
}
