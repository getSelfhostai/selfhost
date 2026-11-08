-- Basic roles: every person has exactly one role per team (people.role, from 0002_teams.sql).
-- This records who last changed it and when, and keeps an owner in every team that has people:
-- the server also checks it, under a lock on the team row, so this only catches a bug.
ALTER TABLE people ADD COLUMN role_changed_at timestamptz;
ALTER TABLE people ADD COLUMN role_changed_by text;

CREATE FUNCTION people_keep_an_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.role = 'owner' AND NEW.role <> 'owner' AND NOT EXISTS (
    SELECT 1 FROM people WHERE team_id = NEW.team_id AND role = 'owner'
  ) THEN
    RAISE EXCEPTION 'team % would have no owner', NEW.team_id
      USING ERRCODE = 'check_violation',
        HINT = 'Make someone else an owner first.';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER people_keep_an_owner
  AFTER UPDATE OF role ON people
  FOR EACH ROW EXECUTE FUNCTION people_keep_an_owner();
