#!/usr/bin/env node
// npm runs `prepare` when installing from git (npx -y github:subsets-ai/...),
// where there is no published dist/. Build once if it's missing; no-op on a
// normal checkout so `npm ci` in CI/dev doesn't double-build.
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!existsSync(join(root, 'dist', 'bin.js')) || !existsSync(join(root, 'dist', 'frontend', 'index.html'))) {
  execSync('npm run build', { cwd: root, stdio: 'inherit' });
}
