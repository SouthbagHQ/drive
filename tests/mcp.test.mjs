// /mcp endpoint unit tests (src/lib/server/mcp.ts): protocol shape, agent-token auth, the $1
// request fee, freeze enforcement, and the crash-safety journal. node:sqlite + real migrations.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp, MCP_REQUEST_FEE_CENTS } from '../src/lib/server/mcp.ts';

function d1Shim(db) {
  const prepare = sql => ({
    bind(...params) {
      // D1 accepts ArrayBuffer blob binds; node:sqlite wants Uint8Array.
      this.params = params.map(p => (p instanceof ArrayBuffer ? new Uint8Array(p) : p));
      return this;
    },
    async first() { return db.prepare(sql).get(...(this.params || [])) ?? null; },
    async all() { return { results: db.prepare(sql).all(...(this.params || [])) }; },
    async run() {
      const r = db.prepare(sql).run(...(this.params || []));
      return { meta: { changes: Number(r.changes) } };
    },
  });
  return { prepare };
}

function setup(userId, { frozen = false, identityUnreachable = false } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const file of readdirSync('migrations').sort()) db.exec(readFileSync('migrations/' + file, 'utf8'));
  db.prepare("INSERT INTO users (id, email, name, created_at) VALUES (?, 'u1@x.test', 'Ingo', 0)").run(userId);
  db.prepare("INSERT INTO files (id, user_id, name, size, content_type, r2_key, created_at) VALUES ('f1', ?, 'plan.pdf', 1234, 'application/pdf', 'r2/f1', 5)").run(userId);
  const charges = [];
  const chargedKeys = new Map();
  const env = {
    DB: d1Shim(db),
    IDENTITY_INTERNAL_SECRET: 'bsec',
    IDENTITY_ISSUER: 'http://identity.test',
    BANKING: {
      async charge(input) {
        if (input.idempotencyKey && chargedKeys.get(input.idempotencyKey) === input.amount)
          return { balance: 12345, opened: false, duplicate: true };
        if (input.idempotencyKey) chargedKeys.set(input.idempotencyKey, input.amount);
        charges.push(input);
        return { balance: 12345, opened: false, duplicate: false };
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (identityUnreachable) throw new Error('connection refused');
    if (String(url).endsWith('/api/internal/agent-token')) {
      const token = JSON.parse(init.body).token;
      if (!String(token).startsWith('good-')) return new Response(JSON.stringify({ error: 'unknown_token' }), { status: 404 });
      return new Response(JSON.stringify({ tokenId: 'tok1', tokenName: 'test', userId, email: `${userId}@x.test`, name: 'Ingo' }), { status: 200 });
    }
    return new Response(JSON.stringify({ frozen }), { status: 200 });
  };
  return { db, env, charges, restore: () => { globalThis.fetch = originalFetch; } };
}

const post = (body, headers = {}) => new Request('https://drive.southbag.cc/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
const auth = { authorization: 'Bearer good-token-1' };
const key = { 'idempotency-key': 'test-key-0001' };
const journal = db => db.prepare('SELECT * FROM mcp_call').all();

test('initialize needs no auth; GET is 405; notifications are 202', async () => {
  const { env, restore } = setup('u1');
  const res = await handleMcp(post(rpc(1, 'initialize')), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).result.serverInfo.name, 'southbag-drive');
  assert.equal((await handleMcp(new Request('https://drive.southbag.cc/mcp'), env)).status, 405);
  assert.equal((await handleMcp(post({ jsonrpc: '2.0', method: 'notifications/initialized' }), env)).status, 202);
  restore();
});

test('tools/list is authenticated but free', async () => {
  const { env, charges, restore } = setup('u1');
  assert.equal((await handleMcp(post(rpc(1, 'tools/list')), env)).status, 401);
  const res = await handleMcp(post(rpc(2, 'tools/list'), auth), env);
  assert.deepEqual((await res.json()).result.tools.map(t => t.name), ['list_files', 'upload_text_file', 'get_storage']);
  assert.equal(charges.length, 0);
  restore();
});

test('tools/call list_files charges $1 and returns files with a receipt', async () => {
  const { db, env, charges, restore } = setup('u1');
  const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'list_files', arguments: {} }), { ...auth, ...key }), env);
  const body = await res.json();
  assert.equal(body.result.isError, false);
  assert.equal(body.result.structuredContent.files[0].name, 'plan.pdf');
  assert.equal(body.result.structuredContent.receipt.requestFee.amount, MCP_REQUEST_FEE_CENTS);
  assert.equal(charges[0].idempotencyKey, 'mcp|drive|request|u1|test-key-0001');
  assert.equal(journal(db)[0].status, 'done');
  const again = await handleMcp(post(rpc(2, 'tools/call', { name: 'list_files' }), { ...auth, ...key }), env);
  assert.equal((await again.json()).result.structuredContent.receipt.duplicate, true);
  assert.equal(charges.length, 1);
  restore();
});

test('get_storage returns counts', async () => {
  const { env, restore } = setup('u1');
  const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'get_storage' }), { ...auth, ...key }), env);
  const body = await res.json();
  assert.equal(body.result.structuredContent.files, 1);
  assert.equal(body.result.structuredContent.bytes, 1234);
  restore();
});

test('missing key refused; key reuse across tools or args is a caller bug', async () => {
  const { env, charges, restore } = setup('u1');
  assert.equal((await (await handleMcp(post(rpc(1, 'tools/call', { name: 'list_files' }), auth), env)).json()).error.code, -32602);
  await handleMcp(post(rpc(2, 'tools/call', { name: 'list_files', arguments: {} }), { ...auth, ...key }), env);
  assert.match((await (await handleMcp(post(rpc(3, 'tools/call', { name: 'get_storage' }), { ...auth, ...key }), env)).json()).error.message, /already used for 'list_files'/);
  assert.match((await (await handleMcp(post(rpc(4, 'tools/call', { name: 'list_files', arguments: { x: 1 } }), { ...auth, ...key }), env)).json()).error.message, /different arguments/);
  assert.equal(charges.length, 1);
  restore();
});

test('frozen and unknown both fail closed with no charge and no journal row', async () => {
  for (const opts of [{ frozen: true }, { identityUnreachable: true }]) {
    const { db, env, charges, restore } = setup('u1', opts);
    const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'list_files' }), { ...auth, ...key }), env);
    assert.ok([200, 503].includes(res.status));
    if (res.status === 200) assert.equal((await res.json()).result.isError, true);
    assert.equal(charges.length, 0);
    assert.equal(journal(db).length, 0);
    restore();
  }
});

test('a pending row is terminal: never re-run, then replays once the original lands', async () => {
  const { db, env, charges, restore } = setup('u1');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{"arguments":{},"name":"list_files"}'));
  const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
  db.prepare("INSERT INTO mcp_call (idempotency_key, user_id, tool, args_hash, status, created_at, updated_at) VALUES ('u1|test-key-0001', 'u1', 'list_files', ?, 'pending', ?, ?)")
    .run(hash, Date.now() - 120000, Date.now() - 120000);
  const retry = await handleMcp(post(rpc(1, 'tools/call', { name: 'list_files' }), { ...auth, ...key }), env);
  assert.equal((await retry.json()).result.structuredContent.unknownOutcome, true);
  assert.equal(charges.length, 0);
  const stored = { content: [{ type: 'text', text: '1 file.' }], isError: false, structuredContent: { receipt: { duplicate: false } } };
  db.prepare("UPDATE mcp_call SET status = 'done', response = ?, updated_at = ? WHERE idempotency_key = 'u1|test-key-0001'").run(JSON.stringify(stored), Date.now());
  const replay = await handleMcp(post(rpc(2, 'tools/call', { name: 'list_files' }), { ...auth, ...key }), env);
  assert.equal((await replay.json()).result.structuredContent.receipt.duplicate, true);
  assert.equal(charges.length, 0);
  restore();
});

test('upload_text_file stores via the shared path, charges only the $1 request fee, replays safely', async () => {
  const { db, env, charges, restore } = setup('u1');
  const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'upload_text_file', arguments: { name: 'notes.txt', content: 'Kevin was here.' } }), { ...auth, ...key }), env);
  const body = await res.json();
  assert.equal(body.result.isError, false);
  const file = body.result.structuredContent.file;
  assert.equal(file.name, 'notes.txt');
  assert.equal(file.size, 15);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].amount, 100);
  const row = db.prepare('SELECT * FROM files WHERE id = ?').get(file.id);
  assert.equal(row.content_type, 'text/plain; charset=utf-8');
  // A retry replays: no second file, no second charge.
  const res2 = await handleMcp(post(rpc(2, 'tools/call', { name: 'upload_text_file', arguments: { name: 'notes.txt', content: 'Kevin was here.' } }), { ...auth, ...key }), env);
  assert.equal((await res2.json()).result.structuredContent.receipt.duplicate, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM files').get().n, 1);
  assert.equal(charges.length, 1);
  restore();
});

test('upload_text_file validates BEFORE fees: missing name or content is a free rejection', async () => {
  const { db, env, charges, restore } = setup('u1');
  const res = await handleMcp(post(rpc(1, 'tools/call', { name: 'upload_text_file', arguments: { content: 'x' } }), { ...auth, ...key }), env);
  const body = await res.json();
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0].text, /No fees charged/);
  assert.equal(charges.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM mcp_call').get().n, 0);
  restore();
});
