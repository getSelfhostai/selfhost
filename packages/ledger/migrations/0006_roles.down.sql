-- Rolls back 0006_roles.sql. Roles stay in people.role; who last changed them is dropped.
DROP TRIGGER people_keep_an_owner ON people;
DROP FUNCTION people_keep_an_owner();
ALTER TABLE people DROP COLUMN role_changed_by;
ALTER TABLE people DROP COLUMN role_changed_at;
