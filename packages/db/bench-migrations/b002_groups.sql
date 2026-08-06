-- Up Migration
CREATE TABLE groups (
  id        UUID PRIMARY KEY,
  church_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name      TEXT NOT NULL
);
CREATE INDEX idx_groups_church_id ON groups (church_id);

CREATE TABLE group_members (
  group_id UUID NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
  user_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role     TEXT NOT NULL DEFAULT 'member' REFERENCES roles(role),
  PRIMARY KEY (group_id, user_id)
);
-- Reverse lookup: "which groups is this member in?" drives the feed direction.
CREATE INDEX idx_group_members_user_id ON group_members (user_id);

-- Down Migration
DROP TABLE IF EXISTS group_members;
DROP TABLE IF EXISTS groups;
