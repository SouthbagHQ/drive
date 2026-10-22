-- Migration number: 0005 	 webdav tokens
-- One access token per user. The plaintext is shown once; we store the hash.
CREATE TABLE webdav_tokens (
	user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
