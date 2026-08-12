CREATE TABLE file_chunks (
	file_id TEXT NOT NULL REFERENCES files (id) ON DELETE CASCADE,
	chunk_index INTEGER NOT NULL,
	data BLOB NOT NULL,
	PRIMARY KEY (file_id, chunk_index)
);
