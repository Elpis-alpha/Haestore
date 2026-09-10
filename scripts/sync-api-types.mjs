#!/usr/bin/env node
/**
 * Regenerates the frontend's API types from the backend's OpenAPI document.
 *
 *   node scripts/sync-api-types.mjs        (or: npm run sync:types)
 *
 * The backend owns the contract: Zod schemas describe every request and response and
 * emit `back-end/openapi.json`. This turns that into a committed `.d.ts` in the
 * frontend, so the two repos stay independently buildable — which a workspace with a
 * `file:../shared` dependency would prevent, and Cloudflare requires. See ADR-001.
 *
 * CI fails if the committed output differs from a fresh run, so drift cannot pass
 * review quietly.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const spec = join(root, 'back-end', 'openapi.json');
const out = join(root, 'front-end', 'src', 'lib', 'api', 'schema.d.ts');

if (!existsSync(spec)) {
  console.error(
    `\nNo OpenAPI document at back-end/openapi.json.\n` +
      `Generate it first:  npm --prefix back-end run openapi\n` +
      `(That script arrives in Phase 2, with the first real endpoints.)\n`,
  );
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });

execFileSync(
  'npx',
  ['--yes', 'openapi-typescript@7', spec, '-o', out, '--root-types', '--alphabetize'],
  { stdio: 'inherit', cwd: root },
);

console.log(`\nWrote ${out.replace(root + '/', '')}`);
console.log('Commit it in the front-end repo so CI sees the same contract.\n');
