'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorNote, Input, fmtDate } from '@/components/ui';
import { get, post } from '@/lib/api';

export default function AdminUsers() {
  const [q, setQ] = useState(''); const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState<unknown>(null);
  const load = (s = q) => get<any[]>(`/admin/users${s.trim() ? `?q=${encodeURIComponent(s.trim())}` : ''}`, null).then(setRows).catch(setErr);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(''); }, []);
  const setStatus = async (u: any, status: string) => {
    const reason = status === 'suspended' ? prompt(`Why suspend ${u.email}? Their sessions end immediately.`) : null;
    if (status === 'suspended' && !reason) return;
    try { await post(`/admin/users/${u.id}/status`, { status, reason }); load(); } catch (x) { setErr(x); }
  };
  return (
    <>
      <h1 className="mb-4 font-[family-name:var(--font-display)] text-2xl font-semibold">Users</h1>
      <form className="mb-4 flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); load(); }}><Input placeholder="Search email or name…" value={q} onChange={(e) => setQ(e.target.value)} /><Button variant="secondary">Search</Button></form>
      <ErrorNote error={err} />
      <Card><div className="overflow-x-auto"><table className="w-full min-w-[800px] text-sm">
        <thead className="text-xs text-muted"><tr>{['Account', 'Workspaces', 'Patient app', 'Two-factor', 'Last seen', 'Status', ''].map((h) => <th key={h} className="py-2 pe-3 text-start font-medium">{h}</th>)}</tr></thead>
        <tbody className="divide-y divide-line">{(rows ?? []).map((u) => (
          <tr key={u.id}>
            <td className="py-2 pe-3"><span className="font-medium">{u.full_name}</span>{u.is_platform_admin && <Badge className="ms-1">MEDORA admin</Badge>}<span className="block text-xs text-muted">{u.email} · joined {fmtDate(u.created_at)}</span></td>
            <td className="pe-3 text-xs">{u.workspaces.length ? u.workspaces.map((w: any) => <span key={w.organization_id} className="block">{w.name} · {w.role.replace(/_/g, ' ')}{w.status !== 'active' ? ` (${w.status})` : ''}</span>) : '—'}</td>
            <td className="pe-3">{u.patient_records > 0 ? `${u.patient_records} file${u.patient_records > 1 ? 's' : ''}` : '—'}</td>
            <td className="pe-3">{u.mfa_enabled ? 'On' : 'Off'}</td>
            <td className="pe-3 text-xs text-muted">{u.last_seen_at ? fmtDate(u.last_seen_at) : '—'}</td>
            <td className="pe-3"><Badge status={u.status === 'active' ? 'active' : 'suspended'}>{u.status}</Badge></td>
            <td className="text-end">{u.status === 'active' ? <Button size="sm" variant="ghost" onClick={() => setStatus(u, 'suspended')}>Suspend</Button> : <Button size="sm" variant="secondary" onClick={() => setStatus(u, 'active')}>Reactivate</Button>}</td>
          </tr>))}</tbody></table></div>
        {rows?.length === 0 && <p className="py-6 text-center text-sm text-muted">No accounts match.</p>}
        <p className="mt-3 text-xs text-muted">Showing up to 200 accounts. Patient and clinical records are not visible here.</p>
      </Card>
    </>
  );
}
