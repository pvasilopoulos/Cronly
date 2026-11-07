'use client';
import { useMemo, useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import type { PermissionDef, Role } from '@/lib/types';
import { Spinner, EmptyState } from '@/components/ui';

export default function RolesPage() {
  const { can, data: perms } = usePermissions();
  const { data: roles, isLoading } = useSWR<Role[]>('/roles', () => fetcher<Role[]>('/roles'));
  const [editing, setEditing] = useState<Role | null>(null);
  const [creating, setCreating] = useState(false);
  const catalog = perms?.catalog ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold md:text-2xl">Roles &amp; Permissions</h1>
          <p className="text-sm text-muted">Who can do what in this workspace</p>
        </div>
        {can('roles:manage') && (
          <button
            onClick={() => setCreating(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            ＋ New Role
          </button>
        )}
      </header>

      <div className="mb-4 rounded-xl border border-accent/30 bg-accent-soft/60 p-3 text-sm text-accent-fg">
        🔒 Permissions apply only within this tenant. Isolation is enforced at the database row level
        (RLS) — a bug in a query can never leak another client&apos;s data.
      </div>

      {isLoading ? (
        <Spinner />
      ) : !roles ? (
        <EmptyState title="No roles" />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {roles.map((r) => (
            <RoleCard
              key={r.id}
              role={r}
              catalog={catalog}
              canManage={can('roles:manage')}
              onEdit={() => setEditing(r)}
            />
          ))}
        </div>
      )}

      {(editing || creating) && (
        <RoleEditor
          role={editing}
          catalog={catalog}
          onClose={() => {
            setEditing(null);
            setCreating(false);
          }}
        />
      )}
    </div>
  );
}

function RoleCard({
  role,
  catalog,
  canManage,
  onEdit,
}: {
  role: Role;
  catalog: PermissionDef[];
  canManage: boolean;
  onEdit: () => void;
}) {
  const held = new Set(role.permissions.map((p) => p.permission));
  const byResource = groupByResource(catalog);
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="flex items-center gap-2 font-semibold">
          {role.name}
          {role.isSystem && (
            <span className="rounded bg-surface2 px-1.5 py-0.5 text-[10px] font-medium text-faint">
              system
            </span>
          )}
        </h3>
        {canManage && !role.isSystem && (
          <button onClick={onEdit} className="text-xs font-medium text-accent-fg hover:underline">
            Edit
          </button>
        )}
      </div>
      <p className="mb-3 text-xs text-faint">
        {role.description} · {role._count?.members ?? 0} member(s)
      </p>
      <div className="flex flex-col gap-2">
        {Object.entries(byResource).map(([resource, defs]) => {
          const on = defs.filter((d) => held.has(d.key)).length;
          return (
            <div key={resource} className="flex items-center justify-between text-xs">
              <span className="capitalize text-muted">{resource}</span>
              <span className={`font-mono ${on ? 'text-ok' : 'text-faint'}`}>
                {on}/{defs.length}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RoleEditor({
  role,
  catalog,
  onClose,
}: {
  role: Role | null;
  catalog: PermissionDef[];
  onClose: () => void;
}) {
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [selected, setSelected] = useState<Set<string>>(
    new Set(role?.permissions.map((p) => p.permission) ?? []),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byResource = useMemo(() => groupByResource(catalog), [catalog]);

  function toggle(key: string) {
    setSelected((s) => {
      const n = new Set(s);
      n.has(key) ? n.delete(key) : n.add(key);
      return n;
    });
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name, description, permissions: [...selected] };
      if (role) await api(`/roles/${role.id}`, { method: 'PATCH', body });
      else await api('/roles', { method: 'POST', body });
      globalMutate('/roles');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="border-b border-line p-5">
          <h2 className="text-lg font-semibold">{role ? 'Edit role' : 'New role'}</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <div className="mb-4 flex flex-col gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Role name"
              className="rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description"
              className="rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent"
            />
          </div>
          {Object.entries(byResource).map(([resource, defs]) => (
            <div key={resource} className="mb-3">
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">
                {resource}
              </p>
              <div className="flex flex-col gap-1">
                {defs.map((d) => (
                  <label key={d.key} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface2">
                    <input
                      type="checkbox"
                      checked={selected.has(d.key)}
                      onChange={() => toggle(d.key)}
                      className="h-4 w-4 accent-accent"
                    />
                    <span className="text-sm">{d.label}</span>
                    <code className="ml-auto font-mono text-[10px] text-faint">{d.key}</code>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line p-4">
          {error ? <span className="text-xs text-err">{error}</span> : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy || !name}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function groupByResource(catalog: PermissionDef[]): Record<string, PermissionDef[]> {
  const out: Record<string, PermissionDef[]> = {};
  for (const d of catalog) (out[d.resource] ??= []).push(d);
  return out;
}
