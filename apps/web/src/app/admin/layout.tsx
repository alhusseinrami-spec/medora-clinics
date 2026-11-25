import type { ReactNode } from 'react';
import { AdminFrame } from '@/lib/admin';

export default function AdminLayout({ children }: { children: ReactNode }) { return <AdminFrame>{children}</AdminFrame>; }
