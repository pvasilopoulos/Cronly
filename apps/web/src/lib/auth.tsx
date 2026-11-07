'use client';
import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, tokens } from './api';
import type { Me, Tenant } from './types';

interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  user: { id: string; email: string; name: string; isSuperAdmin: boolean };
  tenants: Tenant[];
}

// Login may short-circuit into a second factor instead of returning tokens.
type LoginSuccess = LoginResponse & { mfaRequired?: false };
type MfaChallenge = { mfaRequired: true; mfaToken: string };
export type LoginResult = { status: 'ok' } | { status: 'mfa'; mfaToken: string };

interface AuthState {
  ready: boolean;
  user: Me | null;
  activeTenant: Tenant | null;
  login: (email: string, password: string) => Promise<LoginResult>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  logout: () => void;
  setTenant: (id: string) => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<Me | null>(null);
  const [activeTenant, setActiveTenant] = useState<Tenant | null>(null);

  const pickTenant = useCallback((me: Me) => {
    const saved = tokens.tenant;
    const found = me.tenants.find((t) => t.id === saved) ?? me.tenants[0] ?? null;
    if (found) tokens.setTenant(found.id);
    setActiveTenant(found);
  }, []);

  // Restore session on mount.
  useEffect(() => {
    let active = true;
    (async () => {
      if (!tokens.access && !tokens.refresh) {
        setReady(true);
        return;
      }
      try {
        const me = await api<Me>('/me', { tenant: false });
        if (!active) return;
        setUser(me);
        pickTenant(me);
      } catch {
        tokens.clear();
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [pickTenant]);

  const establish = useCallback(
    (res: LoginResponse) => {
      tokens.set(res.accessToken, res.refreshToken);
      const me: Me = { ...res.user, tenants: res.tenants };
      setUser(me);
      pickTenant(me);
    },
    [pickTenant],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<LoginResult> => {
      const res = await api<LoginSuccess | MfaChallenge>('/auth/login', {
        method: 'POST',
        body: { email, password },
        tenant: false,
      });
      if ('mfaRequired' in res && res.mfaRequired) {
        return { status: 'mfa', mfaToken: res.mfaToken };
      }
      establish(res as LoginResponse);
      return { status: 'ok' };
    },
    [establish],
  );

  const completeMfa = useCallback(
    async (mfaToken: string, code: string) => {
      const res = await api<LoginResponse>('/auth/login/mfa', {
        method: 'POST',
        body: { mfaToken, code },
        tenant: false,
      });
      establish(res);
    },
    [establish],
  );

  const logout = useCallback(() => {
    // Best-effort server-side revocation of this session's refresh family.
    const refresh = tokens.refresh;
    if (refresh) {
      void api('/auth/logout', { method: 'POST', body: { refreshToken: refresh }, tenant: false }).catch(
        () => {},
      );
    }
    tokens.clear();
    setUser(null);
    setActiveTenant(null);
  }, []);

  const setTenant = useCallback(
    (id: string) => {
      const t = user?.tenants.find((x) => x.id === id) ?? null;
      if (t) {
        tokens.setTenant(t.id);
        setActiveTenant(t);
      }
    },
    [user],
  );

  return (
    <AuthContext.Provider value={{ ready, user, activeTenant, login, completeMfa, logout, setTenant }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
