'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, Input, Tabs, fmtDate } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { PatientPicker } from '@/components/AppointmentDialog';
import { PrescriptionEditor, newPrescription } from '@/components/PrescriptionEditor';
import { get } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad } from '@/lib/hooks';

/** Every prescription the user may see, newest first. Each one prints in English, French or Arabic. */
export default function Prescriptions() {
  const { t, lang } = useI18n(); const { can, orgId } = useWorkspace();
  const [tab, setTab] = useState('all'); const [q, setQ] = useState('');
  const [open, setOpen] = useState<any>(null); const [picking, setPicking] = useState(false); const [err, setErr] = useState<unknown>(null);
  const params = new URLSearchParams({ ...(tab !== 'all' ? { status: tab } : {}), ...(q.trim().length > 1 ? { q: q.trim() } : {}) });
  const { data, error, reload } = useLoad<any[]>(`/prescriptions?${params}`, [tab, q]);
  if (!can('prescription.view')) return <Forbidden />;
  const edit = async (id: string) => { try { setOpen(await get(`/prescriptions/${id}`)); } catch (e) { setErr(e); } };
  const status = (s: string) => s === 'draft' ? <Badge status="draft">{t('draft')}</Badge> : s === 'issued' ? <Badge status="completed">{t('locked')}</Badge> : <Badge status="cancelled">{t('cancelledRx')}</Badge>;
  return <>
    <PageTitle title={t('prescriptions')} actions={can('prescription.create') && <Button onClick={() => setPicking(true)}>+ {t('newPrescription')}</Button>} />
    <div className="flex flex-wrap items-end justify-between gap-3">
      <Tabs tabs={[{ key: 'all', label: t('all') }, { key: 'draft', label: t('drafts') }, { key: 'issued', label: t('locked') }, { key: 'cancelled', label: t('cancelledRx') }]} value={tab} onChange={setTab} />
      <Input className="!w-64" placeholder={`${t('search')}…`} value={q} onChange={(e) => setQ(e.target.value)} />
    </div>
    <div className="mt-4"><ErrorNote error={error ?? err} /></div>
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>{t('noPrescriptions')}</Empty> :
      <div className="grid gap-4 md:grid-cols-2">{data.map((r) => <Card key={r.id}>
        <div className="flex items-start justify-between gap-3">
          <div><Link className="text-lg font-medium hover:underline" href={`/w/${orgId}/patients/${r.patient_id}`}>{r.patient_name}</Link>
            <p className="text-sm text-muted">{r.doctor_name} · {fmtDate(r.issued_at ?? r.created_at, lang)} <span className="tabular">· {r.patient_number}</span></p></div>
          {status(r.status)}
        </div>
        <ul className="mt-3 space-y-1 text-sm">{r.items.length === 0 ? <li className="text-muted">—</li> : r.items.map((i: any, n: number) =>
          <li key={n}><span className="font-medium">{i.name}</span>{(i.dosage || i.frequency) && <span className="text-muted"> — {[i.dosage, i.frequency].filter(Boolean).join(' · ')}</span>}</li>)}</ul>
        <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-line pt-3 text-sm">
          {r.status === 'draft' && can('prescription.create') && <Button size="sm" variant="secondary" onClick={() => edit(r.id)}>{t('edit')}</Button>}
          {r.status !== 'draft' && <Button size="sm" variant="ghost" onClick={() => edit(r.id)}>{t('open')}</Button>}
          <span className="ms-auto text-muted">{t('printIn')}</span>
          {(['en', 'fr', 'ar'] as const).map((l) => <a key={l} href={`/print/prescriptions/${r.id}?org=${orgId}&lang=${l}`} target="_blank" rel="noopener"
            className="inline-flex h-8 items-center rounded-[10px] px-2 font-medium uppercase text-brand hover:bg-surface">{l}</a>)}
        </div>
      </Card>)}</div>}
    <NewRx open={picking} onClose={() => setPicking(false)} onCreated={(rx) => { setPicking(false); setOpen(rx); }} />
    {open && <PrescriptionEditor key={open.id + open.status} rx={open} onChange={(n) => { if (n === null) { setOpen(null); reload(); } else setOpen(n); }} />}
  </>;
}

function NewRx({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (rx: any) => void }) {
  const { t } = useI18n(); const [patient, setPatient] = useState<any>(null); const [err, setErr] = useState<unknown>(null);
  return <Dialog open={open} onClose={onClose} title={t('newPrescription')}>
    <Field label={t('patients')}><PatientPicker value={patient} onChange={setPatient} /></Field>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button disabled={!patient} onClick={async () => { try { onCreated(await newPrescription(patient.id)); } catch (e) { setErr(e); } }}>{t('newPrescription')}</Button></div>
  </Dialog>;
}
