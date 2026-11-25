'use client';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, Select, Switch } from '@/components/ui';
import { get, put } from '@/lib/api';

const LABELS: Record<string, [string, string]> = {
  trial_days: ['Free trial length (days)', 'For workspaces opened from now on.'],
  grace_days: ['Grace days after the paid period', 'Workspaces stay usable (payment due) for this many days after the period ends.'],
  default_plan_independent_practice: ['Trial plan for independent practices', ''],
  default_plan_medical_center: ['Trial plan for medical centers', ''],
  signups_open: ['New workspaces can be opened', 'When off, sign-up for new practices and centers is refused. Invited staff and patients can still join.'],
  currency: ['Default currency', ''],
  support_email: ['Support email shown to users', ''],
};

export default function AdminSettings() {
  const [rows, setRows] = useState<any[] | null>(null); const [plans, setPlans] = useState<any[]>([]); const [err, setErr] = useState<unknown>(null); const [saved, setSaved] = useState('');
  useEffect(() => { get<any[]>('/admin/settings', null).then(setRows).catch(setErr); get('/admin/plans', null).then((p) => setPlans(p.plans)).catch(() => {}); }, []);
  const save = async (key: string, value: unknown) => { setErr(null); setSaved(''); try { setRows(await put(`/admin/settings/${key}`, { value })); setSaved(key); } catch (x) { setErr(x); } };
  if (!rows) return <ErrorNote error={err} />;
  return (
    <>
      <h1 className="mb-4 font-[family-name:var(--font-display)] text-2xl font-semibold">Platform settings</h1>
      <ErrorNote error={err} />
      <div className="grid gap-4 md:grid-cols-2">{rows.map((r) => <SettingCard key={r.key} r={r} plans={plans} saved={saved === r.key} onSave={save} />)}</div>
      <Card title="Specialty presets" className="mt-6"><p className="text-sm text-muted">Specialty presets are versioned files in the repository (packages/shared) and are published with <code>npm run db:presets</code>. Editing them from this console is planned.</p></Card>
    </>
  );
}

function SettingCard({ r, plans, saved, onSave }: { r: any; plans: any[]; saved: boolean; onSave: (k: string, v: unknown) => void }) {
  const [v, setV] = useState<any>(r.value);
  const [label, hint] = LABELS[r.key] ?? [r.key, ''];
  const kind = r.key.replace('default_plan_', '');
  return (
    <Card>
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); onSave(r.key, typeof r.value === 'number' ? Number(v) : v); }}>
        {typeof r.value === 'boolean' ? <label className="flex items-center justify-between gap-3 text-sm font-medium">{label}<Switch checked={!!v} onChange={(x) => { setV(x); onSave(r.key, x); }} label={label} /></label> : (
          <Field label={label}>
            {r.key.startsWith('default_plan_') ? <Select value={v} onChange={(e) => setV(e.target.value)}>{plans.filter((p) => p.is_active && p.applies_to.includes(kind)).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}</Select>
              : r.key === 'currency' ? <Select value={v} onChange={(e) => setV(e.target.value)}><option>USD</option><option>LBP</option></Select>
              : <Input type={typeof r.value === 'number' ? 'number' : r.key.includes('email') ? 'email' : 'text'} value={v} onChange={(e) => setV(e.target.value)} />}
          </Field>)}
        {hint && <p className="text-xs text-muted">{hint}</p>}
        {typeof r.value !== 'boolean' && <div className="flex items-center gap-3"><Button size="sm" variant="secondary">Save</Button>{saved && <span className="text-xs text-success">Saved</span>}</div>}
      </form>
    </Card>
  );
}
