'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, Stat, fmtDate, fmtTime } from '@/components/ui';
import { PageTitle } from '@/components/Shell';
import { AppointmentDialog } from '@/components/AppointmentDialog';
import { ApptActions } from '@/components/ApptActions';
import { AppointmentRequests } from '@/components/PortalStaff';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useLiveReload, useWorkspace } from '@/lib/workspace';

const startOfDay = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

export default function Dashboard() {
  const { org, me, orgId, can } = useWorkspace(); const { t, lang, status } = useI18n();
  const [sum, setSum] = useState<any>(null); const [today, setToday] = useState<any[]>([]); const [queue, setQueue] = useState<any[]>([]);
  const [notes, setNotes] = useState<any[]>([]); const [ws, setWs] = useState<any>(null); const [dlg, setDlg] = useState<null | 'appt' | 'walk'>(null);
  const isDoctor = !!org.me.doctorMembershipId; const scheduling = can('appointment.manage');
  const load = useCallback(() => {
    get('/dashboard/summary').then(setSum).catch(() => {});
    get('/notifications', null).then((n) => setNotes(n.slice(0, 8))).catch(() => {});
    if (scheduling) {
      const s = startOfDay(); const e = new Date(s.getTime() + 86400e3);
      get(`/appointments?from=${s.toISOString()}&to=${e.toISOString()}`).then(setToday).catch(() => {});
      get('/waiting-room').then(setQueue).catch(() => {});
    }
  }, [scheduling]);
  useLiveReload(load);
  useEffect(() => { if (org.me.actingDoctors.length) get('/specialty/workspace').then(setWs).catch(() => {}); }, [org]);
  const widgets: string[] = ws?.widgets ?? [];
  const hello = me.user.full_name;
  const readAll = async () => { await post('/notifications/read-all'); load(); };

  return (
    <>
      <PageTitle title={`${t('dashboard')} · ${hello}`} sub={ws ? `${ws.specialty.names?.[lang] ?? ws.specialty.name} · ${org.organization.name}` : org.organization.name}
        actions={scheduling && <><Button variant="secondary" onClick={() => setDlg('walk')}>{t('walkIn')}</Button><Button onClick={() => setDlg('appt')}>{t('newAppointment')}</Button></>} />
      {sum && <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={t('patientsToday')} value={sum.patients_today} sub={`${sum.completed_today} ✓`} />
        <Stat label={t('waiting')} value={sum.waiting} tone="accent" />
        <Stat label={t('nextAppointment')} value={sum.next_appointment ? fmtTime(sum.next_appointment.starts_at, lang) : '—'} tone="info" sub={sum.next_appointment?.patient_name} />
        <Stat label={isDoctor ? t('newPatients') : t('pendingConfirmations')} value={isDoctor ? sum.new_patients : sum.pending_confirmations} tone="warning" />
      </div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="space-y-6">
          {scheduling && <Card title={t('waitingRoom')} actions={<Link href={`/w/${orgId}/waiting-room`} className="text-sm text-brand">→</Link>}>
            {queue.length === 0 ? <Empty>{t('noOneWaiting')}</Empty> : <ul className="divide-y divide-line">{queue.map((q) => (
              <li key={q.appointment_id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div><p className="font-medium">{q.patient_name}</p><p className="text-xs text-muted">{fmtTime(q.appointment_time, lang)} · {Math.floor(q.waiting_seconds / 60)} {t('min')} {t('waitingFor')} · {q.doctor_name}</p></div>
                <ApptActions appt={{ id: q.appointment_id, status: q.status }} onDone={load} compact />
              </li>))}</ul>}
          </Card>}
          {scheduling && <AppointmentRequests />}
          {scheduling && <Card title={t('todaysAppointments')}>
            {today.length === 0 ? <Empty>{t('noAppointments')}</Empty> : <ul className="divide-y divide-line">{today.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="flex items-center gap-3"><span className="tabular w-12 text-sm text-muted">{fmtTime(a.starts_at, lang)}</span>
                  <div><Link href={`/w/${orgId}/patients/${a.patient_id}`} className="font-medium hover:text-brand">{a.patient_name}</Link><p className="text-xs text-muted">{a.service_name ?? ''} {org.me.orgWide ? `· ${a.doctor_name}` : ''}</p></div></div>
                <div className="flex items-center gap-2"><Badge status={a.status}>{status(a.status)}</Badge><ApptActions appt={a} onDone={load} compact /></div>
              </li>))}</ul>}
          </Card>}
        </div>
        <div className="space-y-6">
          <Card title={t('quickActions')}><div className="grid grid-cols-2 gap-2">
            {can('patient.register') && <Link href={`/w/${orgId}/patients?new=1`}><Button variant="secondary" className="w-full">{t('addPatient')}</Button></Link>}
            {scheduling && <Button variant="secondary" onClick={() => setDlg('appt')}>{t('newAppointment')}</Button>}
            {can('patient.file.read') && <Link href={`/w/${orgId}/patients`}><Button variant="secondary" className="w-full">{t('patients')}</Button></Link>}
            {scheduling && <Link href={`/w/${orgId}/calendar`}><Button variant="secondary" className="w-full">{t('openCalendar')}</Button></Link>}
          </div>
          {isDoctor && <p className="mt-3 text-xs text-muted">{t('laterReleases')}</p>}</Card>
          {can('patient.history.read') && widgets.includes('vaccinations_due') && <Card title={t('vaccinationsDue')}>
            {!sum?.vaccinations_due?.length ? <Empty>{t('none')}</Empty> : <ul className="space-y-1.5 text-sm">{sum.vaccinations_due.map((v: any, i: number) => <li key={i} className="flex justify-between"><Link className="hover:text-brand" href={`/w/${orgId}/patients/${v.patient_id}`}>{v.full_name} · {v.vaccine}</Link><span className="text-muted">{fmtDate(v.due, lang)}</span></li>)}</ul>}
          </Card>}
          {can('patient.history.read') && widgets.includes('pregnancies_due') && <Card title={t('deliveriesDue')}>
            {!sum?.pregnancies_due?.length ? <Empty>{t('none')}</Empty> : <ul className="space-y-1.5 text-sm">{sum.pregnancies_due.map((v: any, i: number) => <li key={i} className="flex justify-between"><Link className="hover:text-brand" href={`/w/${orgId}/patients/${v.patient_id}`}>{v.full_name}</Link><span className="text-muted">{fmtDate(v.edd, lang)}</span></li>)}</ul>}
          </Card>}
          <Card title={t('notifications')} actions={notes.some((n) => !n.read_at) && <button className="text-xs text-brand" onClick={readAll}>✓</button>}>
            <div id="notifications" />
            {notes.length === 0 ? <Empty>{t('none')}</Empty> : <ul className="space-y-2 text-sm">{notes.map((n) => (
              <li key={n.id} className={n.read_at ? 'text-muted' : ''}>{n.kind === 'patient_arrived' ? `● ${t('patientArrived')}` : n.kind === 'whatsapp_message' ? <a className="hover:underline" href={`/w/${n.payload?.organization_id ?? orgId}/messages?c=${n.payload?.conversation_id ?? ''}`}>✉ {t('whatsappMessage')}</a> : n.kind.startsWith('appointment_') ? (n.payload?.patient_id ? <Link className="hover:underline" href={`/w/${n.payload?.organization_id ?? orgId}/patients/${n.payload.patient_id}`}>▦ {t(`n_${n.kind}`)}</Link> : `▦ ${t(`n_${n.kind}`)}`) : n.kind} <span className="text-xs text-muted">· {fmtTime(n.created_at, lang)} · {n.organization_name}</span></li>))}</ul>}
          </Card>
        </div>
      </div>
      <AppointmentDialog open={dlg !== null} walkIn={dlg === 'walk'} onClose={() => setDlg(null)} onSaved={load} />
    </>
  );
}
