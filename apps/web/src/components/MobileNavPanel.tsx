'use client';
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useAppConfig } from '@/lib/appConfig';
import { NAV } from './Shell';

/** The footer bar shows at most four configured items plus a Menu button. */
const MAX_FOOTER = 4;

/**
 * Super-admin control for the mobile/tablet footer bar. Picks which nav
 * destinations appear in the bottom tab bar (instance-wide). Items are still
 * permission-gated per user at render time, so a member only ever sees the
 * footer entries they're allowed to open. When none are chosen, the footer
 * falls back to a sensible default (Jobs, Runs, Alerts, Settings).
 */
export function MobileNavPanel() {
  const { user } = useAuth();
  const canEdit = !!user?.isSuperAdmin;
  const { config, refresh } = useAppConfig();

  const [selected, setSelected] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => {
    setSelected(config.mobileNav ?? []);
  }, [config.mobileNav]);

  if (!canEdit) return null;

  function toggle(href: string) {
    setSelected((cur) => {
      if (cur.includes(href)) return cur.filter((h) => h !== href);
      if (cur.length >= MAX_FOOTER) return cur; // keep the bar to four items
      return [...cur, href];
    });
  }

  async function save() {
    setSaving(true);
    setErr(null);
    try {
      await api('/app-config', { method: 'PATCH', body: { mobileNav: selected } });
      refresh();
      setSavedAt(Date.now());
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Could not save the footer menu');
    } finally {
      setSaving(false);
    }
  }

  const full = selected.length >= MAX_FOOTER;

  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-faint">Mobile footer menu</h2>
        <span className="rounded-full bg-accent-soft px-2 py-0.5 text-[11px] font-semibold text-accent-fg">
          Super-admin
        </span>
      </div>
      <p className="mb-3 text-xs text-muted">
        Choose up to {MAX_FOOTER} destinations for the bottom tab bar shown on phones and tablets. A “Menu”
        button is always added for the rest. Each item still respects the viewer’s permissions.
      </p>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {NAV.map((n) => {
          const checked = selected.includes(n.href);
          const disabled = !checked && full;
          const order = selected.indexOf(n.href);
          return (
            <label
              key={n.href}
              className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm ${
                checked ? 'border-accent bg-accent-soft/40' : 'border-line bg-surface2/50'
              } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
            >
              <input
                type="checkbox"
                checked={checked}
                disabled={disabled}
                onChange={() => toggle(n.href)}
                className="h-4 w-4 accent-accent"
              />
              <span className="text-base leading-none">{n.icon}</span>
              <span className="flex-1">{n.label}</span>
              {checked && (
                <span className="rounded-full bg-accent px-1.5 text-[10px] font-semibold text-white">
                  {order + 1}
                </span>
              )}
            </label>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={save}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save footer menu'}
        </button>
        {selected.length === 0 && (
          <span className="text-xs text-faint">None selected — using the default (Jobs, Runs, Alerts, Settings).</span>
        )}
        {err && <span className="text-sm text-err">{err}</span>}
        {savedAt > 0 && !err && !saving && <span className="text-sm text-ok">Saved</span>}
      </div>
    </section>
  );
}
