-- Migration number: 0001 	 init
CREATE TABLE users (
	id TEXT PRIMARY KEY, -- Southbag Identity `sub`
	email TEXT NOT NULL,
	name TEXT NOT NULL DEFAULT '',
	created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	created_at INTEGER NOT NULL,
	expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TABLE files (
	id TEXT PRIMARY KEY,
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	size INTEGER NOT NULL,
	content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
	r2_key TEXT NOT NULL,
	share_token TEXT,
	created_at INTEGER NOT NULL
);
CREATE INDEX files_user_idx ON files (user_id);
CREATE UNIQUE INDEX files_share_idx ON files (share_token);
