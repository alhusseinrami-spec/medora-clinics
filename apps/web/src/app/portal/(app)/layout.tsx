import type { ReactNode } from 'react';
import { PortalFrame } from '@/lib/portal';

export default function PortalLayout({ children }: { children: ReactNode }) { return <PortalFrame>{children}</PortalFrame>; }
