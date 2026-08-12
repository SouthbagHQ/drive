-- Persist dynamically registered OIDC credentials so each deployment registers once.
CREATE TABLE oidc_clients (
	issuer TEXT NOT NULL,
	origin TEXT NOT NULL,
	nonce TEXT NOT NULL,
	client_id TEXT,
	client_secret TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (issuer, origin)
);
