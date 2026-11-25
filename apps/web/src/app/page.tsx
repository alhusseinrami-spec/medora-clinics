'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { get } from '@/lib/api';

/** Signed in: open the first workspace. Otherwise: sign in. */
export default function Home() {
  const router = useRouter();
  useEffect(() => {
    get('/auth/me', null).then((me) => {
      const w = me.workspaces.find((x: any) => x.status === 'active');
      router.replace(w ? `/w/${w.organization_id}/dashboard` : me.patientRecords > 0 ? '/portal' : '/register');
    }).catch(() => router.replace('/login'));
  }, [router]);
  return null;
}
