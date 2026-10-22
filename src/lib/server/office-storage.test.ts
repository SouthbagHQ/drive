import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	adoptOfficePackages,
	commitOfficeWorkspace,
	loadOfficeSnapshot,
	officeFileName,
	officeIndex,
	officeKindOf,
	type OfficeKind,
	type OfficeUpsert
} from './office-storage';
import { QUOTA_BYTES } from './files';

// Just enough of D1 over bun:sqlite to run the real migrations and queries.
function fakeD1(): D1Database {
	const sqlite = new Database(':memory:');
	sqlite.run('PRAGMA foreign_keys = ON');
	const dir = join(import.meta.dir, '../../../migrations');
	for (const name of readdirSync(dir).sort()) sqlite.exec(readFileSync(join(dir, name), 'utf8'));

	const toSql = (value: unknown) => (value instanceof ArrayBuffer ? new Uint8Array(value) : value);
	const statement = (sql: string, args: unknown[] = []) => ({
		bind: (...next: unknown[]) => statement(sql, next),
		first: async () => sqlite.query(sql).get(...(args.map(toSql) as [])) ?? null,
		all: async () => ({ results: sqlite.query(sql).all(...(args.map(toSql) as [])) }),
		run: async () => ({ meta: { changes: sqlite.query(sql).run(...(args.map(toSql) as [])).changes } }),
		raw: async () => [],
		sql,
		args
	});
	return {
		prepare: (sql: string) => statement(sql),
		batch: async (statements: ReturnType<typeof statement>[]) =>
			sqlite.transaction(() =>
				statements.map((s) => {
					const query = sqlite.query(s.sql);
					const args = s.args.map(toSql) as [];
					if (/^\s*select/i.test(s.sql)) return { results: query.all(...args), meta: { changes: 0 } };
					return { results: [], meta: { changes: query.run(...args).changes } };
				})
			)(),
		exec: async (sql: string) => sqlite.exec(sql)
	} as unknown as D1Database;
}

const kevin = { sub: 'kevin-sub', email: 'kevin@southbag.cc', name: 'Kevin' };
const codes: Record<OfficeKind, number> = { doc: 1, slides: 2, sheet: 3 };

function fakePackage(kind: OfficeKind, size = 64, fill = 7): Uint8Array {
	const bytes = new Uint8Array(size).fill(fill);
	bytes.set(new TextEncoder().encode('SOUTHBAG'));
	bytes[8] = 1;
	bytes[9] = codes[kind];
	return bytes;
}

function upsert(officeId: string, overrides: Partial<OfficeUpsert> = {}): OfficeUpsert {
	const kind = overrides.kind ?? 'doc';
	return {
		officeId,
		kind,
		title: 'Quarterly Kevin report',
		modified: '2026-10-22T00:00:00.000Z',
		bytes: fakePackage(kind),
		...overrides
	};
}

async function driveRows(db: D1Database) {
	const { results } = await db
		.prepare('SELECT id, name, office_id, share_token, content_type FROM files ORDER BY created_at')
		.all<{ id: string; name: string; office_id: string | null; share_token: string | null; content_type: string }>();
	return results;
}

describe('names and kinds', () => {
	test('recognises Office extensions case-insensitively', () => {
		expect(officeKindOf('Plan.southbagdocs')).toBe('doc');
		expect(officeKindOf('deck.SOUTHBAGSLIDES')).toBe('slides');
		expect(officeKindOf('money.southbagsheets')).toBe('sheet');
		expect(officeKindOf('swapfile')).toBeNull();
		expect(officeKindOf('notes.docx')).toBeNull();
	});

	test('forces the extension and keeps titles filename-safe', () => {
		expect(officeFileName('Q3 / Q4 plan', 'doc')).toBe('Q3 _ Q4 plan.southbagdocs');
		expect(officeFileName('   ', 'sheet')).toBe('unnamed.file.southbagsheets');
		expect(officeFileName('trailing dots...', 'slides')).toBe('trailing dots.southbagslides');
	});
});

describe('commitOfficeWorkspace', () => {
	test('first save creates the workspace and stores documents as Drive files', async () => {
		const db = fakeD1();
		const result = await commitOfficeWorkspace(db, kevin, {
			expectedRevision: 0,
			deletedIds: [],
			upserts: [upsert('doc-1'), upsert('sheet-1', { kind: 'sheet', title: 'Budget' })]
		});
		expect(result).toMatchObject({ ok: true, revision: 1, skipped: [] });
		const rows = await driveRows(db);
		expect(rows.map((row) => [row.name, row.office_id, row.content_type])).toEqual([
			['Quarterly Kevin report.southbagdocs', 'doc-1', 'application/vnd.southbag.docs'],
			['Budget.southbagsheets', 'sheet-1', 'application/vnd.southbag.sheets']
		]);

		const snapshot = await loadOfficeSnapshot(db, kevin);
		expect(snapshot.exists).toBe(true);
		expect(snapshot.packages.map((item) => item.officeId).sort()).toEqual(['doc-1', 'sheet-1']);
		expect(snapshot.packages[0].bytes).toEqual(fakePackage(snapshot.packages[0].kind));
	});

	test('stale revisions conflict', async () => {
		const db = fakeD1();
		await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: [], upserts: [upsert('doc-1')] });
		expect(
			await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: [], upserts: [] })
		).toEqual({ ok: false, reason: 'conflict', revision: 1 });
	});

	test('saving again replaces the Drive file in place and keeps its share link', async () => {
		const db = fakeD1();
		await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: [], upserts: [upsert('doc-1')] });
		await db.prepare("UPDATE files SET share_token = 'shared' WHERE office_id = 'doc-1'").run();
		const result = await commitOfficeWorkspace(db, kevin, {
			expectedRevision: 1,
			deletedIds: [],
			upserts: [upsert('doc-1', { title: 'Renamed', modified: '2026-10-23T00:00:00.000Z' })]
		});
		expect(result).toMatchObject({ ok: true, revision: 2 });
		const rows = await driveRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ name: 'Renamed.southbagdocs', office_id: 'doc-1', share_token: 'shared' });
		expect((await officeIndex(db, kevin)).entries).toEqual([
			{ driveFileId: rows[0].id, officeId: 'doc-1', modified: '2026-10-23T00:00:00.000Z' }
		]);
	});

	test('Office deletions tombstone and remove the Drive file without a second bump', async () => {
		const db = fakeD1();
		await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: [], upserts: [upsert('doc-1')] });
		const result = await commitOfficeWorkspace(db, kevin, { expectedRevision: 1, deletedIds: ['doc-1'], upserts: [] });
		expect(result).toMatchObject({ ok: true, revision: 2 });
		expect(await driveRows(db)).toEqual([]);
		expect((await officeIndex(db, kevin)).deletedIds).toEqual(['doc-1']);
	});

	test('tombstoned ids are never resurrected by a later upsert', async () => {
		const db = fakeD1();
		await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: ['doc-1'], upserts: [] });
		const result = await commitOfficeWorkspace(db, kevin, {
			expectedRevision: 1,
			deletedIds: [],
			upserts: [upsert('doc-1'), upsert('doc-2')]
		});
		expect(result).toMatchObject({ ok: true, skipped: ['doc-1'] });
		expect((await driveRows(db)).map((row) => row.office_id)).toEqual(['doc-2']);
	});

	test('rejects things that are not Office packages', async () => {
		const db = fakeD1();
		const notAPackage = upsert('doc-1', { bytes: new TextEncoder().encode('plaintext, sadly') });
		const wrongKind = upsert('doc-2', { bytes: fakePackage('sheet') });
		const pending = upsert('pending:doc-3');
		for (const bad of [notAPackage, wrongKind, pending]) {
			expect(
				await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: [], upserts: [bad] })
			).toMatchObject({ ok: false, reason: 'invalid' });
		}
		expect(await driveRows(db)).toEqual([]);
	});

	test('Office documents count against the 71.1 floppy quota', async () => {
		const db = fakeD1();
		await db
			.prepare('INSERT INTO users (id, email, name, created_at) VALUES (?, ?, ?, 0)')
			.bind(kevin.sub, kevin.email, kevin.name)
			.run();
		await db
			.prepare(
				"INSERT INTO files (id, user_id, name, size, content_type, r2_key, created_at) VALUES ('big', ?, 'swapfile', ?, 'x', 'big', 0)"
			)
			.bind(kevin.sub, QUOTA_BYTES - 10)
			.run();
		expect(
			await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: [], upserts: [upsert('doc-1')] })
		).toMatchObject({ ok: false, reason: 'storage_full' });
		expect((await driveRows(db)).map((row) => row.id)).toEqual(['big']);
	});

	test('multi-chunk packages round-trip', async () => {
		const db = fakeD1();
		const bytes = fakePackage('doc', 2_400_000, 3);
		await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: [], upserts: [upsert('doc-1', { bytes })] });
		const snapshot = await loadOfficeSnapshot(db, kevin);
		expect(snapshot.packages[0].bytes).toEqual(bytes);
	});
});

describe('deleting from Drive', () => {
	test('tombstones the document and bumps the Office revision', async () => {
		const db = fakeD1();
		await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: [], upserts: [upsert('doc-1')] });
		await db.prepare("DELETE FROM files WHERE office_id = 'doc-1'").run();
		const index = await officeIndex(db, kevin);
		expect(index).toMatchObject({ revision: 2, deletedIds: ['doc-1'], entries: [] });
	});

	test('ordinary files are none of Office’s business', async () => {
		const db = fakeD1();
		await commitOfficeWorkspace(db, kevin, { expectedRevision: 0, deletedIds: [], upserts: [] });
		await db
			.prepare(
				"INSERT INTO files (id, user_id, name, size, content_type, r2_key, created_at) VALUES ('swap', ?, 'swapfile', 1, 'x', 'swap', 0)"
			)
			.bind(kevin.sub)
			.run();
		await db.prepare("DELETE FROM files WHERE id = 'swap'").run();
		expect(await officeIndex(db, kevin)).toMatchObject({ revision: 1, deletedIds: [] });
	});
});

describe('adoptOfficePackages', () => {
	async function uploadedPackage(db: D1Database, id: string, name: string, kind: OfficeKind) {
		const bytes = fakePackage(kind);
		await db
			.prepare('INSERT OR IGNORE INTO users (id, email, name, created_at) VALUES (?, ?, ?, 0)')
			.bind(kevin.sub, kevin.email, kevin.name)
			.run();
		await db
			.prepare(
				"INSERT INTO files (id, user_id, name, size, content_type, r2_key, created_at) VALUES (?, ?, ?, ?, 'application/octet-stream', ?, 0)"
			)
			.bind(id, kevin.sub, name, bytes.byteLength, id)
			.run();
		await db
			.prepare('INSERT INTO file_chunks (file_id, chunk_index, data) VALUES (?, 0, ?)')
			.bind(id, bytes.buffer)
			.run();
	}

	test('packages uploaded to Drive show up unadopted, then join the workspace', async () => {
		const db = fakeD1();
		await uploadedPackage(db, 'upload-1', 'From WebDAV.southbagdocs', 'doc');
		await uploadedPackage(db, 'upload-2', 'not-office.txt', 'doc');

		const snapshot = await loadOfficeSnapshot(db, kevin);
		expect(snapshot.exists).toBe(false);
		expect(snapshot.packages.map((item) => [item.driveFileId, item.officeId, item.kind])).toEqual([
			['upload-1', null, 'doc']
		]);

		const adopted = await adoptOfficePackages(db, kevin, [
			{ driveFileId: 'upload-1', officeId: 'doc-new', modified: '2026-10-22T00:00:00.000Z' }
		]);
		expect(adopted).toMatchObject({ revision: 1, adopted: ['upload-1'] });
		expect((await officeIndex(db, kevin)).entries.map((entry) => entry.officeId)).toEqual(['doc-new']);

		// A second adoption of the same file is a no-op.
		expect(
			await adoptOfficePackages(db, kevin, [
				{ driveFileId: 'upload-1', officeId: 'doc-other', modified: '2026-10-22T00:00:00.000Z' }
			])
		).toMatchObject({ revision: 1, adopted: [] });
	});
});
