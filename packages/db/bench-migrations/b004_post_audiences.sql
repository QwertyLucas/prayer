-- Up Migration
-- Points at a SET, never at a person: adding someone to a tag never rewrites post rows.
-- Three nullable FKs + CHECK replaces a polymorphic (kind, id) pair so deletes cascade
-- and a row pointing at a nonexistent audience is impossible.
CREATE TABLE post_audiences (
  post_id   UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  church_id UUID NULL REFERENCES orgs(id) ON DELETE CASCADE,
  group_id  UUID NULL REFERENCES groups(id) ON DELETE CASCADE,
  tag_id    UUID NULL REFERENCES tags(id) ON DELETE CASCADE,
  CHECK (num_nonnulls(church_id, group_id, tag_id) = 1)
);

CREATE UNIQUE INDEX idx_post_audiences_unique
  ON post_audiences (post_id, COALESCE(church_id, group_id, tag_id));
CREATE INDEX idx_post_audiences_post_id ON post_audiences (post_id);
CREATE INDEX idx_post_audiences_group_id ON post_audiences (group_id) WHERE group_id IS NOT NULL;
CREATE INDEX idx_post_audiences_tag_id ON post_audiences (tag_id) WHERE tag_id IS NOT NULL;

-- Down Migration
DROP TABLE IF EXISTS post_audiences;
