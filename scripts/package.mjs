#!/usr/bin/env node
/**
 * Builds the distributable GoalGuard archives in dist/:
 *
 *   goalguard-<version>.zip   — upload this to addons.mozilla.org for signing
 *                                (also loadable via "Load Temporary Add-on…").
 *   goalguard-<version>.xpi   — byte-identical to the .zip. An .xpi IS a zip file
 *                                with a different extension; it is what Firefox
 *                                installs. Release-channel Firefox only accepts
 *                                .xpi files carrying a Mozilla signature, so the
 *                                file built here must go through signing first
 *                                (see docs/SIGNING.md) before it installs
 *                                permanently.
 *
 * Pure Node (no `zip` binary required): writes a standard ZIP with deflate entries.
 * Runs scripts/check-manifest.mjs first and aborts if the tree is invalid.
 *
 * Usage: node scripts/package.mjs [--format=zip|xpi|both] [--out-dir=dist]
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { checkManifest } from './check-manifest.mjs';

/**
 * Root entries shipped inside the extension. Everything else (tests, scripts,
 * docs, node_modules, …) is dev-only and stays out of the signed artifact.
 * web-ext-config.mjs imports this list so `web-ext sign` uploads exactly the
 * same file set — keep the packaging logic here, in one place.
 */
export const INCLUDE = ['manifest.json', 'src', 'popup', 'options', 'blocking', 'ledger', 'icons', 'vendor', 'models', 'LICENSE'];
export const exclude = (rel) => rel.endsWith('.map') || path.basename(rel) === '.DS_Store' || rel === 'models/README.md';

export function collectFiles(root, include = INCLUDE) {
  const out = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs).sort()) walk(path.posix.join(rel, name));
    } else if (!exclude(rel)) {
      out.push(rel);
    }
  };
  for (const entry of include) walk(entry);
  return out;
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

export function buildZip(root, files) {
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

function parseArgs(argv) {
  const opts = { format: 'both', outDir: 'dist' };
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node scripts/package.mjs [--format=zip|xpi|both] [--out-dir=dist]');
      process.exit(0);
    }
    const m = arg.match(/^--(format|out-dir)=(.+)$/);
    if (!m) { console.error(`Unknown argument: ${arg}`); process.exit(1); }
    if (m[1] === 'format' && !['zip', 'xpi', 'both'].includes(m[2])) {
      console.error(`--format must be zip, xpi or both (got "${m[2]}")`);
      process.exit(1);
    }
    opts[m[1] === 'out-dir' ? 'outDir' : 'format'] = m[2];
  }
  return opts;
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { format, outDir } = parseArgs(process.argv.slice(2));

  const { manifest, problems } = checkManifest(root);
  if (problems.length) {
    console.error(`Refusing to package: ${problems.length} problem(s):\n${problems.join('\n')}`);
    process.exit(1);
  }

  const files = collectFiles(root);
  const archive = buildZip(root, files);
  const exts = format === 'both' ? ['zip', 'xpi'] : [format];
  fs.mkdirSync(path.join(root, outDir), { recursive: true });
  for (const ext of exts) {
    const out = path.join(root, outDir, `goalguard-${manifest.version}.${ext}`);
    fs.writeFileSync(out, archive);
    console.log(`Wrote ${path.relative(root, out)} (${files.length} files, ${(fs.statSync(out).size / 1048576).toFixed(1)} MB)`);
  }
  if (format !== 'zip') {
    console.log('Note: the .xpi is not yet installable on release Firefox — it needs a Mozilla');
    console.log('signature first. See docs/SIGNING.md (one command: npm run sign).');
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
