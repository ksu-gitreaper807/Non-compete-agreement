#!/usr/bin/env node
/** Builds dist/goalguard-<version>.zip containing only the files Firefox needs. */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const include = ['manifest.json', 'src', 'popup', 'options', 'blocking', 'icons', 'vendor', 'models', 'LICENSE'];
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = path.join(root, 'dist', `goalguard-${manifest.version}.zip`);
if (fs.existsSync(out)) fs.unlinkSync(out);
const existing = include.filter((p) => fs.existsSync(path.join(root, p)));
execSync(`zip -qr "${out}" ${existing.join(' ')} -x "*.map" -x "*/.DS_Store"`, { cwd: root, stdio: 'inherit' });
console.log(`Wrote ${path.relative(root, out)} (${Math.round(fs.statSync(out).size / 1048576)} MB)`);
