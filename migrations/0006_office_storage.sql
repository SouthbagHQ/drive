-- Migration number: 0006 	 office storage
-- Southbag Office™ keeps every document in Drive as an ordinary encrypted
-- .southbag* file. `office_id` ties the file to its Office document id;
-- `pending:<id>` marks a new version that is still being written.
ALTER TABLE files ADD COLUMN office_id TEXT;
ALTER TABLE files ADD COLUMN office_modified TEXT;
CREATE INDEX files_office_idx ON files (user_id, office_id);

-- The revision Office uses for optimistic concurrency, one row per user.
CREATE TABLE office_workspaces (
	user_id TEXT PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);

-- Deleted Office document ids. A tombstone always beats a file, so an old tab
-- can't resurrect something deleted from Office or from Drive.
CREATE TABLE office_tombstones (
	user_id TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	office_id TEXT NOT NULL,
	deleted_at TEXT NOT NULL,
	PRIMARY KEY (user_id, office_id)
);

-- Deleting the last Drive copy of an Office document (files page, WebDAV,
-- anything) tombstones it and bumps the revision so open Office tabs notice.
CREATE TRIGGER office_file_deleted AFTER DELETE ON files
WHEN OLD.office_id IS NOT NULL
	AND OLD.office_id NOT LIKE 'pending:%'
	AND EXISTS (SELECT 1 FROM users WHERE id = OLD.user_id)
	AND NOT EXISTS (SELECT 1 FROM files WHERE user_id = OLD.user_id AND office_id = OLD.office_id)
	AND NOT EXISTS (
		SELECT 1 FROM office_tombstones WHERE user_id = OLD.user_id AND office_id = OLD.office_id
	)
BEGIN
	INSERT INTO office_tombstones (user_id, office_id, deleted_at)
	VALUES (OLD.user_id, OLD.office_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
	UPDATE office_workspaces
	SET revision = revision + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
	WHERE user_id = OLD.user_id;
END;
