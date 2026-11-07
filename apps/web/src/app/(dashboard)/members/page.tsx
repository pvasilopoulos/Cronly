'use client';
import { useMemo, useState } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { api, fetcher } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { initials } from '@/lib/format';
import type { Member, PermissionDef, Role } from '@/lib/types';
import { Spinner, EmptyState } from '@/components/ui';

export default function MembersPage() {
  const { can, data: perms } = usePermissions();
  const { data: members, isLoading } = useSWR<Member[]>('/members', () => fetcher<Member[]>('/members'));
  const { data: roles } = useSWR<Role[]>('/roles', () => fetcher<Role[]>('/roles'));
  const [editing, setEditing] = useState<Member | null>(null);
  const [inviting, setInviting] = useState(false);
  const catalog = perms?.catalog ?? [];

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold md:text-2xl">Members</h1>
          <p className="text-sm text-muted">People with access to this workspace</p>
        </div>
        {can('members:invite') && (
          <button
            onClick={() => setInviting(true)}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110"
          >
            ＋ Invite
          </button>
        )}
      </header>

      {isLoading ? (
        <Spinner />
      ) : !members || members.length === 0 ? (
        <EmptyState title="No members" />
      ) : (
        <div className="flex flex-col gap-3">
          {members.map((m) => (
            <div
              key={m.id}
              className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-surface p-4"
            >
              <span className="grid h-9 w-9 flex-none place-items-center rounded-full border border-line bg-surface2 text-xs font-semibold">
                {m.user ? initials(m.user.name) : '?'}
              </span>
              <div className="min-w-0">
                <div className="font-semibold">{m.user?.name ?? '—'}</div>
                <div className="truncate text-xs text-muted">{m.user?.email}</div>
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {m.roles.map((r) => (
                  <span
                    key={r.id}
                    className="rounded-full bg-accent-soft px-2.5 py-0.5 text-xs font-medium text-accent-fg"
                  >
                    {r.name}
                  </span>
                ))}
                {m.overrides.map((o) => (
                  <span
                    key={o.permission}
                    className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${
                      o.effect === 'GRANT' ? 'bg-ok/15 text-ok' : 'bg-err/15 text-err'
                    }`}
                    title={`${o.effect} ${o.permission}`}
                  >
                    {o.effect === 'GRANT' ? '+' : '−'}
                    {o.permission}
                  </span>
                ))}
              </div>
              {m.status === 'INVITED' && (
                <span className="rounded bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">
                  invited
                </span>
              )}
              {can('members:update') && (
                <button
                  onClick={() => setEditing(m)}
                  className="ml-auto rounded-md border border-line px-3 py-1.5 text-xs font-medium hover:border-faint"
                >
                  Manage access
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && roles && (
        <MemberEditor member={editing} roles={roles} catalog={catalog} onClose={() => setEditing(null)} />
      )}
      {inviting && roles && <InviteModal roles={roles} onClose={() => setInviting(false)} />}
    </div>
  );
}

type OverrideState = Record<string, 'INHERIT' | 'GRANT' | 'DENY'>;

function MemberEditor({
  member,
  roles,
  catalog,
  onClose,
}: {
  member: Member;
  roles: Role[];
  catalog: PermissionDef[];
  onClose: () => void;
}) {
  const [roleIds, setRoleIds] = useState<Set<string>>(new Set(member.roles.map((r) => r.id)));
  const [overrides, setOverrides] = useState<OverrideState>(() => {
    const o: OverrideState = {};
    for (const ov of member.overrides) o[ov.permission] = ov.effect;
    return o;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byResource = useMemo(() => {
    const out: Record<string, PermissionDef[]> = {};
    for (const d of catalog) (out[d.resource] ??= []).push(d);
    return out;
  }, [catalog]);

  function toggleRole(id: string) {
    setRoleIds((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  }
  function setOverride(key: string, val: 'INHERIT' | 'GRANT' | 'DENY') {
    setOverrides((o) => ({ ...o, [key]: val }));
  }

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/members/${member.id}/roles`, { method: 'PATCH', body: { roleIds: [...roleIds] } });
      const payload = Object.entries(overrides)
        .filter(([, v]) => v !== 'INHERIT')
        .map(([permission, effect]) => ({ permission, effect }));
      await api(`/members/${member.id}/overrides`, { method: 'PATCH', body: { overrides: payload } });
      globalMutate('/members');
      onClose();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50">
      <div className="absolute inset-0 bg-black/45" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-full max-w-lg flex-col border-l border-line bg-surface shadow-2xl">
        <div className="border-b border-line p-5">
          <h2 className="text-lg font-semibold">Manage access</h2>
          <p className="text-sm text-muted">{member.user?.name} · {member.user?.email}</p>
        </div>
        <div className="flex-1 overflow-y-auto p-5">
          <section className="mb-5">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-faint">Roles</p>
            <div className="flex flex-col gap-1">
              {roles.map((r) => (
                <label key={r.id} className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-surface2">
                  <input
                    type="checkbox"
                    checked={roleIds.has(r.id)}
                    onChange={() => toggleRole(r.id)}
                    className="h-4 w-4 accent-accent"
                  />
                  <span className="text-sm font-medium">{r.name}</span>
                  <span className="ml-auto text-[11px] text-faint">{r.description}</span>
                </label>
              ))}
            </div>
          </section>

          <section>
            <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">
              Per-user overrides
            </p>
            <p className="mb-2 text-xs text-muted">
              Fine-tune this one person without creating a role. <b>Deny</b> always wins over roles.
            </p>
            {Object.entries(byResource).map(([resource, defs]) => (
              <div key={resource} className="mb-3">
                <p className="mb-1 text-xs capitalize text-muted">{resource}</p>
                <div className="flex flex-col gap-1">
                  {defs.map((d) => (
                    <div key={d.key} className="flex items-center gap-2 rounded-md px-2 py-1">
                      <span className="flex-1 text-sm">{d.label}</span>
                      <TriToggle value={overrides[d.key] ?? 'INHERIT'} onChange={(v) => setOverride(d.key, v)} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </section>
        </div>
        <div className="flex items-center justify-between gap-2 border-t border-line p-4">
          {error ? <span className="text-xs text-err">{error}</span> : <span />}
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
              Cancel
            </button>
            <button
              onClick={save}
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function TriToggle({
  value,
  onChange,
}: {
  value: 'INHERIT' | 'GRANT' | 'DENY';
  onChange: (v: 'INHERIT' | 'GRANT' | 'DENY') => void;
}) {
  const opts: { v: 'INHERIT' | 'GRANT' | 'DENY'; label: string; cls: string }[] = [
    { v: 'INHERIT', label: 'Inherit', cls: 'text-faint' },
    { v: 'GRANT', label: 'Grant', cls: 'text-ok' },
    { v: 'DENY', label: 'Deny', cls: 'text-err' },
  ];
  return (
    <div className="flex overflow-hidden rounded-md border border-line text-[11px] font-medium">
      {opts.map((o) => (
        <button
          key={o.v}
          onClick={() => onChange(o.v)}
          className={`px-2 py-1 ${value === o.v ? `bg-surface2 ${o.cls}` : 'text-faint hover:bg-surface2'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function InviteModal({ roles, onClose }: { roles: Role[]; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState(roles[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/members/invite', { method: 'POST', body: { email, name, roleIds: [roleId] } });
      globalMutate('/members');
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
      <form onSubmit={submit} className="relative w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl">
        <h2 className="mb-4 text-lg font-semibold">Invite member</h2>
        <div className="flex flex-col gap-3">
          <input
            type="email"
            required
            placeholder="email@company.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
          />
          <input
            required
            placeholder="Full name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
          />
          <select
            value={roleId}
            onChange={(e) => setRoleId(e.target.value)}
            className="rounded-lg border border-line bg-surface2 px-3 py-2 outline-none focus:border-accent"
          >
            {roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
          {error && <p className="rounded-lg bg-err/10 px-3 py-2 text-sm text-err">{error}</p>}
          <div className="mt-2 flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded-lg border border-line px-4 py-2 text-sm font-medium">
              Cancel
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white hover:brightness-110 disabled:opacity-60"
            >
              {busy ? 'Inviting…' : 'Send invite'}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
