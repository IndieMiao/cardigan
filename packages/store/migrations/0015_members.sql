-- Human identities are global, like employees. Seeded in the migration transaction.
CREATE TABLE members (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('owner', 'approver', 'observer')),
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  doc TEXT NOT NULL CHECK (json_extract(doc, '$.id') = id
    AND json_extract(doc, '$.role') = role AND json_extract(doc, '$.status') = status)
);
CREATE UNIQUE INDEX members_active_owner ON members(role)
  WHERE role = 'owner' AND status = 'active';
CREATE TRIGGER members_keep_owner_update BEFORE UPDATE ON members
WHEN OLD.role = 'owner' AND OLD.status = 'active'
  AND (NEW.role != 'owner' OR NEW.status != 'active')
BEGIN SELECT RAISE(ABORT, 'must retain the active owner'); END;
CREATE TRIGGER members_keep_owner_delete BEFORE DELETE ON members
WHEN OLD.role = 'owner' AND OLD.status = 'active'
BEGIN SELECT RAISE(ABORT, 'must retain the active owner'); END;

ALTER TABLE web_sessions ADD COLUMN member_id TEXT REFERENCES members(id);
