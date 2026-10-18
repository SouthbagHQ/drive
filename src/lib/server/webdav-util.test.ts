import { describe, expect, test } from 'bun:test';
import {
	WEBDAV_ROOT,
	buildPropfindXml,
	fileEtag,
	parseBasicAuth,
	parseByteRange,
	parseDepth,
	parseDestination,
	parseOverwrite,
	parseWebdavPath,
	timingSafeEqual,
	webdavHref,
	xmlEscape
} from './webdav-util';

describe('parseWebdavPath', () => {
	test('empty is the collection', () => {
		expect(parseWebdavPath(undefined)).toEqual({ type: 'collection' });
		expect(parseWebdavPath('')).toEqual({ type: 'collection' });
		expect(parseWebdavPath('/')).toEqual({ type: 'collection' });
	});

	test('a single segment is a file', () => {
		expect(parseWebdavPath('swapfile')).toEqual({ type: 'file', name: 'swapfile' });
		expect(parseWebdavPath('/swapfile/')).toEqual({ type: 'file', name: 'swapfile' });
	});

	test('nested paths are nested, not flattened', () => {
		expect(parseWebdavPath('dir/swapfile')).toEqual({ type: 'nested' });
		expect(parseWebdavPath('../etc/passwd')).toEqual({ type: 'nested' });
		expect(parseWebdavPath('foo/../bar')).toEqual({ type: 'nested' });
	});
});

describe('parseDestination', () => {
	const origin = 'https://drive.southbag.cc';

	test('accepts absolute URLs on this host', () => {
		expect(parseDestination('https://drive.southbag.cc/webdav/swapfile', origin)).toEqual({
			type: 'file',
			name: 'swapfile'
		});
	});

	test('accepts relative paths', () => {
		expect(parseDestination('/webdav/new-name', origin)).toEqual({
			type: 'file',
			name: 'new-name'
		});
	});

	test('rejects other hosts and non-webdav paths', () => {
		expect(parseDestination('https://evil.example/webdav/x', origin)).toBeNull();
		expect(parseDestination('https://drive.southbag.cc/files/x', origin)).toBeNull();
		expect(parseDestination(null, origin)).toBeNull();
	});
});

describe('headers and encoding', () => {
	test('xmlEscape', () => {
		expect(xmlEscape(`<swap & file>`)).toBe('&lt;swap &amp; file&gt;');
		expect(xmlEscape('"quoted"')).toBe('"quoted"');
	});

	test('webdavHref encodes names', () => {
		expect(webdavHref()).toBe(`${WEBDAV_ROOT}/`);
		expect(webdavHref('swap file')).toBe('/webdav/swap%20file');
	});

	test('depth defaults to 1 (infinity treated as 1; there is no tree)', () => {
		expect(parseDepth(null)).toBe(1);
		expect(parseDepth('0')).toBe(0);
		expect(parseDepth('1')).toBe(1);
		expect(parseDepth('infinity')).toBe(1);
	});

	test('overwrite defaults to true', () => {
		expect(parseOverwrite(null)).toBe(true);
		expect(parseOverwrite('T')).toBe(true);
		expect(parseOverwrite('F')).toBe(false);
		expect(parseOverwrite('f')).toBe(false);
	});

	test('basic auth splits on the first colon', () => {
		expect(parseBasicAuth('Basic ' + btoa('kevin@southbag.cc:sbdav_ab:cd'))).toEqual({
			username: 'kevin@southbag.cc',
			password: 'sbdav_ab:cd'
		});
		expect(parseBasicAuth('Bearer nope')).toBeNull();
		expect(parseBasicAuth(null)).toBeNull();
	});

	test('timingSafeEqual', () => {
		expect(timingSafeEqual('abc', 'abc')).toBe(true);
		expect(timingSafeEqual('abc', 'abd')).toBe(false);
		expect(timingSafeEqual('abc', 'ab')).toBe(false);
	});
});

describe('byte ranges', () => {
	test('parses start-end, open end, and suffix', () => {
		expect(parseByteRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
		expect(parseByteRange('bytes=8-', 10)).toEqual({ start: 8, end: 9 });
		expect(parseByteRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
	});

	test('rejects unsatisfiable ranges and ignores them on empty files', () => {
		expect(parseByteRange('bytes=10-12', 10)).toBe('unsatisfiable');
		expect(parseByteRange('bytes=0-1', 0)).toBeNull();
		expect(parseByteRange(null, 10)).toBeNull();
		expect(parseByteRange('items=1-2', 10)).toBeNull();
	});
});

describe('propfind xml', () => {
	test('includes collection and file live properties', () => {
		const xml = buildPropfindXml([
			{ href: '/webdav/', name: 'Southbag Drive', collection: true, createdAt: 0 },
			{
				href: '/webdav/swapfile',
				name: 'swapfile',
				collection: false,
				size: 4096,
				contentType: 'application/octet-stream',
				createdAt: 0,
				etag: fileEtag('abc', 4096, 0)
			}
		]);
		expect(xml).toContain('<D:collection/>');
		expect(xml).toContain('/webdav/swapfile');
		expect(xml).toContain('<D:getcontentlength>4096</D:getcontentlength>');
		expect(xml).toContain('HTTP/1.1 200 OK');
	});
});
