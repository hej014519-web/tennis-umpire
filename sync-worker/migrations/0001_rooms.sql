CREATE TABLE rooms (
  id TEXT PRIMARY KEY NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  match_json TEXT NOT NULL CHECK (length(match_json) <= 1500000),
  title TEXT NOT NULL,
  court TEXT NOT NULL,
  edit_hash TEXT NOT NULL,
  view_hash TEXT NOT NULL,
  creation_rate_key TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE creation_receipts (
  request_id TEXT PRIMARY KEY NOT NULL,
  creator_hash TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE command_receipts (
  room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  base_version INTEGER NOT NULL,
  result_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (room_id, request_id)
);

CREATE TABLE creation_limits (
  key TEXT PRIMARY KEY NOT NULL,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX creation_limits_expiry ON creation_limits(expires_at);

-- D1 batch rolls back every statement when either guard aborts. A receipt
-- cannot commit without its matching CAS update, or spend quota on a replay.
CREATE TRIGGER room_creation_limit BEFORE INSERT ON rooms
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM creation_limits
    WHERE key = NEW.creation_rate_key AND count <= 10
  ) THEN RAISE(ABORT, 'CREATE_RATE_LIMIT') END;
END;

CREATE TRIGGER command_receipt_cas BEFORE INSERT ON command_receipts
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM rooms WHERE id = NEW.room_id AND version = NEW.base_version
  ) THEN RAISE(ABORT, 'ROOM_VERSION_CONFLICT') END;
  SELECT CASE WHEN NEW.result_version != NEW.base_version + 1
    THEN RAISE(ABORT, 'ROOM_VERSION_CONFLICT') END;
END;
