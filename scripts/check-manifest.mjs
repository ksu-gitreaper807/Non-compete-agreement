#!/usr/bin/env node
/**
 * Static sanity checks: manifest parses, every referenced file exists,
 * scripts import resolvable modules, versions stay in sync.
 *
 * Usable as a CLI (`node scripts/check-manifest.mjs`) or imported
 * (`import { checkManifest } from './check-manifest.mjs'`) — scripts/package.mjs
 * runs it before building so a broken tree can never be packaged.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function checkManifest(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const problems = [];
  const exists = (p) => fs.existsSync(path.join(root, p));
  const check = (p, why) => { if (!exists(p)) problems.push(`${why}: missing ${p}`); };

  for (const s of manifest.background?.scripts ?? []) check(s, 'background');
  check(manifest.action?.default_popup, 'popup');
  check(manifest.options_ui?.page, 'options');
  for (const icon of Object.values({ ...manifest.icons, ...manifest.action?.default_icon })) check(icon, 'icon');
  for (const p of ['blocking/blocked.html', 'vendor/transformers.min.js', 'vendor/ort/ort-wasm-simd.wasm', 'vendor/ort/ort-wasm.wasm', 'models/bge-small-en-v1.5/config.json', 'models/bge-small-en-v1.5/tokenizer.json', 'models/bge-small-en-v1.5/tokenizer_config.json', 'models/bge-small-en-v1.5/onnx/model_quantized.onnx']) check(p, 'runtime asset');

  // Resolve relative imports in all first-party ES modules.
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return ['node_modules', 'vendor', 'models', '.git'].includes(d.name) ? [] : walk(p);
    return /\.(m?js)$/.test(d.name) ? [p] : [];
  });
  for (const file of walk(root)) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), m[1]);
      if (!fs.existsSync(target)) problems.push(`${path.relative(root, file)}: unresolved import ${m[1]}`);
    }
  }
  // HTML script references
  for (const html of ['popup/popup.html', 'options/options.html', 'blocking/blocked.html']) {
    const src = fs.readFileSync(path.join(root, html), 'utf8');
    for (const m of src.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) check(path.join(path.dirname(html), m[1]), html);
  }
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("'wasm-unsafe-eval'")) problems.push("CSP must include 'wasm-unsafe-eval' for ONNX Runtime WebAssembly");

  // The .xpi/.zip filename and AMO version both come from manifest.json; package.json
  // must agree so releases, tags and docs never disagree about the version.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.version !== manifest.version) {
      problems.push(`version mismatch: manifest.json is ${manifest.version} but package.json is ${pkg.version}`);
    }
  } catch {
    problems.push('package.json: missing or unparsable');
  }

  // A stable add-on ID is required for signing (and for updates to reach existing installs).
  if (!manifest.browser_specific_settings?.gecko?.id) {
    problems.push('browser_specific_settings.gecko.id is required for Mozilla signing');
  }

  return { manifest, problems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { manifest, problems } = checkManifest();
  if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
  console.log(`manifest OK (${manifest.name} v${manifest.version})`);
}
