#!/usr/bin/env node
/**
 * Builds dist/goalguard-<version>.zip containing only the files Firefox needs.
 * Pure Node (no `zip` binary required): writes a standard ZIP with deflate entries.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const include = ['manifest.json', 'src', 'popup', 'options', 'blocking', 'icons', 'vendor', 'models', 'LICENSE'];
const exclude = (rel) => rel.endsWith('.map') || path.basename(rel) === '.DS_Store' || rel === 'models/README.md';

function walk(rel, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, name), out);
  } else if (!exclude(rel)) {
    out.push(rel);
  }
}

// ---- minimal ZIP writer (PKZIP spec: local headers + central directory) ----------------------
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}
function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

function buildZip(files) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());
  for (const rel of files) {
    const data = fs.readFileSync(path.join(root, rel));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(rel, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(time), u16(date),
      u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0), name,
    ]);
    parts.push(local, body);
    central.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(time), u16(date),
      u32(crc), u32(body.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0),
      u32(0), u32(offset), name,
    ]));
    offset += local.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
    u32(centralBuf.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...parts, centralBuf, end]);
}

const files = [];
for (const entry of include) walk(entry, files);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `goalguard-${manifest.version}.zip`);
fs.writeFileSync(out, buildZip(files));
console.log(`Wrote ${path.relative(root, out)} (${files.length} files, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
