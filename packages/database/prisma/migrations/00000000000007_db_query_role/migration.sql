-- Restricted read-only role for the `db.query` job handler.
--
-- PRIVILEGED BOOTSTRAP — apply as a superuser (e.g. `postgres`), not as the app
-- role: creating a role and granting role membership require CREATEROLE/ADMIN,
-- which the app role `cronapp` intentionally lacks. Same class as the initial
-- `cronapp` role setup.
--
-- The role may ONLY SELECT the tenant-scoped data tables (Job, JobRun) and is
-- NOBYPASSRLS, so Row-Level Security still fences it to the current tenant. The
-- worker does `SET LOCAL ROLE cronapp_query` inside a read-only transaction, so
-- a db.query job can never read other tables (Users, Secrets, …), write, or
-- escalate — even with a crafted SQL string.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cronapp_query') THEN
    CREATE ROLE cronapp_query NOLOGIN NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO cronapp_query;
GRANT SELECT ON "Job", "JobRun" TO cronapp_query;

-- Let the app role assume the restricted role via SET LOCAL ROLE.
GRANT cronapp_query TO cronapp;
