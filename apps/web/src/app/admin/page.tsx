'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Card, ErrorNote, Stat } from '@/components/ui';
import { get } from '@/lib/api';
import { STATUS_LABEL, usd } from '@/lib/admin';

export default function AdminOverview() {
  const [o, setO] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { get('/admin/overview', null).then(setO).catch(setErr); }, []);
  if (!o) return <ErrorNote error={err} />;
  return (
    <>
      <h1 className="mb-1 font-[family-name:var(--font-display)] text-2xl font-semibold">Platform overview</h1>
      <p className="mb-6 text-sm text-muted">Workspace and usage counts only. Patient and clinical records are never shown here.</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Workspaces" value={o.workspaces} sub={`${o.independent_practices} practices · ${o.medical_centers} centers`} />
        <Stat label="Monthly recurring revenue" value={usd(o.mrr)} tone="accent" sub="Active and payment-due subscriptions" />
        <Stat label="Trials ending in 7 days" value={o.trials_ending_7d} tone="warning" />
        <Stat label="Open support requests" value={o.open_support} tone="info" sub={<Link href="/admin/support" className="text-brand">Open →</Link>} />
        <Stat label="Active users" value={o.users} sub={`${o.active_users_7d} signed in this week`} />
        <Stat label="Doctors" value={o.doctors} tone="info" />
        <Stat label="Patient app users" value={o.patient_app_users} tone="accent" />
        <Stat label="Payments, 30 days (USD)" value={usd(o.payments_30d)} tone="warning" />
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Card title="Subscriptions by status"><ul className="space-y-1.5 text-sm">{Object.entries(o.by_status).map(([k, n]) => <li key={k} className="flex justify-between"><span>{STATUS_LABEL[k] ?? k}</span><span className="tabular font-medium">{n as number}</span></li>)}</ul></Card>
        <Card title="Subscriptions by plan"><ul className="space-y-1.5 text-sm">{Object.entries(o.by_plan).map(([k, n]) => <li key={k} className="flex justify-between"><span className="capitalize">{k.replace(/_/g, ' ')}</span><span className="tabular font-medium">{n as number}</span></li>)}</ul></Card>
        <Card title="Platform usage, 30 days"><ul className="space-y-1.5 text-sm">
          <li className="flex justify-between"><span>Appointments</span><span className="tabular font-medium">{o.appointments_30d}</span></li>
          <li className="flex justify-between"><span>WhatsApp messages sent</span><span className="tabular font-medium">{o.messages_30d}</span></li>
          <li className="flex justify-between"><span>Suspended workspaces</span><span className="tabular font-medium">{o.suspended_workspaces}</span></li>
        </ul></Card>
      </div>
      <Card title="New workspaces per month" className="mt-6">
        <table className="w-full text-sm"><thead className="text-start text-xs text-muted"><tr><th className="py-1 text-start font-medium">Month</th><th className="text-end font-medium">New workspaces</th></tr></thead>
          <tbody className="divide-y divide-line">{o.signups.map((s: any) => <tr key={s.month}><td className="py-1.5">{s.month}</td><td className="tabular text-end">{s.workspaces}</td></tr>)}</tbody></table>
      </Card>
    </>
  );
}
