import type { ReactNode } from 'react';

export function Chip({ tone, children }: { tone?: 'green' | 'amber' | 'accent'; children: ReactNode }) {
  const cls = tone ? `chip chip-${tone}` : 'chip';
  return <span className={cls}>{children}</span>;
}
