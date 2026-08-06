-- Up Migration
CREATE TABLE roles (
  role TEXT PRIMARY KEY
);

CREATE TABLE role_permissions (
  role        TEXT NOT NULL REFERENCES roles(role) ON DELETE CASCADE,
  access_type TEXT NOT NULL,
  PRIMARY KEY (role, access_type)
);

INSERT INTO roles (role) VALUES ('leader'), ('helper'), ('member');

INSERT INTO role_permissions (role, access_type) VALUES
  ('leader', 'manage_members'),
  ('leader', 'hide_posts'),
  ('leader', 'post'),
  ('helper', 'post'),
  ('member', 'read');

-- Down Migration
DROP TABLE IF EXISTS role_permissions;
DROP TABLE IF EXISTS roles;
