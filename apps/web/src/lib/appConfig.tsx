'use client';
import { createContext, useContext, useEffect } from 'react';
import useSWR from 'swr';
import { fetcher } from './api';
import type { AppConfig } from './types';

const DEFAULTS: AppConfig = { name: 'CronApp', icon: '◷', logoScale: 32, mobileNav: [] };

/** Swap the browser-tab favicon to a data: URL at runtime (or restore default). */
function applyFavicon(href: string | null | undefined) {
  if (typeof document === 'undefined') return;
  try {
    let link = document.querySelector<HTMLLinkElement>('link#cronapp-favicon');
    if (href) {
      if (!link) {
        link = document.createElement('link');
        link.id = 'cronapp-favicon';
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = href;
    } else if (link) {
      link.remove();
    }
  } catch {
    /* ignore */
  }
}

interface AppConfigCtx {
  config: AppConfig;
  /** Re-fetch /app-config (used after a super-admin saves branding). */
  refresh: () => void;
}

const Ctx = createContext<AppConfigCtx | null>(null);

/**
 * Instance branding (app name + icon). Fetched from the public /app-config
 * endpoint so it's available on the sign-in screen too, before any tenant
 * context. Falls back to defaults while loading or if the request fails.
 */
export function AppConfigProvider({ children }: { children: React.ReactNode }) {
  const { data, mutate } = useSWR<AppConfig>('/app-config', () => fetcher<AppConfig>('/app-config'), {
    revalidateOnFocus: false,
    // Branding rarely changes; keep it stable across navigations.
    dedupingInterval: 60_000,
  });

  // Reflect the configured favicon onto the live document tab icon.
  useEffect(() => {
    applyFavicon(data?.favicon ?? null);
  }, [data?.favicon]);

  return (
    <Ctx.Provider value={{ config: data ?? DEFAULTS, refresh: () => void mutate() }}>
      {children}
    </Ctx.Provider>
  );
}

export function useAppConfig(): AppConfigCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useAppConfig must be used within AppConfigProvider');
  return ctx;
}

/**
 * The instance brand mark: a custom logo image when one is set, otherwise the
 * glyph icon on the brand gradient. Used by the sidebar, mobile header and the
 * sign-in screen so all three stay in sync. `size` is a Tailwind size class pair
 * (e.g. "h-8 w-8") and `rounded` the corner radius class.
 */
export function BrandMark({
  config,
  size = 'h-8 w-8',
  rounded = 'rounded-lg',
  textClass = '',
  scalePx,
}: {
  config: AppConfig;
  size?: string;
  rounded?: string;
  textClass?: string;
  /** When set, sizes the mark to this many px (overrides the `size` class). */
  scalePx?: number | null;
}) {
  // Px sizing wins over the Tailwind size class when a scale is given, so the
  // super-admin's configured size applies wherever the shell passes it through.
  const px = scalePx && scalePx > 0 ? scalePx : null;
  const sizeCls = px ? '' : size;
  const style = px ? { width: px, height: px } : undefined;

  if (config.logo) {
    return (
      <img
        src={config.logo}
        alt={config.name}
        style={style}
        className={`${sizeCls} ${rounded} flex-none border border-line bg-surface object-contain`}
      />
    );
  }
  return (
    <span
      style={px ? { ...style, fontSize: Math.round(px * 0.5) } : undefined}
      className={`grid ${sizeCls} flex-none place-items-center ${rounded} bg-gradient-to-br from-accent to-run text-white ${textClass}`}
    >
      {config.icon}
    </span>
  );
}
