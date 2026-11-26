'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Dialog, Empty, ErrorNote, Field, Input, Textarea, fmtDate, fmtTime } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { PatientForm } from '@/components/PatientForm';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';

export default function Patients() {
  const { t, lang } = useI18n(); const { can, orgId, org } = useWorkspace(); const router = useRouter();
  const [q, setQ] = useState(''); const [rows, setRows] = useState<any[] | null>(null); const [open, setOpen] = useState(false); const [emerg, setEmerg] = useState(false);
  useEffect(() => { if (new URLSearchParams(window.location.search).get('new')) setOpen(true); }, []);
  useEffect(() => { const h = setTimeout(() => get(`/patients?q=${encodeURIComponent(q)}&limit=50`).then(setRows).catch(() => setRows([])), 200); return () => clearTimeout(h); }, [q]);
  if (!can('patient.file.read')) return <Forbidden />;
  return (
    <>
      <PageTitle title={t('patients')} actions={<div className="flex gap-2">
        {/* A doctor in a center can open a colleague's private patient file in an emergency (recorded). */}
        {org.organization.kind === 'medical_center' && !!org.me.doctorMembershipId && can('clinical_notes.read') && !org.organization.share_patients_between_doctors &&
          <Button variant="secondary" onClick={() => setEmerg(true)}>{t('openInEmergency')}</Button>}
        {can('patient.register') && <Button onClick={() => setOpen(true)}>{t('addPatient')}</Button>}</div>} />
      <Card>
        <Input autoFocus placeholder={`${t('search')}: name, phone, P-000123`} value={q} onChange={(e) => setQ(e.target.value)} className="mb-4" />
        {rows === null ? <p className="text-sm text-muted">{t('loading')}</p> : rows.length === 0 ? <Empty>{t('none')}</Empty> :
          <div className="overflow-x-auto"><table className="w-full text-sm">
            <thead className="text-start text-xs uppercase text-muted"><tr><th className="py-2 text-start">{t('patientNumber')}</th><th className="text-start">{t('fullName')}</th><th className="text-start">{t('dateOfBirth')}</th><th className="text-start">{t('phone')}</th><th className="text-start">{t('nextAppointment')}</th></tr></thead>
            <tbody className="divide-y divide-line">{rows.map((p) => (
              <tr key={p.id} className="cursor-pointer hover:bg-surface" onClick={() => router.push(`/w/${orgId}/patients/${p.id}`)}>
                <td className="tabular py-2.5 text-muted">{p.patient_number}</td><td className="font-medium"><Link href={`/w/${orgId}/patients/${p.id}`}>{p.full_name}</Link></td>
                <td>{p.date_of_birth ? fmtDate(p.date_of_birth, lang) : '—'}</td><td className="tabular">{p.phone ?? '—'}</td>
                <td>{p.next_appointment ? `${fmtDate(p.next_appointment, lang)} ${fmtTime(p.next_appointment, lang)}` : '—'}</td>
              </tr>))}</tbody></table></div>}
      </Card>
      <EmergencyDialog open={emerg} onClose={() => setEmerg(false)} onOpened={(id) => router.push(`/w/${orgId}/patients/${id}`)} />
      <Dialog open={open} onClose={() => setOpen(false)} title={t('addPatient')} wide>
        <PatientForm askDoctor submitLabel={t('save')} onSubmit={async (b) => { const p = await post('/patients', b); router.push(`/w/${orgId}/patients/${p.id}`); }} />
      </Dialog>
    </>
  );
}

function EmergencyDialog({ open, onClose, onOpened }: { open: boolean; onClose: () => void; onOpened: (id: string) => void }) {
  const { t } = useI18n(); const [q, setQ] = useState(''); const [reason, setReason] = useState('');
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setQ(''); setReason(''); setErr(null); } }, [open]);
  const go = async () => { setBusy(true); setErr(null); try { const p = await post('/patients/emergency-access', { query: q.trim(), reason: reason.trim() }); onOpened(p.id); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return <Dialog open={open} onClose={onClose} title={t('emergencyAccess')}>
    <p className="mb-3 text-sm text-muted">{t('emergencyHint')}</p>
    <div className="grid gap-3">
      <Field label={t('patientNumberOrPhone')}><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="P-000123" /></Field>
      <Field label={t('reason')}><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorNote error={err} />
      <div className="flex justify-end"><Button busy={busy} disabled={q.trim().length < 3 || reason.trim().length < 5} onClick={go}>{t('openFile')}</Button></div>
    </div>
  </Dialog>;
}
