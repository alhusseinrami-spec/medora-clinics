'use client';
import { useCallback, useEffect, useState } from 'react';
import { get } from './api';
import { useWorkspace } from './workspace';

export function useLoad<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<unknown>(null); const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    if (!path) return; setLoading(true);
    try { setData(await get<T>(path)); setError(null); } catch (e) { setError(e); } finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load, setData };
}

export interface Member { id: string; user_id: string; full_name: string; email?: string; role_code: string; specialty_code: string | null; department_id: string | null; status: string; consultation_fee: number | null; permissions?: string[]; assists: string[]; title: string | null; license_number: string | null }

/** Doctors the current user can book for: those they act for, or every active doctor for org-wide staff. */
export function useDoctors() {
  const { org } = useWorkspace();
  const { data } = useLoad<Member[]>('/staff');
  const doctors = (data ?? []).filter((m) => m.role_code === 'doctor' && m.status === 'active' && (org.me.orgWide || org.me.actingDoctors.includes(m.id)));
  return doctors;
}

export const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
export const dayKey = (d: Date) => toLocalInput(d).slice(0, 10);
