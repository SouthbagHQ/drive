// Pure WebDAV helpers — no SvelteKit, no D1. Safe to unit-test in Node.

export const WEBDAV_ROOT = '/webdav';

export const WEBDAV_METHODS =
	'OPTIONS, GET, HEAD, PUT, DELETE, PROPFIND, PROPPATCH, COPY, MOVE, MKCOL, LOCK, UNLOCK';

export type WebdavTarget =
	| { type: 'collection' }
	| { type: 'file'; name: string }
	| { type: 'nested' };

export function xmlEscape(value: string): string {
	// Element text, not attributes: quotes stay quotes so getetag matches the
	// ETag header (Windows is picky about that).
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export function webdavHref(name?: string): string {
	if (!name) return `${WEBDAV_ROOT}/`;
	return `${WEBDAV_ROOT}/${encodeURIComponent(name)}`;
}

export function parseWebdavPath(pathParam: string | undefined): WebdavTarget {
	if (!pathParam) return { type: 'collection' };
	const trimmed = pathParam.replace(/^\/+|\/+$/g, '');
	if (!trimmed) return { type: 'collection' };
	const segments = trimmed.split('/').filter((part) => part.length > 0);
	if (segments.some((part) => part === '.' || part === '..')) return { type: 'nested' };
	if (segments.length === 1) return { type: 'file', name: segments[0] };
	return { type: 'nested' };
}

export function parseDestination(dest: string | null, origin: string): WebdavTarget | null {
	if (!dest) return null;
	let url: URL;
	try {
		url = dest.startsWith('/') ? new URL(dest, origin) : new URL(dest);
	} catch {
		return null;
	}
	let allowed: URL;
	try {
		allowed = new URL(origin);
	} catch {
		return null;
	}
	if (url.host !== allowed.host) return null;
	const pathname = url.pathname;
	if (pathname !== WEBDAV_ROOT && !pathname.startsWith(`${WEBDAV_ROOT}/`)) return null;
	const rest = pathname.slice(WEBDAV_ROOT.length).replace(/^\/+/, '');
	return parseWebdavPath(rest || undefined);
}

export function parseDepth(header: string | null): 0 | 1 {
	if (header === '0') return 0;
	return 1;
}

export function parseOverwrite(header: string | null): boolean {
	return header?.trim().toUpperCase() !== 'F';
}

export function parseBasicAuth(
	header: string | null
): { username: string; password: string } | null {
	if (!header) return null;
	const match = header.match(/^Basic\s+(\S+)/i);
	if (!match) return null;
	try {
		const bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
		const decoded = new TextDecoder().decode(bytes);
		const colon = decoded.indexOf(':');
		if (colon < 0) return null;
		return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
	} catch {
		return null;
	}
}

export function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function formatHttpDate(ms: number): string {
	return new Date(ms).toUTCString();
}

export function formatCreationDate(ms: number): string {
	return new Date(ms).toISOString();
}

export function fileEtag(id: string, size: number, createdAt: number): string {
	return `"${id}-${size}-${createdAt}"`;
}

export interface ByteRange {
	start: number;
	end: number;
}

/** Inclusive start/end. Null means ignore the Range header (send the whole file). */
export function parseByteRange(header: string | null, size: number): ByteRange | 'unsatisfiable' | null {
	if (!header || size <= 0) return null;
	const match = header.match(/^bytes=(\d*)-(\d*)$/i);
	if (!match) return null;
	const hasStart = match[1] !== '';
	const hasEnd = match[2] !== '';
	if (!hasStart && !hasEnd) return 'unsatisfiable';
	if (!hasStart) {
		const suffix = Number(match[2]);
		if (!Number.isInteger(suffix) || suffix <= 0) return 'unsatisfiable';
		if (suffix >= size) return { start: 0, end: size - 1 };
		return { start: size - suffix, end: size - 1 };
	}
	const start = Number(match[1]);
	if (!Number.isInteger(start) || start < 0 || start >= size) return 'unsatisfiable';
	const end = hasEnd ? Number(match[2]) : size - 1;
	if (!Number.isInteger(end) || end < start) return 'unsatisfiable';
	return { start, end: Math.min(end, size - 1) };
}

export interface DavResource {
	href: string;
	name: string;
	collection: boolean;
	size?: number;
	contentType?: string;
	createdAt?: number;
	etag?: string;
}

export function buildPropfindXml(resources: DavResource[]): string {
	const responses = resources
		.map((resource) => {
			const modified = formatHttpDate(resource.createdAt ?? 0);
			const created = formatCreationDate(resource.createdAt ?? 0);
			const live = resource.collection
				? `<D:resourcetype><D:collection/></D:resourcetype>
<D:displayname>${xmlEscape(resource.name)}</D:displayname>
<D:getlastmodified>${modified}</D:getlastmodified>
<D:creationdate>${created}</D:creationdate>
<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>`
				: `<D:resourcetype/>
<D:displayname>${xmlEscape(resource.name)}</D:displayname>
<D:getcontentlength>${resource.size ?? 0}</D:getcontentlength>
<D:getcontenttype>${xmlEscape(resource.contentType ?? 'application/octet-stream')}</D:getcontenttype>
<D:getlastmodified>${modified}</D:getlastmodified>
<D:creationdate>${created}</D:creationdate>
<D:getetag>${xmlEscape(resource.etag ?? '')}</D:getetag>
<D:supportedlock><D:lockentry><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype></D:lockentry></D:supportedlock>`;
			return `<D:response>
<D:href>${xmlEscape(resource.href)}</D:href>
<D:propstat>
<D:prop>
${live}
</D:prop>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>`;
		})
		.join('');
	return `<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">${responses}</D:multistatus>`;
}

export function buildProppatchXml(href: string): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<D:multistatus xmlns:D="DAV:">
<D:response>
<D:href>${xmlEscape(href)}</D:href>
<D:propstat>
<D:prop/>
<D:status>HTTP/1.1 200 OK</D:status>
</D:propstat>
</D:response>
</D:multistatus>`;
}

export function buildLockXml(href: string, token: string, owner = 'Kevin'): string {
	return `<?xml version="1.0" encoding="utf-8"?>
<D:prop xmlns:D="DAV:">
<D:lockdiscovery>
<D:activelock>
<D:locktype><D:write/></D:locktype>
<D:lockscope><D:exclusive/></D:lockscope>
<D:depth>0</D:depth>
<D:owner>${xmlEscape(owner)}</D:owner>
<D:timeout>Second-3600</D:timeout>
<D:locktoken><D:href>${xmlEscape(token)}</D:href></D:locktoken>
<D:lockroot><D:href>${xmlEscape(href)}</D:href></D:lockroot>
</D:activelock>
</D:lockdiscovery>
</D:prop>`;
}

export function davHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		DAV: '1, 2',
		'MS-Author-Via': 'DAV',
		Allow: WEBDAV_METHODS,
		...extra
	};
}

export function isWebdavPath(pathname: string): boolean {
	return pathname === WEBDAV_ROOT || pathname.startsWith(`${WEBDAV_ROOT}/`);
}

export function webdavMethod(request: Request): string {
	const override =
		request.headers.get('X-HTTP-Method-Override') ?? request.headers.get('X-HTTP-Method');
	return (override || request.method).trim().toUpperCase();
}
