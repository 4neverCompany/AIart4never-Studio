'use client';

import { useState, useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // localStorage is non-reactive, client-only state — reading it on
    // mount and seeding component state is the documented React pattern.
    // The lint rule's preferred alternatives (useSyncExternalStore) don't
    // help here because there's no external publisher to subscribe to.
    const auth = localStorage.getItem('mashup_auth');
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsAuthenticated(auth === 'true');
    if (auth !== 'true' && pathname !== '/login') {
      router.push('/login');
    }
  }, [pathname, router]);

  const logout = () => {
    localStorage.removeItem('mashup_auth');
    setIsAuthenticated(false);
    router.push('/login');
  };

  return { isAuthenticated, logout };
}
