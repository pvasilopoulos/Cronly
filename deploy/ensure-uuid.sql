-- Ensure a gen_random_uuid() function exists.
--
-- On PostgreSQL 13+ it is built in; on older servers (e.g. PG 12 on Ubuntu
-- 20.04) it ships only with the pgcrypto extension, which needs a superuser to
-- install. The CronApp migrations call gen_random_uuid(), so on such a server a
-- fresh migrate fails with "function gen_random_uuid() does not exist".
--
-- This defines a pure-SQL UUIDv4 generator in the public schema — something the
-- ordinary app/database role can create itself (no superuser, no extension).
-- It is created ONLY if no gen_random_uuid already exists, so it never shadows
-- the built-in (PG13+) or pgcrypto's C implementation when those are present.
-- Idempotent: safe to run on every deploy.

DO $ensure$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE proname = 'gen_random_uuid') THEN
    CREATE FUNCTION public.gen_random_uuid() RETURNS uuid
    LANGUAGE sql VOLATILE AS $fn$
      SELECT (
        lpad(to_hex((floor(random() * 4294967296))::bigint), 8, '0') || '-' ||
        lpad(to_hex((floor(random() * 65536))::int), 4, '0') || '-' ||
        '4' || lpad(to_hex((floor(random() * 4096))::int), 3, '0') || '-' ||
        substr('89ab', (floor(random() * 4))::int + 1, 1) ||
        lpad(to_hex((floor(random() * 4096))::int), 3, '0') || '-' ||
        lpad(to_hex((floor(random() * 281474976710656))::bigint), 12, '0')
      )::uuid;
    $fn$;
  END IF;
END
$ensure$;
