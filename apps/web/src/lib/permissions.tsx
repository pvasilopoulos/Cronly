'use client';
import { createContext, useContext, useMemo } from 'react';
import useSWR from 'swr';
import { fetcher } from './api';
import { useAuth } from './auth';
import type { MyPermissions } from './types';

interface PermCtx {
  loading: boolean;
  data: MyPermissions | null;
  can: (key: string) => boolean;
}

const Ctx = createContext<PermCtx | null>(null);

export function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const { activeTenant } = useAuth();
  // Re-fetches whenever the active tenant changes — the key includes tenant id.
  const { data, isLoading } = useSWR<MyPermissions>(
    activeTenant ? `/me/permissions?t=${activeTenant.id}` : null,
    () => fetcher<MyPermissions>('/me/permissions'),
    { revalidateOnFocus: false },
  );

  const value = useMemo<PermCtx>(() => {
    const keys = new Set(data?.keys ?? []);
    return {
      loading: isLoading,
      data: data ?? null,
      can: (key: string) => keys.has(key),
    };
  }, [data, isLoading]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePermissions() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePermissions must be used within PermissionsProvider');
  return ctx;
}
