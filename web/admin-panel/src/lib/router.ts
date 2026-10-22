// Minimal hash router: #/ , #/orders/:id , #/users/:id , #/finance …
import { useEffect, useState } from 'react';

export interface Route {
  name: string;
  param?: string;
}

export function parseHash(hash: string): Route {
  const path = hash.replace(/^#/, '') || '/';
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'overview' };
  if (parts[0] === 'orders' && parts[1]) return { name: 'order', param: decodeURIComponent(parts[1]) };
  if (parts[0] === 'users' && parts[1]) return { name: 'user', param: decodeURIComponent(parts[1]) };
  if (parts[0] === 'users') return { name: 'users' };
  if (parts[0] === 'finance') return { name: 'finance' };
  if (parts[0] === 'analytics') return { name: 'analytics' };
  if (parts[0] === 'settings') return { name: 'settings' };
  if (parts[0] === 'audit') return { name: 'audit' };
  return { name: 'overview' };
}

export function navigate(to: string): void {
  window.location.hash = to.startsWith('#') ? to : `#${to}`;
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
