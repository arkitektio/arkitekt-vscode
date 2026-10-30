// The extension's version lives in its manifest: semantic-release decides it, this writes it.
import {readFileSync, writeFileSync} from 'node:fs';

const version = process.argv[2];
if (!version) throw new Error('usage: set-version.mjs <version>');
const path = new URL('../package.json', import.meta.url);
const manifest = JSON.parse(readFileSync(path, 'utf8'));
manifest.version = version;
writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
