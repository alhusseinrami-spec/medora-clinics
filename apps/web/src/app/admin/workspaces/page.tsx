'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { Badge, Card, ErrorNote, Input, Select, fmtDate } from '@/components/ui';
import { get } from '@/lib/api';
import { STATUS_LABEL, usd } from '@/lib/admin';

export default function AdminWorkspaces() {
  const [rows, setRows] = useState<any[] | null>(null); const [err, setErr] = useState<unknown>(null);
  const [q, setQ] = useState(''); const [status, setStatus] = useState(''); const [plan, setPlan] = useState('');
  useEffect(() => { get<any[]>('/admin/workspaces', null).then(setRows).catch(setErr); }, []);
  const list = useMemo(() => (rows ?? []).filter((w) => (!q || `${w.name} ${w.owner_email ?? ''} ${w.owner_name ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    && (!status || w.effective_status === status || (status === 'suspended_ws' && w.status === 'suspended')) && (!plan || w.plan_code === plan)), [rows, q, status, plan]);
  const plans = [...new Set((rows ?? []).map((w) => w.plan_code))];
  return (
    <>
      <h1 className="mb-4 font-[family-name:var(--font-display)] text-2xl font-semibold">Workspaces</h1>
      <ErrorNote error={err} />
      <div className="mb-4 flex flex-wrap gap-2">
        <Input className="max-w-xs" placeholder="Search name or owner…" value={q} onChange={(e) => setQ(e.target.value)} />
        <Select className="max-w-[12rem]" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{Object.entries(STATUS_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}<option value="suspended_ws">Workspace suspended</option></Select>
        <Select className="max-w-[12rem]" value={plan} onChange={(e) => setPlan(e.target.value)}><option value="">All plans</option>{plans.map((p) => <option key={p} value={p}>{p}</option>)}</Select>
      </div>
      <Card>
        <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-sm">
          <thead className="text-xs text-muted"><tr className="text-start">{['Workspace', 'Owner', 'Plan', 'Status', 'Renews / trial ends', 'Price', 'Doctors', 'Staff', 'Patients', 'Visits 30d', 'Last activity'].map((h) => <th key={h} className="py-2 pe-3 text-start font-medium">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-line">{list.map((w) => (
            <tr key={w.id} className="hover:bg-surface">
              <td className="py-2 pe-3"><Link href={`/admin/workspaces/${w.id}`} className="font-medium text-brand hover:underline">{w.name}</Link><span className="block text-xs text-muted">{w.kind === 'medical_center' ? 'Medical center' : 'Independent practice'} · {fmtDate(w.created_at)}</span></td>
              <td className="pe-3">{w.owner_name}<span className="block text-xs text-muted">{w.owner_email}</span></td>
              <td className="pe-3 capitalize">{w.plan_code.replace(/_/g, ' ')}<span className="block text-xs text-muted">{w.billing_cycle}</span></td>
              <td className="pe-3"><Badge status={w.effective_status}>{STATUS_LABEL[w.effective_status] ?? w.effective_status}</Badge>{w.status === 'suspended' && <Badge status="suspended" className="ms-1">Workspace off</Badge>}{w.cancel_at_period_end && <span className="block text-xs text-warning">Cancels at period end</span>}</td>
              <td className="pe-3 text-xs">{w.sub_status === 'trial' ? fmtDate(w.trial_ends_at) : w.current_period_end ? fmtDate(w.current_period_end) : '—'}</td>
              <td className="pe-3 tabular">{usd(w.price)}</td>
              <td className="pe-3 tabular">{w.doctors}</td><td className="pe-3 tabular">{w.assistants}</td><td className="pe-3 tabular">{w.patients}</td><td className="pe-3 tabular">{w.appointments_30d}</td>
              <td className="text-xs text-muted">{w.last_activity ? fmtDate(w.last_activity) : '—'}</td>
            </tr>))}</tbody>
        </table></div>
        {rows && list.length === 0 && <p className="py-6 text-center text-sm text-muted">No workspaces match.</p>}
      </Card>
    </>
  );
}
