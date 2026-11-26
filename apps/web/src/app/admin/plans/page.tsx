'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, Select, Switch, Textarea } from '@/components/ui';
import { get, put } from '@/lib/api';
import { usd } from '@/lib/admin';

const KINDS = [['independent_practice', 'Independent practices'], ['medical_center', 'Medical centers']];

export default function AdminPlans() {
  const [d, setD] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [edit, setEdit] = useState<any>(null);
  useEffect(() => { get('/admin/plans', null).then(setD).catch(setErr); }, []);
  if (!d) return <ErrorNote error={err} />;
  const blank = { code: '', name: '', description: '', monthly_price: null, yearly_price: null, currency: 'USD', max_doctors: 1, max_assistants: 1, max_locations: 1, max_patients: null,
    features: Object.fromEntries(d.features.map((f: any) => [f.code, false])), applies_to: ['independent_practice'], is_public: true, is_active: true, sort_order: d.plans.length + 1, isNew: true };
  return (
    <>
      <div className="mb-4 flex items-end justify-between"><div><h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">Plans</h1><p className="text-sm text-muted">Prices, limits and features apply to workspaces right away.</p></div><Button onClick={() => setEdit(blank)}>New plan</Button></div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">{d.plans.map((p: any) => (
        <Card key={p.code} title={<span>{p.name} {!p.is_active && <Badge status="cancelled">retired</Badge>} {!p.is_public && <Badge>hidden</Badge>}</span>} actions={<Button size="sm" variant="ghost" onClick={() => setEdit(p)}>Edit</Button>}>
          <p className="text-xl font-semibold">{p.monthly_price != null ? `${usd(p.monthly_price)} / month` : 'On request'}</p>
          {p.yearly_price != null && <p className="text-sm text-muted">{usd(p.yearly_price)} / year</p>}
          <p className="mt-2 text-sm text-muted">{p.description}</p>
          <ul className="mt-3 space-y-0.5 text-sm">
            <li>Doctors: {p.max_doctors ?? '∞'} · Other staff: {p.max_assistants ?? '∞'}</li>
            <li>Locations: {p.max_locations ?? '∞'} · Patients: {p.max_patients ?? '∞'}</li>
            <li className="text-muted">For: {p.applies_to.map((k: string) => KINDS.find((x) => x[0] === k)?.[1]).join(', ')}</li>
            {d.features.map((f: any) => <li key={f.code} className={p.features[f.code] ? '' : 'text-muted line-through'}>{p.features[f.code] ? '✓' : '–'} {f.description}</li>)}
          </ul>
          <p className="mt-3 text-xs text-muted">{p.workspaces} workspace{p.workspaces === 1 ? '' : 's'} on this plan</p>
        </Card>))}</div>
      {edit && <PlanDialog plan={edit} features={d.features} onClose={() => setEdit(null)} onDone={(x) => { setD(x); setEdit(null); }} />}
    </>
  );
}

function PlanDialog({ plan, features, onClose, onDone }: { plan: any; features: any[]; onClose: () => void; onDone: (x: any) => void }) {
  const num = (x: any) => (x == null ? '' : String(x));
  const [f, setF] = useState({ code: plan.code, name: plan.name, description: plan.description ?? '', monthly: num(plan.monthly_price), yearly: num(plan.yearly_price), currency: plan.currency,
    maxDoctors: num(plan.max_doctors), maxAssistants: num(plan.max_assistants), maxLocations: num(plan.max_locations), maxPatients: num(plan.max_patients),
    features: { ...plan.features } as Record<string, boolean>, appliesTo: [...plan.applies_to] as string[], isPublic: plan.is_public, isActive: plan.is_active, sortOrder: plan.sort_order });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const n = (s: string) => (s.trim() === '' ? null : Number(s));
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      onDone(await put(`/admin/plans/${f.code}`, { name: f.name, description: f.description.trim() || null, monthlyPrice: n(f.monthly), yearlyPrice: n(f.yearly), currency: f.currency,
        maxDoctors: n(f.maxDoctors), maxAssistants: n(f.maxAssistants), maxLocations: n(f.maxLocations), maxPatients: n(f.maxPatients),
        features: f.features, appliesTo: f.appliesTo, isPublic: f.isPublic, isActive: f.isActive, sortOrder: Number(f.sortOrder) }));
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={plan.isNew ? 'New plan' : `Edit ${plan.name}`} wide>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="Code" hint="lowercase, cannot change later"><Input required pattern="[a-z][a-z0-9_]*" disabled={!plan.isNew} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></Field>
        <Field label="Name"><Input required minLength={2} maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Description" className="sm:col-span-2"><Textarea maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Monthly price" hint="Empty: on request (arranged by MEDORA)"><Input type="number" min={0} step="0.01" value={f.monthly} onChange={(e) => setF({ ...f, monthly: e.target.value })} /></Field>
        <Field label="Yearly price"><Input type="number" min={0} step="0.01" value={f.yearly} onChange={(e) => setF({ ...f, yearly: e.target.value })} /></Field>
        <Field label="Currency"><Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>USD</option><option>LBP</option></Select></Field>
        <Field label="Order"><Input type="number" min={0} value={f.sortOrder} onChange={(e) => setF({ ...f, sortOrder: Number(e.target.value) })} /></Field>
        <Field label="Max doctors" hint="Empty: unlimited"><Input type="number" min={1} value={f.maxDoctors} onChange={(e) => setF({ ...f, maxDoctors: e.target.value })} /></Field>
        <Field label="Max other staff"><Input type="number" min={0} value={f.maxAssistants} onChange={(e) => setF({ ...f, maxAssistants: e.target.value })} /></Field>
        <Field label="Max locations"><Input type="number" min={1} value={f.maxLocations} onChange={(e) => setF({ ...f, maxLocations: e.target.value })} /></Field>
        <Field label="Max patients"><Input type="number" min={1} value={f.maxPatients} onChange={(e) => setF({ ...f, maxPatients: e.target.value })} /></Field>
        <div className="sm:col-span-2"><p className="mb-1 text-sm font-medium">Features</p><div className="grid gap-2 sm:grid-cols-2">{features.map((x) => (
          <label key={x.code} className="flex items-center gap-2 text-sm"><Switch checked={!!f.features[x.code]} onChange={(v) => setF({ ...f, features: { ...f.features, [x.code]: v } })} label={x.description} />{x.description}</label>))}</div></div>
        <div className="sm:col-span-2"><p className="mb-1 text-sm font-medium">Offered to</p><div className="flex gap-4">{KINDS.map(([k, l]) => (
          <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={f.appliesTo.includes(k)} onChange={(e) => setF({ ...f, appliesTo: e.target.checked ? [...f.appliesTo, k] : f.appliesTo.filter((x) => x !== k) })} />{l}</label>))}</div></div>
        <label className="flex items-center gap-2 text-sm"><Switch checked={f.isPublic} onChange={(v) => setF({ ...f, isPublic: v })} label="Shown to workspaces" />Shown to workspaces</label>
        <label className="flex items-center gap-2 text-sm"><Switch checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} label="Active" />Active (retire it by switching off)</label>
        <div className="sm:col-span-2"><ErrorNote error={err} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy}>Save plan</Button></div>
      </form>
    </Dialog>
  );
}
