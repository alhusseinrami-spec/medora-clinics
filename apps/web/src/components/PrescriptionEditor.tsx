'use client';
import { useEffect, useRef, useState } from 'react';
import { Badge, Button, Dialog, ErrorNote, Field, Input, Textarea, fmtDate } from './ui';
import { del, get, patch, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';

export interface RxItem { medicationId: string | null; medicationName: string; dosage: string | null; frequency: string | null; duration: string | null; instructions: string | null; notes: string | null }
const blank = (): RxItem => ({ medicationId: null, medicationName: '', dosage: null, frequency: null, duration: null, instructions: null, notes: null });
const fromApi = (i: any): RxItem => ({ medicationId: i.medication_id ?? i.medicationId ?? null, medicationName: i.medication_name ?? i.medicationName, dosage: i.dosage ?? null,
  frequency: i.frequency ?? null, duration: i.duration ?? null, instructions: i.instructions ?? null, notes: i.notes ?? null });
const medLabel = (m: any) => [m.name, m.strength, m.form].filter(Boolean).join(' ');

/** Search-as-you-type over the generic catalog and the workspace's own medications. */
function MedicationInput({ value, onPick, onType }: { value: string; onPick: (m: any) => void; onType: (s: string) => void }) {
  const { t } = useI18n(); const [opts, setOpts] = useState<any[]>([]); const [open, setOpen] = useState(false); const timer = useRef<any>(null);
  useEffect(() => {
    clearTimeout(timer.current);
    if (!open || value.trim().length < 2) { setOpts([]); return; }
    timer.current = setTimeout(() => get<any[]>(`/medications?q=${encodeURIComponent(value.trim())}`).then(setOpts).catch(() => setOpts([])), 200);
  }, [value, open]);
  return <div className="relative">
    <Input value={value} placeholder={t('searchMedication')} onChange={(e) => { onType(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)} />
    {open && opts.length > 0 && <ul className="absolute z-30 mt-1 max-h-60 w-full overflow-auto rounded-[10px] border border-line bg-card py-1 shadow-lg">
      {opts.map((m) => <li key={m.id}><button type="button" className="block w-full px-3 py-1.5 text-start text-sm hover:bg-surface" onMouseDown={() => { onPick(m); setOpen(false); }}>
        {medLabel(m)}{m.custom && <span className="ms-2 text-xs text-muted">★</span>}</button></li>)}
    </ul>}
  </div>;
}

export function PrescriptionEditor({ rx, onChange }: { rx: any; onChange: (rx: any | null) => void }) {
  const { t, lang } = useI18n(); const { orgId } = useWorkspace();
  const [items, setItems] = useState<RxItem[]>(() => (rx.items?.length ? rx.items.map(fromApi) : [blank()]));
  const [notes, setNotes] = useState<string>(rx.notes ?? ''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const [tplOpen, setTplOpen] = useState(false); const [cancelOpen, setCancelOpen] = useState(false);
  const draft = rx.status === 'draft';
  const setItem = (i: number, p: Partial<RxItem>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...p } : x)));
  const payload = () => ({ notes: notes.trim() || null, items: items.filter((i) => i.medicationName.trim()).map((i) => ({ ...i, medicationName: i.medicationName.trim() })) });
  const run = async (k: string, fn: () => Promise<any>) => { setBusy(k); setErr(null); try { const r = await fn(); if (r !== undefined) onChange(r); } catch (e) { setErr(e); } finally { setBusy(null); } };
  const save = () => run('save', () => patch(`/prescriptions/${rx.id}`, payload()));
  const issue = () => { if (!confirm(t('issueConfirm'))) return; run('issue', async () => { await patch(`/prescriptions/${rx.id}`, payload()); return post(`/prescriptions/${rx.id}/issue`); }); };
  const removeDraft = () => run('del', async () => { await del(`/prescriptions/${rx.id}`); return null; });
  const printHref = `/print/prescriptions/${rx.id}?org=${orgId}`;

  if (!draft) return <div className="space-y-3">
    <div className="flex flex-wrap items-center gap-2">
      <Badge status={rx.status === 'issued' ? 'issued' : 'cancelled'}>{rx.status === 'issued' ? t('issued') : t('cancelledRx')}</Badge>
      <span className="text-xs text-muted tabular">{rx.issued_at && fmtDate(rx.issued_at, lang)} · {rx.doctor_name}</span>
      {rx.shared_with_patient && <Badge>{t('sharedWithPatient')}</Badge>}
    </div>
    <ol className="list-decimal space-y-1 ps-5 text-sm">{rx.items.map((i: any) => <li key={i.id}><span className="font-medium">{i.medication_name}</span>
      {[i.dosage, i.frequency, i.duration].filter(Boolean).length > 0 && <span className="text-muted"> · {[i.dosage, i.frequency, i.duration].filter(Boolean).join(' · ')}</span>}
      {i.instructions && <span className="block text-xs text-muted">{i.instructions}</span>}</li>)}</ol>
    {rx.notes && <p className="text-sm text-muted">{rx.notes}</p>}
    {rx.status === 'cancelled' && <p className="text-sm text-danger">{t('cancelReason')}: {rx.cancel_reason}</p>}
    {rx.status === 'issued' && <div className="flex flex-wrap items-center gap-2">
      <a href={printHref} target="_blank" rel="noopener" className="inline-flex h-8 items-center rounded-[10px] bg-brand px-3 text-sm font-medium text-white hover:opacity-90">{t('print')}</a>
      <Button size="sm" variant="secondary" busy={busy === 'share'} onClick={() => run('share', () => post(`/prescriptions/${rx.id}/share`, { shared: !rx.shared_with_patient }))}>{rx.shared_with_patient ? t('unshare') : t('share')}</Button>
      <Button size="sm" variant="ghost" onClick={() => setCancelOpen(true)}>{t('cancelRx')}</Button>
    </div>}
    {rx.status === 'issued' && <p className="text-xs text-muted">{t('shareNote')}</p>}
    <ErrorNote error={err} />
    <CancelDialog open={cancelOpen} onClose={() => setCancelOpen(false)} onConfirm={(reason) => run('cancel', () => post(`/prescriptions/${rx.id}/cancel`, { reason })).then(() => setCancelOpen(false))} />
  </div>;

  return <div className="space-y-3">
    <div className="space-y-3">{items.map((it, i) => <div key={i} className="rounded-[10px] border border-line p-3">
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:items-end">
        <Field label={`${i + 1}. ${t('medication')}`}><MedicationInput value={it.medicationName} onType={(s) => setItem(i, { medicationName: s, medicationId: null })} onPick={(m) => setItem(i, { medicationName: medLabel(m), medicationId: m.id })} /></Field>
        <Field label={t('dosage')}><Input value={it.dosage ?? ''} onChange={(e) => setItem(i, { dosage: e.target.value || null })} placeholder="5 ml" /></Field>
        <Field label={t('frequency')}><Input value={it.frequency ?? ''} onChange={(e) => setItem(i, { frequency: e.target.value || null })} placeholder="3×/day" /></Field>
        <Field label={t('duration')}><Input value={it.duration ?? ''} onChange={(e) => setItem(i, { duration: e.target.value || null })} placeholder="7 days" /></Field>
        <Button size="sm" variant="ghost" aria-label={t('remove')} onClick={() => setItems((xs) => (xs.length > 1 ? xs.filter((_, j) => j !== i) : [blank()]))}>✕</Button>
      </div>
      <Input className="mt-2" value={it.instructions ?? ''} onChange={(e) => setItem(i, { instructions: e.target.value || null })} placeholder={t('instructions')} />
      {it.medicationName.trim().length > 1 && !it.medicationId && <button type="button" className="mt-1 text-xs text-brand hover:underline"
        onClick={() => run('med', async () => { const m = await post('/medications', { name: it.medicationName.trim(), strength: null, form: null, route: null }); setItem(i, { medicationId: m.id }); })}>+ {t('addCustomMedication')}</button>}
    </div>)}</div>
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" onClick={() => setItems((xs) => [...xs, blank()])}>+ {t('addMedication')}</Button>
      <Button size="sm" variant="ghost" onClick={() => setTplOpen(true)}>{t('templates')}</Button>
    </div>
    <Field label={t('rxNotes')}><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
    <ErrorNote error={err} />
    <div className="flex flex-wrap justify-end gap-2">
      <Button variant="ghost" busy={busy === 'del'} onClick={removeDraft}>{t('deleteDraft')}</Button>
      <Button variant="secondary" busy={busy === 'save'} onClick={save}>{t('save')}</Button>
      <Button busy={busy === 'issue'} onClick={issue}>{t('issue')}</Button>
    </div>
    <TemplatesDialog open={tplOpen} onClose={() => setTplOpen(false)} current={payload()} onUse={(tplItems) => { setItems((xs) => [...xs.filter((x) => x.medicationName.trim()), ...tplItems.map(fromApi)]); setTplOpen(false); }} />
  </div>;
}

function CancelDialog({ open, onClose, onConfirm }: { open: boolean; onClose: () => void; onConfirm: (reason: string) => void }) {
  const { t } = useI18n(); const [reason, setReason] = useState('');
  return <Dialog open={open} onClose={onClose} title={t('cancelRx')}>
    <Field label={t('cancelReason')}><Textarea value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    <div className="mt-4 flex justify-end"><Button disabled={reason.trim().length < 3} onClick={() => onConfirm(reason.trim())}>{t('cancelRx')}</Button></div>
  </Dialog>;
}

function TemplatesDialog({ open, onClose, current, onUse }: { open: boolean; onClose: () => void; current: { notes: string | null; items: RxItem[] }; onUse: (items: any[]) => void }) {
  const { t } = useI18n(); const [list, setList] = useState<any[] | null>(null); const [name, setName] = useState(''); const [err, setErr] = useState<unknown>(null);
  const load = () => get<any[]>('/prescription-templates').then(setList).catch(setErr);
  useEffect(() => { if (open) load(); }, [open]);
  return <Dialog open={open} onClose={onClose} title={t('templates')}>
    <div className="space-y-4">
      {list && list.length > 0 && <ul className="divide-y divide-line">{list.map((tp) => <li key={tp.id} className="flex items-center justify-between gap-2 py-2">
        <div><p className="font-medium">{tp.name}</p><p className="text-xs text-muted">{tp.items.map((i: any) => i.medicationName).join(', ')}</p></div>
        <div className="flex gap-1"><Button size="sm" onClick={() => onUse(tp.items)}>{t('useTemplate')}</Button>
          <Button size="sm" variant="ghost" aria-label={t('remove')} onClick={async () => { try { await del(`/prescription-templates/${tp.id}`); load(); } catch (e) { setErr(e); } }}>✕</Button></div>
      </li>)}</ul>}
      <div className="rounded-[10px] border border-line p-3">
        <Field label={t('templateName')}><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="mt-2 flex justify-end"><Button size="sm" variant="secondary" disabled={!name.trim() || !current.items.length}
          onClick={async () => { try { await post('/prescription-templates', { name: name.trim(), notes: current.notes, items: current.items }); setName(''); load(); } catch (e) { setErr(e); } }}>{t('saveAsTemplate')}</Button></div>
      </div>
      <ErrorNote error={err} />
    </div>
  </Dialog>;
}

/** Starts a new draft prescription and hands it to the editor. */
export async function newPrescription(patientId: string, consultationId?: string) {
  return post('/prescriptions', { patientId, consultationId, notes: null, items: [] });
}

