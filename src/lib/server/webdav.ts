import {
	copyFileToName,
	deleteFileRow,
	fileBodyRange,
	getFileByName,
	listFiles,
	renameFile,
	sanitizeFileName,
	storeRequestBodyAsFile
} from './files';
import { capture, palantirOptions } from './palantir';
import {
	buildLockXml,
	buildPropfindXml,
	buildProppatchXml,
	davHeaders,
	fileEtag,
	parseByteRange,
	parseDepth,
	parseDestination,
	parseOverwrite,
	parseWebdavPath,
	webdavHref,
	webdavMethod,
	type DavResource
} from './webdav-util';

type EventLike = {
	request: Request;
	url: URL;
	params: { path?: string };
	locals: App.Locals;
	platform: App.Platform | undefined;
};

const XML = 'text/xml; charset="utf-8"';
const COLLECTION_CREATED_AT = 0;

function xml(body: string, status = 207, extra: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: davHeaders({ 'Content-Type': XML, ...extra })
	});
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
	return new Response(body, {
		status,
		headers: davHeaders({ 'Content-Type': 'text/plain; charset=utf-8', ...extra })
	});
}

function unauthorized(): Response {
	return text('WebDAV wants a token. Issue one from Files. Kevin is watching.', 401, {
		'WWW-Authenticate': 'Basic realm="Southbag Drive"'
	});
}

function notFound(): Response {
	return text('Not found.', 404);
}

function conflict(message: string): Response {
	return text(message, 409);
}

function forbidden(message: string): Response {
	return text(message, 403);
}

function storageFull(): Response {
	return text(
		'Southbag Drive™ provides exactly 71.1 floppy disks per account. Try deleting something.',
		507
	);
}

function resourceForCollection(): DavResource {
	return {
		href: webdavHref(),
		name: 'Southbag Drive',
		collection: true,
		createdAt: COLLECTION_CREATED_AT
	};
}

function resourceForFile(file: {
	id: string;
	name: string;
	size: number;
	content_type: string;
	created_at: number;
}): DavResource {
	return {
		href: webdavHref(file.name),
		name: file.name,
		collection: false,
		size: file.size,
		contentType: file.content_type,
		createdAt: file.created_at,
		etag: fileEtag(file.id, file.size, file.created_at)
	};
}

function uniqueNewestByName<T extends { name: string }>(files: T[]): T[] {
	const seen = new Set<string>();
	const out: T[] = [];
	for (const file of files) {
		if (seen.has(file.name)) continue;
		seen.add(file.name);
		out.push(file);
	}
	return out;
}

export async function handleWebdav(event: EventLike): Promise<Response> {
	const method = webdavMethod(event.request);
	if (method === 'OPTIONS') {
		return new Response(null, { status: 200, headers: davHeaders() });
	}

	if (!event.locals.user) return unauthorized();
	if (!event.platform) return text('Platform bindings unavailable.', 500);

	const { DB } = event.platform.env;
	const userId = event.locals.user.id;
	const palantir = palantirOptions(event.request, event.platform);
	const parsed = parseWebdavPath(event.params.path);
	const target =
		parsed.type === 'file' ? { type: 'file' as const, name: sanitizeFileName(parsed.name) } : parsed;
	const origin = event.platform.env.ORIGIN || event.url.origin;

	switch (method) {
		case 'PROPFIND':
			return propfind();
		case 'PROPPATCH':
			return proppatch();
		case 'GET':
		case 'HEAD':
			return getOrHead(method === 'HEAD');
		case 'PUT':
			return put();
		case 'DELETE':
			return remove();
		case 'MKCOL':
			capture('drive_webdav_mkcol_rejected', userId, {}, palantir);
			return forbidden('Where are folders? There are none.');
		case 'COPY':
			return copyOrMove(false);
		case 'MOVE':
			return copyOrMove(true);
		case 'LOCK':
			return lock();
		case 'UNLOCK':
			return new Response(null, { status: 204, headers: davHeaders() });
		default:
			return text(`${method} method not allowed.`, 405);
	}

	async function propfind(): Promise<Response> {
		const depth = parseDepth(event.request.headers.get('Depth'));
		if (target.type === 'nested') return notFound();
		if (target.type === 'collection') {
			const resources: DavResource[] = [resourceForCollection()];
			if (depth === 1) {
				const files = uniqueNewestByName(await listFiles(DB, userId));
				for (const file of files) resources.push(resourceForFile(file));
			}
			capture(
				'drive_webdav_propfind',
				userId,
				{ depth, collection: true, children: resources.length - 1 },
				palantir
			);
			return xml(buildPropfindXml(resources));
		}
		const file = await getFileByName(DB, userId, target.name);
		if (!file) return notFound();
		capture('drive_webdav_propfind', userId, { depth, collection: false, file_id: file.id }, palantir);
		return xml(buildPropfindXml([resourceForFile(file)]));
	}

	async function proppatch(): Promise<Response> {
		if (target.type === 'nested') return notFound();
		if (target.type === 'collection') return xml(buildProppatchXml(webdavHref()));
		const file = await getFileByName(DB, userId, target.name);
		if (!file) return notFound();
		return xml(buildProppatchXml(webdavHref(file.name)));
	}

	async function getOrHead(head: boolean): Promise<Response> {
		if (target.type === 'nested') return notFound();
		if (target.type === 'collection') {
			if (head) return new Response(null, { status: 200, headers: davHeaders() });
			const files = uniqueNewestByName(await listFiles(DB, userId));
			const listing = [
				'Southbag Drive™ WebDAV',
				'Folders: none.',
				'Swapfiles: a file named swapfile is still a file.',
				'',
				...files.map((file) => file.name)
			].join('\n');
			return text(listing, 200);
		}
		const file = await getFileByName(DB, userId, target.name);
		if (!file) return notFound();
		const etag = fileEtag(file.id, file.size, file.created_at);
		const inm = event.request.headers.get('If-None-Match');
		if (inm && inm.split(',').some((token) => token.trim() === etag || token.trim() === '*')) {
			return new Response(null, {
				status: 304,
				headers: davHeaders({ ETag: etag, 'Last-Modified': new Date(file.created_at).toUTCString() })
			});
		}

		const headers: Record<string, string> = {
			'Content-Type': file.content_type || 'application/octet-stream',
			ETag: etag,
			'Last-Modified': new Date(file.created_at).toUTCString(),
			'Accept-Ranges': 'bytes',
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'private, no-store'
		};

		const range = parseByteRange(event.request.headers.get('Range'), file.size);
		if (range === 'unsatisfiable') {
			return new Response(null, {
				status: 416,
				headers: davHeaders({ ...headers, 'Content-Range': `bytes */${file.size}` })
			});
		}

		const start = range?.start ?? 0;
		const end = range?.end ?? Math.max(0, file.size - 1);
		const length = file.size === 0 ? 0 : end - start + 1;
		headers['Content-Length'] = String(length);
		if (range) headers['Content-Range'] = `bytes ${start}-${end}/${file.size}`;

		if (!head) {
			capture(
				'drive_webdav_get',
				userId,
				{ file_id: file.id, size: file.size, ranged: Boolean(range) },
				palantir
			);
		}

		return new Response(head ? null : fileBodyRange(DB, file.id, file.size, start, end), {
			status: range ? 206 : 200,
			headers: davHeaders(headers)
		});
	}

	async function put(): Promise<Response> {
		if (target.type === 'collection') return conflict('PUT on the collection itself is not a file.');
		if (target.type === 'nested') {
			return conflict('Parent collection does not exist. Folders are not supported.');
		}

		const rawLength = event.request.headers.get('content-length');
		if (rawLength === null) {
			return text('Content-Length required. Even for swapfiles.', 411);
		}
		const declaredLength = Number(rawLength);
		if (!Number.isInteger(declaredLength) || declaredLength < 0) {
			return text('Content-Length required. Even for swapfiles.', 411);
		}

		const name = sanitizeFileName(target.name);
		const existing = await getFileByName(DB, userId, name);
		const contentType =
			event.request.headers.get('content-type')?.split(';')[0]?.trim().slice(0, 120) ||
			'application/octet-stream';

		const stored = await storeRequestBodyAsFile(DB, {
			userId,
			name,
			contentType,
			body: event.request.body,
			declaredLength,
			allowEmpty: true,
			replaceFileId: existing?.id ?? null
		});

		if (!stored.ok) {
			capture(
				'drive_webdav_put_rejected',
				userId,
				{ reason: stored.error, size: declaredLength, name_length: name.length },
				palantir
			);
			if (stored.error === 'storage_full' || stored.error === 'too_large') return storageFull();
			if (stored.error === 'empty_file') return text('Empty files cannot be uploaded.', 400);
			if (stored.error === 'size_mismatch') {
				return text(`size mismatch: declared ${stored.declared}, received ${stored.received}`, 400);
			}
			return text('Storage error.', 500);
		}

		capture(
			'drive_webdav_put',
			userId,
			{
				file_id: stored.id,
				size: stored.size,
				replaced: Boolean(existing),
				content_type: contentType
			},
			palantir
		);

		return new Response(null, {
			status: existing ? 204 : 201,
			headers: davHeaders({
				Location: webdavHref(name),
				ETag: fileEtag(stored.id, stored.size, Date.now())
			})
		});
	}

	async function remove(): Promise<Response> {
		if (target.type === 'collection') return forbidden('You cannot delete the drive.');
		if (target.type === 'nested') return notFound();
		const file = await getFileByName(DB, userId, target.name);
		if (!file) return notFound();
		await deleteFileRow(DB, userId, file.id);
		capture('drive_webdav_delete', userId, { file_id: file.id, size: file.size }, palantir);
		return new Response(null, { status: 204, headers: davHeaders() });
	}

	async function copyOrMove(move: boolean): Promise<Response> {
		if (target.type !== 'file') {
			return forbidden(move ? 'You cannot move the drive.' : 'You cannot copy the drive.');
		}
		const source = await getFileByName(DB, userId, target.name);
		if (!source) return notFound();

		const dest = parseDestination(event.request.headers.get('Destination'), origin);
		if (!dest) return text('Destination required, and it has to stay on this host.', 400);
		if (dest.type === 'collection') return conflict('Cannot overwrite the collection.');
		if (dest.type === 'nested') {
			return conflict('Parent collection does not exist. Folders are not supported.');
		}

		const destName = sanitizeFileName(dest.name);
		const overwrite = parseOverwrite(event.request.headers.get('Overwrite'));
		const existing = await getFileByName(DB, userId, destName);
		if (existing && existing.id === source.id) {
			return new Response(null, { status: 204, headers: davHeaders() });
		}
		if (existing && !overwrite) return text('Destination exists.', 412);

		if (move && destName) {
			if (!existing) {
				const ok = await renameFile(DB, userId, source.id, destName);
				if (!ok) return notFound();
				capture('drive_webdav_move', userId, { file_id: source.id }, palantir);
				return new Response(null, { status: 201, headers: davHeaders({ Location: webdavHref(destName) }) });
			}
			const copied = await copyFileToName(DB, userId, source, destName, existing.id);
			if (!copied) return storageFull();
			await deleteFileRow(DB, userId, source.id);
			capture('drive_webdav_move', userId, { file_id: copied.id, overwritten: true }, palantir);
			return new Response(null, { status: 204, headers: davHeaders({ Location: webdavHref(destName) }) });
		}

		const copied = await copyFileToName(DB, userId, source, destName, existing?.id ?? null);
		if (!copied) return storageFull();
		capture(
			'drive_webdav_copy',
			userId,
			{ file_id: copied.id, overwritten: Boolean(existing) },
			palantir
		);
		return new Response(null, {
			status: existing ? 204 : 201,
			headers: davHeaders({ Location: webdavHref(destName) })
		});
	}

	async function lock(): Promise<Response> {
		if (target.type === 'nested') return notFound();
		if (target.type === 'file') {
			const file = await getFileByName(DB, userId, target.name);
			if (!file) {
				// Windows often LOCK a name that does not exist yet, then PUT.
				// We mint a fake token anyway so the subsequent PUT can proceed.
			}
		}
		const href = target.type === 'file' ? webdavHref(target.name) : webdavHref();
		const token = `opaquelocktoken:${crypto.randomUUID()}`;
		return xml(buildLockXml(href, token, event.locals.user?.name || 'Kevin'), 200, {
			'Lock-Token': `<${token}>`
		});
	}
}
