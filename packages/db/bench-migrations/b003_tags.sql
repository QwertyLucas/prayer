-- Up Migration
CREATE TABLE tags (
  id        UUID PRIMARY KEY,
  owner_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  church_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  name      TEXT NOT NULL
);
CREATE INDEX idx_tags_owner_id ON tags (owner_id);

CREATE TABLE tag_members (
  tag_id  UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (tag_id, user_id)
);
CREATE INDEX idx_tag_members_user_id ON tag_members (user_id);

-- Down Migration
DROP TABLE IF EXISTS tag_members;
DROP TABLE IF EXISTS tags;
