'use client';
import { AuthProvider } from '@/lib/auth';
import { PermissionsProvider } from '@/lib/permissions';
import { AppConfigProvider } from '@/lib/appConfig';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <AppConfigProvider>
      <AuthProvider>
        <PermissionsProvider>{children}</PermissionsProvider>
      </AuthProvider>
    </AppConfigProvider>
  );
}
