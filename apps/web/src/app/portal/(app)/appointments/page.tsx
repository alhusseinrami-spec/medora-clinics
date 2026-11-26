'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, Input, Select, Textarea, fmtDate, fmtTime } from '@/components/ui';
import { get, post } from '@/lib/api';
import { dayKey } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { usePortal } from '@/lib/portal';

export default function PortalAppointments() {
  const { t, lang, status } = useI18n(); const { records } = usePortal();
  const [appts, setAppts] = useState<any[] | null>(null); const [reqs, setReqs] = useState<any[]>([]); const [err, setErr] = useState<unknown>(null);
  const [cancel, setCancel] = useState<any>(null);
  const load = () => {
    get<any[]>('/portal/appointments', null).then(setAppts).catch(setErr);
    get<any[]>('/portal/requests', null).then(setReqs).catch(setErr);
  };
  useEffect(() => { load(); const f = () => document.visibilityState === 'visible' && load(); document.addEventListener('visibilitychange', f); return () => document.removeEventListener('visibilitychange', f); }, []);
  const now = new Date();
  const upcoming = (appts ?? []).filter((a) => new Date(a.starts_at) >= now && !['cancelled', 'no_show', 'completed'].includes(a.status)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const past = (appts ?? []).filter((a) => !upcoming.includes(a));
  const withdraw = async (id: string) => { try { await post(`/portal/requests/${id}/cancel`); load(); } catch (x) { setErr(x); } };
  const Row = ({ a }: { a: any }) => (
    <li className="py-3 text-sm">
      <div className="flex items-start justify-between gap-3">
        <div><p className="font-semibold">{fmtDate(a.starts_at, lang)} · {fmtTime(a.starts_at, lang)}</p>
          <p>{a.doctor_name}{a.service_name ? ` · ${a.service_name}` : ''}</p>
          <p className="text-muted">{a.clinic}{a.location_name ? ` · ${a.location_name}` : ''}</p></div>
        <Badge status={a.status}>{status(a.status)}</Badge>
      </div>
      {upcoming.includes(a) && (a.can_cancel ? <button onClick={() => setCancel(a)} className="mt-2 text-sm text-danger hover:underline">{t('pCancelVisit')}</button>
        : <p className="mt-2 text-xs text-muted">{t('pCancelTooLate')}</p>)}
    </li>
  );
  return (
    <div className="space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">{t('pAppointments')}</h1>
      <ErrorNote error={err} />
      <Card title={t('pUpcoming')}>{appts === null ? <p className="text-sm text-muted">{t('loading')}</p> : upcoming.length ? <ul className="divide-y divide-line">{upcoming.map((a) => <Row key={a.id} a={a} />)}</ul> : <Empty>{t('pNoUpcoming')}</Empty>}</Card>
      <div id="request"><RequestForm records={records} onSent={load} /></div>
      <Card title={t('pRequests')}>
        {reqs.length ? <ul className="divide-y divide-line">{reqs.map((r) => <li key={r.id} className="py-3 text-sm">
          <div className="flex items-start justify-between gap-3">
            <div><p className="font-medium">{fmtDate(r.preferred_date, lang)} · {t(`t_${r.preferred_time}`)}</p>
              <p className="text-muted">{r.clinic}{r.doctor_name ? ` · ${r.doctor_name}` : ''}</p>
              {r.appointment_starts_at && <p className="text-brand">{fmtDate(r.appointment_starts_at, lang)} · {fmtTime(r.appointment_starts_at, lang)}</p>}
              {r.answer_note && <p className="mt-1"><span className="text-muted">{t('pClinicAnswer')}:</span> {r.answer_note}</p>}</div>
            <Badge status={r.status === 'accepted' ? 'confirmed' : r.status === 'pending' ? 'scheduled' : 'cancelled'}>{t(`rq_${r.status}`)}</Badge>
          </div>
          {r.status === 'pending' && <button onClick={() => withdraw(r.id)} className="mt-2 text-sm text-muted hover:text-danger">{t('pWithdraw')}</button>}
        </li>)}</ul> : <Empty>{t('pNoRequests')}</Empty>}
      </Card>
      {past.length > 0 && <Card title={t('pPast')}><ul className="divide-y divide-line">{past.map((a) => <Row key={a.id} a={a} />)}</ul></Card>}
      <CancelDialog appt={cancel} onClose={() => setCancel(null)} onDone={() => { setCancel(null); load(); }} />
    </div>
  );
}

function CancelDialog({ appt, onClose, onDone }: { appt: any; onClose: () => void; onDone: () => void }) {
  const { t, lang } = useI18n(); const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  if (!appt) return null;
  const go = async () => { setBusy(true); setErr(null); try { await post(`/portal/appointments/${appt.id}/cancel`, { reason: reason.trim() || null }); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); } };
  return (
    <Dialog open onClose={onClose} title={t('pCancelVisit')}>
      <p className="text-sm">{t('pCancelConfirm')}</p>
      <p className="mt-2 text-sm font-medium">{fmtDate(appt.starts_at, lang)} · {fmtTime(appt.starts_at, lang)} · {appt.doctor_name}</p>
      <Field label={t('pCancelReason')} className="mt-4"><Textarea maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      <ErrorNote error={err} />
      <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('back')}</Button><Button variant="danger" busy={busy} onClick={go}>{t('pCancelVisit')}</Button></div>
    </Dialog>
  );
}

function RequestForm({ records, onSent }: { records: { patient_id: string; clinic: string }[]; onSent: () => void }) {
  const { t } = useI18n();
  const tomorrow = new Date(Date.now() + 86400000);
  const [f, setF] = useState({ patientId: records[0]?.patient_id ?? '', doctorMembershipId: '', preferredDate: dayKey(tomorrow), preferredTime: 'any', note: '' });
  const [doctors, setDoctors] = useState<any[]>([]); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(false);
  useEffect(() => { if (f.patientId) get<any[]>(`/portal/doctors?patient=${f.patientId}`, null).then(setDoctors).catch(() => setDoctors([])); }, [f.patientId]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null); setOk(false);
    try {
      await post('/portal/requests', { patientId: f.patientId, doctorMembershipId: f.doctorMembershipId || null, preferredDate: f.preferredDate, preferredTime: f.preferredTime, note: f.note.trim() || null });
      setOk(true); setF({ ...f, note: '' }); onSent();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title={t('pRequestVisit')}>
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
        {records.length > 1 && <Field label={t('pClinic')} className="sm:col-span-2"><Select value={f.patientId} onChange={(e) => setF({ ...f, patientId: e.target.value, doctorMembershipId: '' })}>
          {records.map((r) => <option key={r.patient_id} value={r.patient_id}>{r.clinic}</option>)}</Select></Field>}
        <Field label={t('doctor')} className="sm:col-span-2"><Select value={f.doctorMembershipId} onChange={(e) => setF({ ...f, doctorMembershipId: e.target.value })}>
          <option value="">{t('pAnyDoctor')}</option>{doctors.map((d) => <option key={d.membership_id} value={d.membership_id}>{d.full_name}{d.specialty_code ? ` · ${d.specialty_code.replace(/_/g, ' ')}` : ''}</option>)}</Select></Field>
        <Field label={t('pPreferredDate')}><Input type="date" required min={dayKey(new Date())} value={f.preferredDate} onChange={(e) => setF({ ...f, preferredDate: e.target.value })} /></Field>
        <Field label={t('pPreferredTime')}><Select value={f.preferredTime} onChange={(e) => setF({ ...f, preferredTime: e.target.value })}>
          {['any', 'morning', 'afternoon', 'evening'].map((k) => <option key={k} value={k}>{t(`t_${k}`)}</option>)}</Select></Field>
        <Field label={t('notes')} className="sm:col-span-2"><Textarea maxLength={500} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <p className="text-xs text-muted sm:col-span-2">{t('pRequestHint')}</p>
        <div className="sm:col-span-2"><ErrorNote error={err} />{ok && <p className="mb-2 text-sm font-medium text-brand">{t('pRequestSent')}</p>}<Button busy={busy} className="w-full sm:w-auto">{t('pSendRequest')}</Button></div>
      </form>
    </Card>
  );
}
