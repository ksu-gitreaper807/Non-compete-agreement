// web-ext configuration (auto-discovered from the project root).
// `web-ext sign` rebuilds the submission zip from sourceDir itself, so ignoreFiles
// is derived from scripts/package.mjs's INCLUDE allowlist: every root entry that
// is NOT shipped in dist/ is excluded here. There is a single source of truth
// for "what goes into the extension" — this file just inverts it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INCLUDE } from './scripts/package.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));

const ignoreFiles = [
  '**/.DS_Store',
  '**/*.map',
  'models/README.md', // dev-only doc inside an otherwise shipped directory
];
for (const entry of fs.readdirSync(root)) {
  if (INCLUDE.includes(entry)) continue;
  const stat = fs.statSync(path.join(root, entry));
  // Directories need a globstar: a bare "tests" would not match "tests/unit/x.mjs".
  ignoreFiles.push(stat.isDirectory() ? `${entry}/**` : entry);
}

export default {
  sourceDir: './',
  // Signed .xpi downloads land here (gitignored), next to nothing else:
  // dist/ holds local unsigned builds, web-ext-artifacts/ holds Mozilla-signed files.
  artifactsDir: './web-ext-artifacts',
  ignoreFiles,
  build: {
    overwriteDest: true,
  },
  sign: {
    // Self-distribution default: AMO signs the package and hands back an .xpi
    // you can host anywhere. Use `npm run sign:listed` (passes --channel=listed,
    // which overrides this) for a public addons.mozilla.org listing.
    channel: 'unlisted',
  },
};
