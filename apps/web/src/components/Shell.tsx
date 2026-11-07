'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';
import { usePermissions } from '@/lib/permissions';
import { useAppConfig, BrandMark } from '@/lib/appConfig';
import { initials } from '@/lib/format';
import { NotificationBell } from './NotificationBell';
import type { Tenant } from '@/lib/types';

export interface NavDef {
  href: string;
  label: string;
  icon: string;
  perm: string;
  section: string;
}

// Grouped so the sidebar reads as sections rather than a flat list. Order within
// a section is the display order; SECTION_ORDER sets the section order.
export const NAV: NavDef[] = [
  { href: '/jobs', label: 'Cron Jobs', icon: '◷', perm: 'jobs:read', section: 'Operations' },
  { href: '/runs', label: 'Executions', icon: '≡', perm: 'runs:read', section: 'Operations' },
  { href: '/alerts', label: 'Alerts', icon: '◭', perm: 'alerts:read', section: 'Operations' },
  { href: '/secrets', label: 'Secrets', icon: '⚷', perm: 'secrets:read', section: 'Security' },
  { href: '/apikeys', label: 'API Keys', icon: '⚿', perm: 'apikeys:read', section: 'Security' },
  { href: '/roles', label: 'Roles', icon: '◆', perm: 'roles:read', section: 'Access' },
  { href: '/members', label: 'Members', icon: '◉', perm: 'members:read', section: 'Access' },
  { href: '/audit', label: 'Audit Log', icon: '❏', perm: 'audit:read', section: 'Account' },
  { href: '/billing', label: 'Billing', icon: '◇', perm: 'billing:read', section: 'Account' },
  { href: '/settings', label: 'Settings', icon: '⚙', perm: 'settings:read', section: 'Account' },
];

const SECTION_ORDER = ['Operations', 'Security', 'Access', 'Account'];

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('cronapp.theme') as 'light' | 'dark' | null;
      if (saved) document.documentElement.setAttribute('data-theme', saved);
      setTheme(saved);
    } catch {
      /* ignore */
    }
  }, []);
  const toggle = () => {
    const isDark =
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      (!document.documentElement.getAttribute('data-theme') &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
    const next = isDark ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem('cronapp.theme', next);
    } catch {
      /* ignore */
    }
    setTheme(next);
  };
  return { theme, toggle };
}

function TenantSwitcher({ compact }: { compact?: boolean }) {
  const { user, activeTenant, setTenant } = useAuth();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0); // keyboard-highlighted row
  const searchRef = useRef<HTMLInputElement>(null);

  const tenants = user?.tenants ?? [];
  // Show the search field whenever there's more than one workspace to pick from.
  const searchable = tenants.length > 1;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter(
      (t) => t.name.toLowerCase().includes(q) || t.plan.toLowerCase().includes(q),
    );
  }, [tenants, query]);

  // Reset transient state and focus the search each time the menu opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      if (searchable) requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [open, searchable]);

  // Keep the highlight within the (possibly filtered) list.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)));
  }, [filtered.length]);

  if (!activeTenant) return null;

  function choose(t: Tenant) {
    setTenant(t.id);
    setOpen(false);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = filtered[active];
      if (t) choose(t);
    }
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center gap-2.5 rounded-lg border border-line bg-surface2 px-3 py-2 text-left hover:border-faint"
      >
        <span className="grid h-6 w-6 flex-none place-items-center rounded-md bg-accent text-[11px] font-bold text-white">
          {initials(activeTenant.name)}
        </span>
        {!compact && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold">{activeTenant.name}</span>
            <span className="text-[11px] text-faint">{activeTenant.plan}</span>
          </span>
        )}
        <span className={`text-xs text-faint transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={() => setOpen(false)} />
          <div
            role="listbox"
            onKeyDown={onKeyDown}
            className="absolute left-0 right-0 top-[calc(100%+6px)] z-40 flex flex-col rounded-lg border border-line bg-surface p-1.5 shadow-xl"
          >
            {searchable && (
              <div className="relative mb-1 p-1">
                <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-xs text-faint">
                  ⌕
                </span>
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setActive(0);
                  }}
                  placeholder="Search workspaces…"
                  className="w-full rounded-md border border-line bg-surface2 py-1.5 pl-7 pr-2 text-sm outline-none focus:border-accent"
                />
              </div>
            )}

            <div className="flex max-h-72 flex-col gap-0.5 overflow-y-auto">
              {filtered.length === 0 ? (
                <div className="px-2 py-6 text-center text-xs text-faint">
                  No workspaces match “{query}”.
                </div>
              ) : (
                filtered.map((t, i) => {
                  const current = t.id === activeTenant.id;
                  const highlighted = i === active;
                  return (
                    <button
                      key={t.id}
                      role="option"
                      aria-selected={current}
                      onClick={() => choose(t)}
                      onMouseEnter={() => setActive(i)}
                      className={`flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left ${
                        highlighted ? 'bg-surface2' : ''
                      }`}
                    >
                      <span className="grid h-6 w-6 flex-none place-items-center rounded-md bg-accent text-[11px] font-bold text-white">
                        {initials(t.name)}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{t.name}</span>
                        <span className="text-[11px] text-faint">{t.plan}</span>
                      </span>
                      {current && <span className="flex-none text-xs text-accent">✓</span>}
                    </button>
                  );
                })
              )}
            </div>

            {searchable && tenants.length > 0 && (
              <div className="mt-1 border-t border-line px-2 pt-1.5 text-[11px] text-faint">
                {filtered.length} of {tenants.length} workspace{tenants.length === 1 ? '' : 's'}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const NAV_COLLAPSE_KEY = 'cronapp.nav.collapsed';

function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const { can, loading } = usePermissions();
  const { user } = useAuth();

  // Collapsible nav sections, remembered per browser.
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const raw = localStorage.getItem(NAV_COLLAPSE_KEY);
      if (raw) setCollapsed(new Set(JSON.parse(raw) as string[]));
    } catch {
      /* ignore */
    }
  }, []);
  function toggleSection(section: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      next.has(section) ? next.delete(section) : next.add(section);
      try {
        localStorage.setItem(NAV_COLLAPSE_KEY, JSON.stringify([...next]));
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const visible = NAV.filter((n) => can(n.perm));
  if (loading && visible.length === 0) {
    return <div className="px-3 py-2 text-xs text-faint">Loading…</div>;
  }
  const linkCls = (active: boolean) =>
    `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium ${
      active ? 'bg-accent-soft text-accent-fg' : 'text-muted hover:bg-surface2 hover:text-fg'
    }`;
  const sectionHdr =
    'mt-3 mb-1 flex w-full items-center justify-between px-3 text-[10px] font-semibold uppercase tracking-wider text-faint first:mt-0 hover:text-muted';
  return (
    <nav className="flex flex-col gap-0.5">
      {SECTION_ORDER.map((section) => {
        const items = visible.filter((n) => n.section === section);
        if (items.length === 0) return null;
        const isCollapsed = collapsed.has(section);
        return (
          <div key={section} className="flex flex-col gap-0.5">
            <button type="button" onClick={() => toggleSection(section)} className={sectionHdr}>
              <span>{section}</span>
              <span className="text-[9px] transition-transform">{isCollapsed ? '▸' : '▾'}</span>
            </button>
            {!isCollapsed &&
              items.map((n) => {
                const active = pathname.startsWith(n.href);
                return (
                  <Link key={n.href} href={n.href} onClick={onNavigate} className={linkCls(active)}>
                    <span className="w-4 text-center">{n.icon}</span>
                    {n.label}
                  </Link>
                );
              })}
          </div>
        );
      })}

      {/* Platform console — super-admins only. Sits in its own section so it is
          visually distinct from tenant-scoped navigation. */}
      {user?.isSuperAdmin && (
        <>
          <div className="mt-3 mb-1 px-3 text-[10px] font-semibold uppercase tracking-wider text-faint">
            Platform
          </div>
          <Link href="/admin" onClick={onNavigate} className={linkCls(pathname.startsWith('/admin'))}>
            <span className="w-4 text-center">⬢</span>
            Workspaces &amp; Users
          </Link>
        </>
      )}
    </nav>
  );
}

function SidebarContent({ onNavigate, showBell }: { onNavigate?: () => void; showBell?: boolean }) {
  const { user, logout } = useAuth();
  const { toggle } = useTheme();
  const { config } = useAppConfig();
  return (
    <div className="flex h-full flex-col gap-4">
      {/* Brand mark sits at the top, centered; the configured size drives it. */}
      <div className="relative flex flex-col items-center gap-2 pt-1 text-center">
        {showBell && (
          <div className="absolute right-0 top-0">
            <NotificationBell />
          </div>
        )}
        <BrandMark config={config} scalePx={config.logoScale ?? 32} textClass="text-xl" />
        <div className="min-w-0">
          <b className="block truncate text-[15px] leading-tight">{config.name}</b>
          <span className="block text-[11px] text-faint">Console</span>
        </div>
      </div>
      <TenantSwitcher />
      <div className="flex-1 overflow-y-auto">
        <NavLinks onNavigate={onNavigate} />
      </div>
      <div className="flex items-center gap-2 border-t border-line pt-3">
        <span className="grid h-8 w-8 place-items-center rounded-full border border-line bg-surface2 text-xs font-semibold">
          {user ? initials(user.name) : '?'}
        </span>
        <div className="min-w-0 flex-1">
          <b className="block truncate text-[13px]">{user?.name}</b>
          <span className="truncate text-[11px] text-faint">{user?.email}</span>
        </div>
        <button onClick={toggle} title="Toggle theme" className="rounded-md p-1.5 hover:bg-surface2">
          ◐
        </button>
        <button onClick={logout} title="Sign out" className="rounded-md p-1.5 hover:bg-surface2">
          ⏻
        </button>
      </div>
    </div>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const [drawer, setDrawer] = useState(false);
  const router = useRouter();
  const { ready, user } = useAuth();
  const { config } = useAppConfig();

  useEffect(() => {
    if (ready && !user) router.replace('/login');
  }, [ready, user, router]);

  if (!ready) {
    return (
      <div className="grid min-h-screen place-items-center text-faint">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-line border-t-accent" />
      </div>
    );
  }
  if (!user) return null;

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[240px_1fr]">
      {/* Sidebar — desktop only (tablet uses the mobile chrome + footer bar) */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-surface p-4 lg:flex">
        <SidebarContent showBell />
      </aside>

      {/* Top bar — mobile & tablet */}
      <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-surface/90 px-4 py-3 backdrop-blur lg:hidden">
        <button onClick={() => setDrawer(true)} className="rounded-md p-1 text-xl" aria-label="Menu">
          ☰
        </button>
        <BrandMark config={config} size="h-7 w-7" textClass="text-sm" />
        <b className="text-[15px]">{config.name}</b>
        <div className="ml-auto">
          <NotificationBell />
        </div>
      </header>

      {/* Drawer — mobile & tablet */}
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/45" onClick={() => setDrawer(false)} />
          <div className="absolute left-0 top-0 h-full w-72 max-w-[85vw] overflow-y-auto border-r border-line bg-surface p-4">
            <SidebarContent onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      {/* Extra bottom padding on mobile/tablet so the footer bar never covers content */}
      <main className="min-w-0 px-4 py-5 pb-24 lg:px-6 lg:py-6 lg:pb-6">{children}</main>

      {/* Footer nav — mobile & tablet, configurable from Settings */}
      <MobileFooterNav onMenu={() => setDrawer(true)} />
    </div>
  );
}

/**
 * Bottom tab bar for mobile & tablet. Items come from the instance mobileNav
 * config (set by a super-admin in Settings); each is still permission-gated, so
 * a user only sees items they're allowed to open. A trailing "Menu" button opens
 * the full drawer so nothing is ever unreachable.
 */
const DEFAULT_FOOTER = ['/jobs', '/runs', '/alerts', '/settings'];

function MobileFooterNav({ onMenu }: { onMenu: () => void }) {
  const pathname = usePathname();
  const { can } = usePermissions();
  const { config } = useAppConfig();

  const byHref = new Map(NAV.map((n) => [n.href, n]));
  const configured = (config.mobileNav && config.mobileNav.length > 0 ? config.mobileNav : DEFAULT_FOOTER)
    .map((href) => byHref.get(href))
    .filter((n): n is NavDef => !!n && can(n.perm))
    .slice(0, 4);

  if (configured.length === 0) return null;

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 flex items-stretch border-t border-line bg-surface/95 backdrop-blur lg:hidden">
      {configured.map((n) => {
        const active = pathname.startsWith(n.href);
        return (
          <Link
            key={n.href}
            href={n.href}
            className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium ${
              active ? 'text-accent-fg' : 'text-muted'
            }`}
          >
            <span className="text-lg leading-none">{n.icon}</span>
            {n.label}
          </Link>
        );
      })}
      <button
        onClick={onMenu}
        className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] font-medium text-muted"
      >
        <span className="text-lg leading-none">☰</span>
        Menu
      </button>
    </nav>
  );
}
