-- Ensure a role named "cronapp" exists and the connecting app role belongs to it.
--
-- The CronApp migrations grant privileges to a role literally named "cronapp"
-- (e.g. migration 7: GRANT cronapp_query TO cronapp; migrations 10/12 grant
-- table access to cronapp). When the database login role has a different name,
-- those statements fail ("role \"cronapp\" does not exist").
--
-- This creates "cronapp" as a NOLOGIN group role and makes the current login
-- role a member, so:
--   * GRANT ... TO cronapp succeeds, and
--   * the app role inherits those grants and can SET ROLE cronapp_query
--     (indirect membership: app_role -> cronapp -> cronapp_query).
-- No-op when the app role is already named "cronapp". Requires the CREATEROLE
-- attribute on the connecting role (granted once by a superuser).

DO $ensure_role$
DECLARE
  me text := current_user;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cronapp') THEN
    CREATE ROLE cronapp NOLOGIN;
  END IF;
  IF me <> 'cronapp' THEN
    EXECUTE format('GRANT cronapp TO %I', me);
  END IF;
END
$ensure_role$;
