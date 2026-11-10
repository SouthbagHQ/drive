// Bearer auth (src/lib/server/bearer.ts): native-client access tokens validated
// fresh against Identity's userinfo endpoint, users upserted, fail closed on
// outage. node:sqlite + real migrations.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authenticateBearer } from '../src/lib/server/bearer.ts';

const METADATA = {
	issuer: 'http://identity.test',
	authorization_endpoint: 'http://identity.test/auth',
	token_endpoint: 'http://identity.test/token',
	userinfo_endpoint: 'http://identity.test/userinfo',
	registration_endpoint: 'http://identity.test/register'
};

function d1Shim(db) {
	const prepare = (sql) => ({
		bind(...params) {
			this.params = params;
			return this;
		},
		async first() {
			return db.prepare(sql).get(...(this.params || [])) ?? null;
		},
		async all() {
			return { results: db.prepare(sql).all(...(this.params || [])) };
		},
		async run() {
			const r = db.prepare(sql).run(...(this.params || []));
			return { meta: { changes: Number(r.changes) } };
		}
	});
	return { prepare };
}

function setup({ userinfo } = {}) {
	const db = new DatabaseSync(':memory:');
	for (const file of readdirSync('migrations').sort())
		db.exec(readFileSync('migrations/' + file, 'utf8'));
	const calls = [];
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (url, init) => {
		calls.push(String(url));
		if (String(url).endsWith('/.well-known/openid-configuration'))
			return new Response(JSON.stringify(METADATA), { status: 200 });
		if (String(url).endsWith('/userinfo')) return userinfo(init);
		throw new Error(`unexpected fetch ${url}`);
	};
	return {
		db,
		env: { DB: d1Shim(db), IDENTITY_ISSUER: 'http://identity.test' },
		calls,
		restore: () => {
			globalThis.fetch = originalFetch;
		}
	};
}

const goodUserinfo = (init) => {
	assert.equal(init.headers.authorization, 'Bearer good-token');
	return new Response(
		JSON.stringify({ sub: 'u1', email: 'u1@x.test', name: 'Ingo' }),
		{ status: 200 }
	);
};

test('no Authorization header is a no-op, no Identity call', async () => {
	const { env, calls, restore } = setup({ userinfo: goodUserinfo });
	try {
		assert.deepEqual(await authenticateBearer(env, null), { ok: false, reason: 'no_token' });
		assert.deepEqual(await authenticateBearer(env, 'Basic dTpw'), { ok: false, reason: 'no_token' });
		assert.equal(calls.length, 0);
	} finally {
		restore();
	}
});

test('a good token authenticates and upserts the user', async () => {
	const { db, env, restore } = setup({ userinfo: goodUserinfo });
	try {
		const result = await authenticateBearer(env, 'Bearer good-token');
		assert.equal(result.ok, true);
		assert.deepEqual(result.user, { id: 'u1', email: 'u1@x.test', name: 'Ingo' });
		const row = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get('u1');
		assert.deepEqual({ ...row }, { id: 'u1', email: 'u1@x.test', name: 'Ingo' });
	} finally {
		restore();
	}
});

test('a repeat login refreshes the stored name and email', async () => {
	const { db, env, restore } = setup({
		userinfo: () =>
			new Response(JSON.stringify({ sub: 'u1', email: 'new@x.test', name: 'Kevin' }), {
				status: 200
			})
	});
	try {
		db.prepare("INSERT INTO users (id, email, name, created_at) VALUES ('u1', 'old@x.test', 'Old', 0)").run();
		const result = await authenticateBearer(env, 'Bearer good-token');
		assert.equal(result.ok, true);
		assert.equal(result.user.email, 'new@x.test');
		const row = db.prepare('SELECT email, name FROM users WHERE id = ?').get('u1');
		assert.deepEqual({ ...row }, { email: 'new@x.test', name: 'Kevin' });
	} finally {
		restore();
	}
});

test('Identity saying 401 means invalid token, not an outage', async () => {
	const { env, restore } = setup({
		userinfo: () => new Response('invalid_token', { status: 401 })
	});
	try {
		assert.deepEqual(await authenticateBearer(env, 'Bearer bad-token'), {
			ok: false,
			reason: 'invalid_token'
		});
	} finally {
		restore();
	}
});

test('Identity unreachable fails closed as unavailable', async () => {
	const { env, restore } = setup({
		userinfo: () => {
			throw new Error('connection refused');
		}
	});
	try {
		assert.deepEqual(await authenticateBearer(env, 'Bearer good-token'), {
			ok: false,
			reason: 'identity_unavailable'
		});
	} finally {
		restore();
	}
});

test('a userinfo 500 is an outage, not an invalid token', async () => {
	const { env, restore } = setup({
		userinfo: () => new Response('boom', { status: 500 })
	});
	try {
		assert.deepEqual(await authenticateBearer(env, 'Bearer good-token'), {
			ok: false,
			reason: 'identity_unavailable'
		});
	} finally {
		restore();
	}
});

test('userinfo without a sub fails closed', async () => {
	const { env, restore } = setup({
		userinfo: () => new Response(JSON.stringify({ email: 'u1@x.test' }), { status: 200 })
	});
	try {
		assert.deepEqual(await authenticateBearer(env, 'Bearer good-token'), {
			ok: false,
			reason: 'identity_unavailable'
		});
	} finally {
		restore();
	}
});
