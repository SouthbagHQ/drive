// adapter-cloudflare writes the worker to wrangler's `main` and only exports
// the default fetch handler. Southbag Office™ binds to the named `OfficeStorage`
// entrypoint, so append that export after `vite build`; wrangler bundles the
// TypeScript import when it deploys.

import { readFileSync, writeFileSync } from 'node:fs';

const worker = '.svelte-kit/cloudflare/_worker.js';
const line = "export { OfficeStorage } from '../../src/lib/server/office-entrypoint.ts';\n";

const source = readFileSync(worker, 'utf8');
if (!source.includes(line)) writeFileSync(worker, `${source}\n${line}`);
console.log(`OfficeStorage entrypoint exported from ${worker}`);
