#!/usr/bin/env node
// Ronin Code — brand icon generator. No dependencies, no image libraries.
//
// Draws the mark pixel-by-pixel into an RGBA buffer, then encodes it with a
// hand-rolled PNG encoder (node:zlib for DEFLATE only):
//   - dark rounded-square background  #0b0c10
//   - red open ring (arc with a gap)  #e5484d
//   - red diagonal slash through the ring
//
// Outputs:
//   src-tauri/icons/icon.png  512x512 PNG
//   src-tauri/icons/icon.ico  ICO wrapping a 256x256 PNG
//
// Run:  node desktop/tools/make-icons.mjs
import { deflateSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src-tauri/icons");

// ---------- CRC32 (PNG chunks) ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

// ---------- Drawing ----------
const BG = [0x0b, 0x0c, 0x10, 255];
const RED = [0xe5, 0x48, 0x4d, 255];
const CLEAR = [0, 0, 0, 0];

function draw(size) {
  const px = new Uint8Array(size * size * 4);
  const set = (x, y, [r, g, b, a]) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
  };
  const c = size / 2;                       // centre
  const radius = size * 0.36;               // rounded-square inset shape below
  const corner = size * 0.20;               // corner radius of the background
  const ringR = size * 0.295;               // ring radius
  const ringHalf = size * 0.037;            // ring stroke half-width
  const slashHalf = size * 0.034;           // slash half-width
  const gapStart = -1.05, gapEnd = -0.25;   // open gap in the ring (radians, upper-right)
  // Slash segment endpoints (anti-diagonal, lower-left -> upper-right).
  const [x1, y1, x2, y2] = [c - ringR * 0.78, c + ringR * 0.78, c + ringR * 0.78, c - ringR * 0.78];
  const segLen2 = (x2 - x1) ** 2 + (y2 - y1) ** 2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Background: rounded square covering the full canvas.
      const dx = Math.max(Math.abs(x - c) - (radius + corner * 0.44), 0);
      const dy = Math.max(Math.abs(y - c) - (radius + corner * 0.44), 0);
      // Simpler rounded-rect test: clamp point to inner rect, measure distance.
      const hx = size / 2 - corner, hy = size / 2 - corner;
      const qx = Math.abs(x - c) - hx, qy = Math.abs(y - c) - hy;
      const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - corner;
      void dx; void dy;
      if (outside > 0) { set(x, y, CLEAR); continue; }
      set(x, y, BG);

      // Ring: band around ringR, except inside the angular gap.
      const distC = Math.hypot(x - c, y - c);
      const ang = Math.atan2(y - c, x - c);
      if (Math.abs(distC - ringR) <= ringHalf && !(ang > gapStart && ang < gapEnd)) {
        set(x, y, RED); continue;
      }
      // Slash: distance from the segment <= slashHalf, clipped to the disc.
      const t = Math.max(0, Math.min(1, ((x - x1) * (x2 - x1) + (y - y1) * (y2 - y1)) / segLen2));
      const distSeg = Math.hypot(x - (x1 + t * (x2 - x1)), y - (y1 + t * (y2 - y1)));
      if (distSeg <= slashHalf && distC <= ringR + ringHalf) set(x, y, RED);
    }
  }
  return px;
}

// ---------- PNG encoding ----------
function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, y * size * 4, size * 4).copy(raw, y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- ICO encoding (single 256x256 PNG entry) ----------
function encodeIco(png256) {
  const header = Buffer.alloc(6 + 16);
  header.writeUInt16LE(0, 0);            // reserved
  header.writeUInt16LE(1, 2);            // type: icon
  header.writeUInt16LE(1, 4);            // image count
  header[6] = 0;                         // width: 0 == 256
  header[7] = 0;                         // height: 0 == 256
  header[8] = 0;                         // palette colours
  header[9] = 0;                         // reserved
  header.writeUInt16LE(1, 10);           // colour planes
  header.writeUInt16LE(32, 12);          // bits per pixel
  header.writeUInt32LE(png256.length, 14);
  header.writeUInt32LE(header.length, 18); // offset of image data
  return Buffer.concat([header, png256]);
}

// ---------- Main ----------
fs.mkdirSync(OUT_DIR, { recursive: true });
const png512 = encodePng(512, draw(512));
const png256 = encodePng(256, draw(256));
fs.writeFileSync(path.join(OUT_DIR, "icon.png"), png512);
fs.writeFileSync(path.join(OUT_DIR, "icon.ico"), encodeIco(png256));
console.log(`make-icons: wrote icon.png (${png512.length} bytes, 512x512)`);
console.log(`make-icons: wrote icon.ico (${png256.length + 22} bytes, 256x256 PNG entry)`);
