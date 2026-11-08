/**
 * JSON-array helpers.
 *
 * MySQL/MariaDB has no native array columns, so columns that were PostgreSQL
 * `text[]` / enum[] (Tenant.features, User.backupCodes, Job.tags, ApiKey.scopes,
 * AlertRule.onStatuses, NotificationPref.events, AppConfig.mobileNav) are stored
 * as JSON. Prisma types them as `JsonValue`, so reading them back needs a cast.
 *
 * Use `jsonArray()` at every read boundary to recover a typed string array. A
 * non-array value (a NULL, or anything unexpected) safely becomes `[]`, which
 * matches the old `@default([])` behaviour.
 */
export function jsonArray<T extends string = string>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((v) => typeof v === 'string') as T[]) : [];
}
