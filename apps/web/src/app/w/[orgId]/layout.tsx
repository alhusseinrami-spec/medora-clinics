'use client';
import { use, type ReactNode } from 'react';
import { WorkspaceProvider } from '@/lib/workspace';
import { Shell } from '@/components/Shell';

export default function WorkspaceLayout({ children, params }: { children: ReactNode; params: Promise<{ orgId: string }> }) {
  const { orgId } = use(params);
  return <WorkspaceProvider orgId={orgId}><Shell>{children}</Shell></WorkspaceProvider>;
}
