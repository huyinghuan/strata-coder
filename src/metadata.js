import fs from 'node:fs';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
export const metadata = { name: pkg.name, version: pkg.version };
