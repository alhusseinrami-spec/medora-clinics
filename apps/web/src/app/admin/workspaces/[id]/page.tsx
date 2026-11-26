'use client';
import Link from 'next/link';
import { use, useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, Select, Textarea, fmtDate } from '@/components/ui';
import { get, patch, post } from '@/lib/api';
import { STATUS_LABEL, usd } from '@/lib/admin';
import { toLocalInput } from '@/lib/hooks';

export default function AdminWorkspace({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [w, setW] = useState<any>(null); const [plans, setPlans] = useState<any[]>([]); const [err, setErr] = useState<unknown>(null);
  const [dlg, setDlg] = useState<null | 'sub' | 'pay' | 'suspend'>(null);
  const load = () => get(`/admin/workspaces/${id}`, null).then(setW).catch(setErr);
  useEffect(() => { load(); get('/admin/plans', null).then((p) => setPlans(p.plans)).catch(() => {}); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);
  if (!w) return <ErrorNote error={err} />;
  const s = w.subscription;
  const refund = async (pid: string) => { if (!confirm('Mark this payment as refunded? The paid period is not shortened automatically; adjust it with "Edit subscription" if needed.')) return; try { await post(`/admin/payments/${pid}/refund`); load(); } catch (x) { setErr(x); } };
  const reactivate = async () => { try { setW(await post(`/admin/workspaces/${id}/status`, { status: 'active', reason: null })); } catch (x) { setErr(x); } };
  return (
    <>
      <Link href="/admin/workspaces" className="text-sm text-muted hover:text-ink">← Workspaces</Link>
      <div className="mb-6 mt-2 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">{w.name}</h1>
          <p className="text-sm text-muted">{w.kind === 'medical_center' ? 'Medical center' : 'Independent practice'} · opened {fmtDate(w.created_at)} by {w.owner_name} ({w.owner_email})</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setDlg('sub')}>Edit subscription</Button>
          <Button onClick={() => setDlg('pay')}>Record payment</Button>
          {w.status === 'suspended' ? <Button variant="secondary" onClick={reactivate}>Reactivate workspace</Button> : <Button variant="danger" onClick={() => setDlg('suspend')}>Suspend workspace</Button>}
        </div>
      </div>
      <ErrorNote error={err} />
      {w.status === 'suspended' && <p className="mb-4 rounded-[10px] bg-danger/10 p-3 text-sm text-danger">This workspace is suspended: its members cannot open it.</p>}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Subscription">
          <p className="text-xl font-semibold">{s.plan_name} <Badge status={s.effective_status}>{STATUS_LABEL[s.effective_status] ?? s.effective_status}</Badge></p>
          <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">Price</dt><dd>{usd(s.price)} / {s.billing_cycle === 'yearly' ? 'year' : 'month'}</dd>
            {s.status === 'trial' && <><dt className="text-muted">Trial ends</dt><dd>{fmtDate(s.trial_ends_at)}</dd></>}
            <dt className="text-muted">Paid until</dt><dd>{s.current_period_end ? fmtDate(s.current_period_end) : '—'}</dd>
            <dt className="text-muted">Can change data</dt><dd>{s.usable ? 'Yes' : 'No (read only)'}</dd>
            {s.cancel_at_period_end && <><dt className="text-muted">Cancellation</dt><dd className="text-warning">At period end</dd></>}
          </dl>
        </Card>
        <Card title="Usage">
          <ul className="space-y-1 text-sm">{[['Doctors', w.usage.doctors, s.max_doctors], ['Other staff', w.usage.assistants, s.max_assistants], ['Locations', w.usage.locations, s.max_locations], ['Patients', w.usage.patients, s.max_patients]].map(([l, u, m]) =>
            <li key={l as string} className="flex justify-between"><span>{l}</span><span className="tabular">{u} / {m ?? '∞'}</span></li>)}
            <li className="flex justify-between border-t border-line pt-1"><span>Appointments, 30 days</span><span className="tabular">{w.usage.appointments_30d}</span></li>
            <li className="flex justify-between"><span>WhatsApp sent, 30 days</span><span className="tabular">{w.usage.messages_30d}</span></li>
            <li className="flex justify-between"><span>Stored documents</span><span className="tabular">{(Number(w.usage.storage_bytes) / 1048576).toFixed(1)} MB</span></li>
          </ul>
        </Card>
        <Card title="Members">
          <ul className="space-y-1 text-sm">{w.members.map((m: any, i: number) => <li key={i} className="flex justify-between gap-2"><span className="truncate">{m.name}<span className="block text-xs text-muted">{m.email}</span></span><span className="text-xs text-muted">{m.role.replace(/_/g, ' ')}{m.status !== 'active' ? ` · ${m.status}` : ''}</span></li>)}</ul>
        </Card>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card title="Payments">
          {w.payments.length === 0 ? <p className="text-sm text-muted">No payments recorded.</p> : <table className="w-full text-sm"><tbody className="divide-y divide-line">{w.payments.map((p: any) => (
            <tr key={p.id}><td className="py-2">{fmtDate(p.created_at)}</td><td className="tabular">{p.currency === 'USD' ? usd(p.amount) : `${Number(p.amount).toLocaleString()} LBP`}</td><td className="text-xs text-muted">{p.method}{p.reference ? ` · ${p.reference}` : ''}<br />{fmtDate(p.period_start)} – {fmtDate(p.period_end)}</td>
              <td>{p.status === 'paid' ? <button className="text-xs text-muted hover:text-danger" onClick={() => refund(p.id)}>Refund</button> : <Badge status="refunded">refunded</Badge>}</td></tr>))}</tbody></table>}
        </Card>
        <Card title="History">
          <ul className="space-y-1.5 text-sm">{w.events.map((e: any) => <li key={e.id} className="flex justify-between gap-3"><span>{e.kind.replace(/_/g, ' ')}{e.to_plan && e.from_plan && e.from_plan !== e.to_plan ? ` · ${e.from_plan} → ${e.to_plan}` : ''}{e.from_status && e.to_status && e.from_status !== e.to_status ? ` · ${e.from_status} → ${e.to_status}` : ''}{e.details?.note ? ` · ${e.details.note}` : ''}{e.details?.reason ? ` · ${e.details.reason}` : ''}</span><span className="shrink-0 text-xs text-muted">{fmtDate(e.created_at)}{e.actor_name ? ` · ${e.actor_name}` : ''}</span></li>)}</ul>
        </Card>
      </div>
      {dlg === 'sub' && <SubDialog w={w} plans={plans} onClose={() => setDlg(null)} onDone={(x) => { setW(x); setDlg(null); }} />}
      {dlg === 'pay' && <PayDialog w={w} onClose={() => setDlg(null)} onDone={(x) => { setW(x); setDlg(null); }} />}
      {dlg === 'suspend' && <SuspendDialog w={w} onClose={() => setDlg(null)} onDone={(x) => { setW(x); setDlg(null); }} />}
    </>
  );
}

function SubDialog({ w, plans, onClose, onDone }: { w: any; plans: any[]; onClose: () => void; onDone: (x: any) => void }) {
  const s = w.subscription;
  const [f, setF] = useState({ plan: s.plan_code, status: s.status, cycle: s.billing_cycle, trialEndsAt: s.trial_ends_at ? toLocalInput(new Date(s.trial_ends_at)) : '',
    periodEnd: s.current_period_end ? toLocalInput(new Date(s.current_period_end)) : '', price: '', clearPrice: false, note: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    const body: any = { note: f.note.trim() || null, price: f.clearPrice ? null : undefined };
    if (f.plan !== s.plan_code) body.plan = f.plan;
    if (f.status !== s.status) body.status = f.status;
    if (f.cycle !== s.billing_cycle) body.cycle = f.cycle;
    if (f.trialEndsAt && (!s.trial_ends_at || toLocalInput(new Date(s.trial_ends_at)) !== f.trialEndsAt)) body.trialEndsAt = new Date(f.trialEndsAt).toISOString();
    if (f.periodEnd && (!s.current_period_end || toLocalInput(new Date(s.current_period_end)) !== f.periodEnd)) body.periodEnd = new Date(f.periodEnd).toISOString();
    if (!f.clearPrice && f.price !== '') body.price = Number(f.price);
    if (body.price === undefined) delete body.price;
    try { onDone(await patch(`/admin/workspaces/${w.id}/subscription`, body)); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Edit subscription" wide>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="Plan"><Select value={f.plan} onChange={(e) => setF({ ...f, plan: e.target.value })}>{plans.filter((p) => p.applies_to.includes(w.kind)).map((p) => <option key={p.code} value={p.code}>{p.name}{p.is_active ? '' : ' (retired)'}</option>)}</Select></Field>
        <Field label="Status"><Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>{['trial', 'active', 'past_due', 'cancelled', 'suspended'].map((k) => <option key={k} value={k}>{STATUS_LABEL[k]}</option>)}</Select></Field>
        <Field label="Billing"><Select value={f.cycle} onChange={(e) => setF({ ...f, cycle: e.target.value })}><option value="monthly">Monthly</option><option value="yearly">Yearly</option></Select></Field>
        <Field label="Trial ends (extend a trial here)"><Input type="datetime-local" value={f.trialEndsAt} onChange={(e) => setF({ ...f, trialEndsAt: e.target.value })} /></Field>
        <Field label="Paid until"><Input type="datetime-local" value={f.periodEnd} onChange={(e) => setF({ ...f, periodEnd: e.target.value })} /></Field>
        <Field label="Negotiated price (empty keeps the current one)" hint={f.clearPrice ? 'The plan price will apply again.' : undefined}>
          <div className="flex items-center gap-2"><Input type="number" min={0} step="0.01" disabled={f.clearPrice} value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} />
            <label className="flex shrink-0 items-center gap-1 text-xs"><input type="checkbox" checked={f.clearPrice} onChange={(e) => setF({ ...f, clearPrice: e.target.checked })} /> Use plan price</label></div></Field>
        <Field label="Note (kept in the history)" className="sm:col-span-2"><Textarea maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <div className="sm:col-span-2"><ErrorNote error={err} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy}>Save</Button></div>
      </form>
    </Dialog>
  );
}

function PayDialog({ w, onClose, onDone }: { w: any; onClose: () => void; onDone: (x: any) => void }) {
  const s = w.subscription;
  const [f, setF] = useState({ amount: s.price != null ? String(s.price) : '', currency: 'USD', method: 'bank_transfer', reference: '', months: s.billing_cycle === 'yearly' ? 12 : 1 });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { onDone(await post(`/admin/workspaces/${w.id}/payments`, { amount: Number(f.amount), currency: f.currency, method: f.method, reference: f.reference.trim() || null, months: Number(f.months) })); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title="Record a payment">
      <p className="mb-3 text-sm text-muted">Records money MEDORA already received (transfer, cash, OMT, Whish…). The subscription becomes active until the end of the period paid for. No card is charged.</p>
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <Field label="Amount"><Input type="number" required min={0.01} step="0.01" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Field label="Currency"><Select value={f.currency} onChange={(e) => setF({ ...f, currency: e.target.value })}><option>USD</option><option>LBP</option></Select></Field>
        <Field label="Method"><Select value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{['bank_transfer', 'cash', 'omt', 'whish', 'card', 'cheque', 'other'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}</Select></Field>
        <Field label="Months covered"><Input type="number" required min={1} max={36} value={f.months} onChange={(e) => setF({ ...f, months: Number(e.target.value) })} /></Field>
        <Field label="Reference" className="sm:col-span-2"><Input maxLength={200} value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <div className="sm:col-span-2"><ErrorNote error={err} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button busy={busy}>Record payment</Button></div>
      </form>
    </Dialog>
  );
}

function SuspendDialog({ w, onClose, onDone }: { w: any; onClose: () => void; onDone: (x: any) => void }) {
  const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const go = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { onDone(await post(`/admin/workspaces/${w.id}/status`, { status: 'suspended', reason })); } catch (x) { setErr(x); } finally { setBusy(false); } };
  return (
    <Dialog open onClose={onClose} title={`Suspend ${w.name}`}>
      <form onSubmit={go} className="space-y-3">
        <p className="text-sm">Members can no longer open this workspace until it is reactivated. Nothing is deleted.</p>
        <Field label="Reason (kept in the history)"><Textarea required minLength={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
        <ErrorNote error={err} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>Cancel</Button><Button variant="danger" busy={busy}>Suspend</Button></div>
      </form>
    </Dialog>
  );
}
