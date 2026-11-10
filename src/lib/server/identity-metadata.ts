// OIDC discovery for Southbag Identity™ — extracted from oidc.ts so both the
// web login flow and the native-client bearer check share one cached,
// validated metadata lookup (and so the bearer check stays importable outside
// Vite's `$app` aliases, same constraint as office-storage.ts).

export interface OidcMetadata {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	userinfo_endpoint: string;
	registration_endpoint: string;
	end_session_endpoint?: string;
}

const metadataCache = new Map<string, Promise<OidcMetadata>>();

function validateMetadata(issuer: string, meta: OidcMetadata): OidcMetadata {
	// A 2xx response that parses as JSON is not necessarily valid discovery.
	// Reject a malformed doc so a partial/proxied response can't be cached for
	// the isolate's lifetime and brick every login with `new URL(undefined)`.
	if (meta.issuer !== issuer) {
		throw new Error(`OIDC issuer mismatch: expected ${issuer}, got ${meta.issuer}`);
	}
	for (const key of [
		'authorization_endpoint',
		'token_endpoint',
		'userinfo_endpoint',
		'registration_endpoint'
	] as const) {
		if (typeof meta[key] !== 'string' || !meta[key]) {
			throw new Error(`OIDC metadata missing ${key}`);
		}
	}
	return meta;
}

export function getMetadata(issuer: string): Promise<OidcMetadata> {
	let cached = metadataCache.get(issuer);
	if (!cached) {
		cached = fetch(`${issuer}/.well-known/openid-configuration`)
			.then(async (res) => {
				if (!res.ok) throw new Error(`Failed to fetch identity OIDC metadata: ${res.status}`);
				return validateMetadata(issuer, (await res.json()) as OidcMetadata);
			})
			.catch((err) => {
				metadataCache.delete(issuer); // allow retry on next call
				throw err;
			});
		metadataCache.set(issuer, cached);
	}
	return cached;
}
