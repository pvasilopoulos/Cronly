'use client';
import { useMemo, useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, fetcher } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtAgo, initials } from '@/lib/format';
import type { AdminTenant, AdminUser, AdminTenantMembers } from '@/lib/types';
import { Spinner, EmptyState } from '@/components/ui';

const PLANS = ['STARTER', 'PRO', 'SCALE', 'ENTERPRISE'] as const;
const TENANT_STATUSES = ['ACTIVE', 'TRIAL', 'SUSPENDED'] as const;
const USER_STATUSES = ['ACTIVE', 'INVITED', 'DISABLED'] as const;

const inputCls =
  'w-full rounded-lg border border-line bg-surface2 px-3 py-2 text-sm outline-none focus:border-accent';
const selectCls =
  'rounded-lg border border-line bg-surface2 px-2.5 py-2 text-sm outline-none focus:border-accent';

function planTone(plan: string) {
  switch (plan) {
    case 'ENTERPRISE': return 'bg-run/15 text-run';
    case 'SCALE': return 'bg-accent-soft text-accent-fg';
    case 'PRO': return 'bg-ok/15 text-ok';
    default: return 'bg-surface2 text-muted';
  }
}
function statusTone(status: string) {
  switch (status) {
    case 'ACTIVE': return 'bg-ok/15 text-ok';
    case 'TRIAL': case 'INVITED': return 'bg-warn/15 text-warn';
    case 'SUSPENDED': case 'DISABLED': return 'bg-err/15 text-err';
    default: return 'bg-surface2 text-muted';
  }
}
function Badge({ children, tone }: { children: React.ReactNode; tone: string }) {
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone}`}>
      {children}
    </span>
  );
}

export default function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<'tenants' | 'users'>('tenants');

  if (user && !user.isSuperAdmin) {
    return (
      <div className="mx-auto max-w-2xl">
        <EmptyState
          title="Platform console"
          hint="This area is restricted to platform super-admins."
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5">
        <h1 className="text-xl font-bold md:text-2xl">Platform Console</h1>
        <p className="text-sm text-muted">Manage every workspace, user, and membership on this instance</p>
      </header>

      <div className="mb-5 inline-flex rounded-lg border border-line bg-surface p-1">
        {(['tenants', 'users'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-md px-4 py-1.5 text-sm font-semibold ${
              tab === t ? 'bg-accent text-white' : 'text-muted hover:text-fg'
            }`}
          >
            {t === 'tenants' ? 'Workspaces' : 'Users'}
          </button>
        ))}
      </div>

      {tab === 'tenants' ? <TenantsTab /> : <UsersTab />}
    </div>
  );
}

/* ─────────────────────────── Workspaces ─────────────────────────── */

function TenantsTab() {
  const { data: tenants, isLoading } = useSWR<AdminTenant[]>('/admin/tenants', () =>
    fetcher<AdminTenant[]>('/admin/tenants'),
  );
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<AdminTenant | null>(null);
  const [creating, setCreating] = useState(false);
  const [managing, setManaging] = useState<AdminTenant | null>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (tenants ?? []).filter(
      (t) => !q || t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q) || t.plan.toLowerCase().includes(q),
    );
  }, [tenants, query]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search workspaces…"
          className={`${inputCls} max-w-xs`}
        />
        <span className="text-xs text-muted">{filtered.length} of {tenants?.length ?? 0}</span>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
        >
          ＋ New workspace
        </button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <EmptyState title="No workspaces" hint={query ? 'None match your search.' : 'Create the first workspace.'} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="px-4 py-3 font-semibold">Workspace</th>
                <th className="px-4 py-3 font-semibold">Plan</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Members</th>
                <th className="px-4 py-3 font-semibold">Jobs</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => (
                <tr key={t.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{t.name}</div>
                    <code className="font-mono text-[11px] text-faint">{t.slug}</code>
                  </td>
                  <td className="px-4 py-3"><Badge tone={planTone(t.plan)}>{t.plan}</Badge></td>
                  <td className="px-4 py-3"><Badge tone={statusTone(t.status)}>{t.status}</Badge></td>
                  <td className="px-4 py-3 text-sm text-muted">{t.counts.members}</td>
                  <td className="px-4 py-3 text-sm text-muted">{t.counts.jobs}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3 text-xs font-medium">
                      <button onClick={() => setManaging(t)} className="text-accent-fg hover:underline">Members</button>
                      <button onClick={() => setEditing(t)} className="text-accent-fg hover:underline">Edit</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(editing || creating) && (
        <TenantEditor tenant={editing} onClose={() => { setEditing(null); setCreating(false); }} />
      )}
      {managing && <MembersDrawer tenant={managing} onClose={() => setManaging(null)} />}
    </>
  );
}

function TenantEditor({ tenant, onClose }: { tenant: AdminTenant | null; onClose: () => void }) {
  const editing = !!tenant;
  const [name, setName] = useState(tenant?.name ?? '');
  const [slug, setSlug] = useState(tenant?.slug ?? '');
  const [plan, setPlan] = useState(tenant?.plan ?? 'STARTER');
  const [status, setStatus] = useState(tenant?.status ?? 'ACTIVE');
  const [timezone, setTimezone] = useState(tenant?.timezone ?? 'Europe/Athens');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    setBusy(true); setError(null);
    try {
      if (editing) {
        await api(`/admin/tenants/${tenant!.id}`, { method: 'PATCH', body: { name, plan, status, timezone } });
      } else {
        await api('/admin/tenants', { method: 'POST', body: { name, slug: slug || undefined, plan, timezone } });
      }
      globalMutate('/admin/tenants');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true); setError(null);
    try {
      await api(`/admin/tenants/${tenant!.id}`, { method: 'DELETE' });
      globalMutate('/admin/tenants');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? 'Edit workspace' : 'New workspace'} onClose={onClose}>
      <div className="flex flex-col gap-3 p-5">
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Retail" className={inputCls} autoFocus />
        </Field>
        <Field label="Slug" hint={editing ? 'Cannot be changed' : 'Lowercase, url-safe. Auto-derived from the name if left blank.'}>
          <input
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            placeholder="acme"
            disabled={editing}
            className={`${inputCls} ${editing ? 'opacity-60' : ''} font-mono`}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Plan">
            <select value={plan} onChange={(e) => setPlan(e.target.value)} className={`${selectCls} w-full`}>
              {PLANS.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </Field>
          {editing && (
            <Field label="Status">
              <select value={status} onChange={(e) => setStatus(e.target.value as AdminTenant['status'])} className={`${selectCls} w-full`}>
                {TENANT_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
          )}
          <Field label="Timezone">
            <input value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Europe/Athens" className={inputCls} />
          </Field>
        </div>
        {editing && (
          <p className="rounded-lg border border-line bg-surface2 px-3 py-2 text-xs text-muted">
            Changing the plan resets this workspace&apos;s feature gating to that plan&apos;s defaults.
          </p>
        )}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line p-4">
        <div className="min-w-0 flex-1">
          {error && <span className="text-xs text-err">{error}</span>}
        </div>
        <div className="flex items-center gap-2">
          {editing && !confirmDelete && (
            <button onClick={() => setConfirmDelete(true)} className="rounded-lg border border-err/40 px-3 py-2 text-sm font-medium text-err hover:bg-err/10">
              Delete
            </button>
          )}
          {editing && confirmDelete ? (
            <>
              <span className="text-xs text-err">Delete workspace and all its data?</span>
              <button onClick={() => setConfirmDelete(false)} className="rounded-lg border border-line px-3 py-2 text-sm font-medium">Cancel</button>
              <button onClick={remove} disabled={busy} className="rounded-lg bg-err px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">Cancel</button>
              <button onClick={save} disabled={busy || !name} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60">
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Create workspace'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

function MembersDrawer({ tenant, onClose }: { tenant: AdminTenant; onClose: () => void }) {
  const key = `/admin/tenants/${tenant.id}/members`;
  const { data, isLoading } = useSWR<AdminTenantMembers>(key, () => fetcher<AdminTenantMembers>(key));
  const { data: allUsers } = useSWR<AdminUser[]>('/admin/users', () => fetcher<AdminUser[]>('/admin/users'));
  const [userId, setUserId] = useState('');
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roles = data?.roles ?? [];
  // Existing users who are not already members of this workspace.
  const memberEmails = new Set((data?.members ?? []).map((m) => m.user?.email?.toLowerCase()).filter(Boolean));
  const available = useMemo(
    () => (allUsers ?? []).filter((u) => !memberEmails.has(u.email.toLowerCase())),
    [allUsers, data?.members],
  );
  const canSubmit = (!!userId || !!email) && roleIds.size > 0;

  function toggleRole(id: string) {
    setRoleIds((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function addMember() {
    if (!canSubmit) return;
    setBusy(true); setError(null);
    try {
      const body = userId
        ? { userId, roleIds: [...roleIds] }
        : { email, name: name || undefined, roleIds: [...roleIds] };
      await api(key, { method: 'POST', body });
      setUserId(''); setEmail(''); setName(''); setRoleIds(new Set());
      globalMutate(key);
      globalMutate('/admin/users');
      globalMutate('/admin/tenants');
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  async function removeMember(membershipId: string) {
    setError(null);
    try {
      await api(`${key}/${membershipId}`, { method: 'DELETE' });
      globalMutate(key);
      globalMutate('/admin/tenants');
    } catch (err: any) {
      setError(String(err?.message ?? err));
    }
  }

  async function setRoles(membershipId: string, ids: string[]) {
    if (ids.length === 0) return;
    setError(null);
    try {
      await api(`${key}/${membershipId}/roles`, { method: 'PATCH', body: { roleIds: ids } });
      globalMutate(key);
    } catch (err: any) {
      setError(String(err?.message ?? err));
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-lg flex-col border-l border-line bg-surface shadow-2xl">
        <div className="flex items-start justify-between border-b border-line p-5">
          <div>
            <h2 className="text-lg font-semibold">Members · {tenant.name}</h2>
            <code className="font-mono text-xs text-muted">{tenant.slug}</code>
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-xl text-faint hover:bg-surface2">×</button>
        </div>

        <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-5">
          {error && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}

          {/* Add member */}
          <div className="rounded-xl border border-line bg-surface2 p-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Add member</p>
            <div className="flex flex-col gap-2">
              {/* Pick an existing user… */}
              <select
                value={userId}
                onChange={(e) => { setUserId(e.target.value); if (e.target.value) { setEmail(''); setName(''); } }}
                className={inputCls}
              >
                <option value="">Choose an existing user…</option>
                {available.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} · {u.email}{u.isSuperAdmin ? ' (super-admin)' : ''}
                  </option>
                ))}
                {available.length === 0 && <option disabled>No other users available</option>}
              </select>

              {/* …or invite a new one by email. Hidden while an existing user is chosen. */}
              {!userId && (
                <>
                  <div className="flex items-center gap-2 text-[11px] text-faint">
                    <span className="h-px flex-1 bg-line" /> or invite by email <span className="h-px flex-1 bg-line" />
                  </div>
                  <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="email@company.com" className={inputCls} />
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name (for a new user)" className={inputCls} />
                </>
              )}
              <div className="flex flex-wrap gap-1.5">
                {roles.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => toggleRole(r.id)}
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      roleIds.has(r.id) ? 'bg-accent text-white' : 'border border-line text-muted hover:border-faint'
                    }`}
                  >
                    {r.name}
                  </button>
                ))}
              </div>
              <button
                onClick={addMember}
                disabled={busy || !canSubmit}
                className="self-start rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
              >
                {busy ? 'Adding…' : 'Add member'}
              </button>
              <p className="text-[11px] text-faint">
                Unknown emails create an invited user. Pick at least one role.
              </p>
            </div>
          </div>

          {/* Member list */}
          {isLoading ? (
            <Spinner />
          ) : (data?.members.length ?? 0) === 0 ? (
            <EmptyState title="No members yet" hint="Add the first member above." />
          ) : (
            <div className="flex flex-col gap-2">
              {data!.members.map((m) => (
                <div key={m.id} className="rounded-xl border border-line bg-surface p-3">
                  <div className="flex items-center gap-2.5">
                    <span className="grid h-7 w-7 flex-none place-items-center rounded-full border border-line bg-surface2 text-[11px] font-semibold">
                      {initials(m.user?.name ?? '?')}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <b className="truncate text-sm">{m.user?.name ?? '—'}</b>
                        {m.user?.isSuperAdmin && <Badge tone="bg-run/15 text-run">super-admin</Badge>}
                        <Badge tone={statusTone(m.status)}>{m.status}</Badge>
                      </div>
                      <span className="truncate text-[11px] text-faint">{m.user?.email}</span>
                    </div>
                    <button onClick={() => removeMember(m.id)} className="text-xs font-medium text-err hover:underline">Remove</button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {roles.map((r) => {
                      const on = m.roles.some((x) => x.id === r.id);
                      return (
                        <button
                          key={r.id}
                          onClick={() => {
                            const next = on ? m.roles.filter((x) => x.id !== r.id).map((x) => x.id) : [...m.roles.map((x) => x.id), r.id];
                            setRoles(m.id, next);
                          }}
                          className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                            on ? 'bg-accent-soft text-accent-fg' : 'border border-line text-faint hover:border-faint'
                          }`}
                        >
                          {on ? '✓ ' : ''}{r.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}

/* ───────────────────────────── Users ───────────────────────────── */

function UsersTab() {
  const { data: users, isLoading } = useSWR<AdminUser[]>('/admin/users', () => fetcher<AdminUser[]>('/admin/users'));
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [creating, setCreating] = useState(false);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (users ?? []).filter((u) => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q));
  }, [users, query]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search users…" className={`${inputCls} max-w-xs`} />
        <span className="text-xs text-muted">{filtered.length} of {users?.length ?? 0}</span>
        <button
          onClick={() => setCreating(true)}
          className="ml-auto rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
        >
          ＋ New user
        </button>
      </div>

      {isLoading ? (
        <Spinner />
      ) : filtered.length === 0 ? (
        <EmptyState title="No users" hint={query ? 'None match your search.' : 'Create the first user.'} />
      ) : (
        <div className="overflow-hidden rounded-xl border border-line bg-surface">
          <table className="w-full">
            <thead>
              <tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-faint">
                <th className="px-4 py-3 font-semibold">User</th>
                <th className="px-4 py-3 font-semibold">Status</th>
                <th className="px-4 py-3 font-semibold">Role</th>
                <th className="px-4 py-3 font-semibold">Workspaces</th>
                <th className="px-4 py-3 font-semibold">Created</th>
                <th className="px-4 py-3 font-semibold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((u) => (
                <tr key={u.id} className="border-b border-line last:border-0">
                  <td className="px-4 py-3">
                    <div className="font-medium">{u.name}</div>
                    <span className="text-[11px] text-faint">{u.email}</span>
                  </td>
                  <td className="px-4 py-3"><Badge tone={statusTone(u.status)}>{u.status}</Badge></td>
                  <td className="px-4 py-3">
                    {u.isSuperAdmin ? <Badge tone="bg-run/15 text-run">super-admin</Badge> : <span className="text-xs text-faint">—</span>}
                  </td>
                  <td className="px-4 py-3 text-sm text-muted">{u.memberships}</td>
                  <td className="px-4 py-3 text-sm text-muted whitespace-nowrap">{fmtAgo(u.createdAt)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end text-xs font-medium">
                      <button onClick={() => setEditing(u)} className="text-accent-fg hover:underline">Edit</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {(editing || creating) && <UserEditor user={editing} onClose={() => { setEditing(null); setCreating(false); }} />}
    </>
  );
}

function UserEditor({ user, onClose }: { user: AdminUser | null; onClose: () => void }) {
  const { user: me } = useAuth();
  const editing = !!user;
  const isSelf = editing && me?.id === user!.id;
  const [email, setEmail] = useState(user?.email ?? '');
  const [name, setName] = useState(user?.name ?? '');
  const [password, setPassword] = useState('');
  const [status, setStatus] = useState(user?.status ?? 'ACTIVE');
  const [isSuperAdmin, setIsSuperAdmin] = useState(user?.isSuperAdmin ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    setBusy(true); setError(null);
    try {
      if (editing) {
        const body: Record<string, unknown> = { name, status, isSuperAdmin };
        if (password) body.password = password;
        await api(`/admin/users/${user!.id}`, { method: 'PATCH', body });
      } else {
        await api('/admin/users', { method: 'POST', body: { email, name, password, isSuperAdmin } });
      }
      globalMutate('/admin/users');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true); setError(null);
    try {
      await api(`/admin/users/${user!.id}`, { method: 'DELETE' });
      globalMutate('/admin/users');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
      setBusy(false);
    }
  }

  return (
    <Modal title={editing ? 'Edit user' : 'New user'} onClose={onClose}>
      <div className="flex flex-col gap-3 p-5">
        <Field label="Email" hint={editing ? 'Cannot be changed' : undefined}>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="person@company.com"
            disabled={editing}
            className={`${inputCls} ${editing ? 'opacity-60' : ''}`}
            autoFocus={!editing}
          />
        </Field>
        <Field label="Name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" className={inputCls} autoFocus={editing} />
        </Field>
        <Field label={editing ? 'New password' : 'Password'} hint={editing ? 'Leave blank to keep the current password' : 'At least 8 characters'}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={editing ? '••••••••' : 'At least 8 characters'}
            className={inputCls}
          />
        </Field>
        {editing && (
          <Field label="Status">
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as AdminUser['status'])}
              disabled={isSelf}
              className={`${selectCls} w-full ${isSelf ? 'opacity-60' : ''}`}
            >
              {USER_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
          </Field>
        )}
        <label className={`flex items-center gap-2.5 rounded-lg border border-line bg-surface2 px-3 py-2.5 ${isSelf ? 'opacity-60' : 'cursor-pointer'}`}>
          <input
            type="checkbox"
            checked={isSuperAdmin}
            disabled={isSelf}
            onChange={(e) => setIsSuperAdmin(e.target.checked)}
            className="h-4 w-4 accent-accent"
          />
          <div>
            <span className="text-sm font-medium">Platform super-admin</span>
            <p className="text-[11px] text-faint">Full cross-tenant access. Grant only to your own staff.</p>
          </div>
        </label>
        {isSelf && <p className="text-[11px] text-faint">You cannot change your own role or status here.</p>}
      </div>

      <div className="flex items-center justify-between gap-2 border-t border-line p-4">
        <div className="min-w-0 flex-1">{error && <span className="text-xs text-err">{error}</span>}</div>
        <div className="flex items-center gap-2">
          {editing && !isSelf && !confirmDelete && (
            <button onClick={() => setConfirmDelete(true)} className="rounded-lg border border-err/40 px-3 py-2 text-sm font-medium text-err hover:bg-err/10">
              Delete
            </button>
          )}
          {editing && confirmDelete ? (
            <>
              <span className="text-xs text-err">Delete this user?</span>
              <button onClick={() => setConfirmDelete(false)} className="rounded-lg border border-line px-3 py-2 text-sm font-medium">Cancel</button>
              <button onClick={remove} disabled={busy} className="rounded-lg bg-err px-3 py-2 text-sm font-semibold text-white disabled:opacity-60">
                {busy ? 'Deleting…' : 'Delete'}
              </button>
            </>
          ) : (
            <>
              <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">Cancel</button>
              <button
                onClick={save}
                disabled={busy || !name || (!editing && (!email || password.length < 8))}
                className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
              >
                {busy ? 'Saving…' : editing ? 'Save changes' : 'Create user'}
              </button>
            </>
          )}
        </div>
      </div>
    </Modal>
  );
}

/* ───────────────────────────── shared ───────────────────────────── */

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center p-4">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <div className="relative flex max-h-[88vh] w-full max-w-lg flex-col rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="border-b border-line p-5"><h2 className="text-lg font-semibold">{title}</h2></div>
        <div className="flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-faint">{hint}</span>}
    </label>
  );
}
