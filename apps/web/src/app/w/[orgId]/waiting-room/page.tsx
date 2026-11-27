'use client';
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';
import { post } from '@/lib/api';
import { Badge, Card, Empty, Select } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { ApptActions } from '@/components/ApptActions';
import { get } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useLiveReload, useWorkspace } from '@/lib/workspace';
import { fmtTime } from '@/components/ui';

/**
 * Live queues, one per doctor: who is in with the doctor, who waits to be called in, and today's cancellations.
 * Updates arrive over the WebSocket; waiting time ticks every 30 s.
 */
export default function WaitingRoom() {
  const { t, lang, status } = useI18n(); const { can, org, orgId } = useWorkspace(); const router = useRouter();
  const [startErr, setStartErr] = useState<string | null>(null);
  const start = async (appointmentId: string) => { setStartErr(null); try { const c = await post('/consultations', { appointmentId }); router.push(`/w/${orgId}/consultations/${c.id}`); } catch (e: any) { setStartErr(e.message); } };
  const mine = (r: any) => r.doctor_membership_id === org.me.doctorMembershipId && can('clinical_notes.read');
  const [rows, setRows] = useState<any[]>([]); const [dep, setDep] = useState(''); const [, tick] = useState(0); const [loadedAt, setLoadedAt] = useState(Date.now());
  const load = useCallback(() => get(`/waiting-room?include=today${dep ? `&department=${dep}` : ''}`).then((r) => { setRows(r); setLoadedAt(Date.now()); }).catch(() => {}), [dep]);
  useLiveReload(load);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(i); }, []);
  if (!can('appointment.manage')) return <Forbidden />;
  const byDoctor = rows.reduce<Record<string, any[]>>((m, r) => ((m[r.doctor_name] ??= []).push(r), m), {});
  const since = (iso: string | null, secs?: number) => iso ? Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 60000)) : Math.floor(((secs ?? 0) + (Date.now() - loadedAt) / 1000) / 60);
  const mins = (r: any) => since(null, r.waiting_seconds);
  const actions = (r: any) => mine(r) && r.status !== 'cancelled' && r.status !== 'no_show'
    ? <Button size="sm" onClick={() => start(r.appointment_id)}>{t(r.status === 'in_consultation' ? 'continueConsultation' : 'startConsultation')}</Button>
    : <ApptActions appt={{ id: r.appointment_id, status: r.status }} onDone={load} compact />;
  const queued = (s: string) => s === 'arrived' || s === 'waiting';
  return (
    <>
      <PageTitle title={t('waitingRoom')} actions={org.departments.length > 0 && <Select value={dep} onChange={(e) => setDep(e.target.value)} className="w-48"><option value="">{t('departments')}: all</option>{org.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>} />
      {startErr && <p className="mb-4 text-sm text-danger">{startErr}</p>}
      {rows.length === 0 ? <Empty>{t('noOneWaiting')}</Empty> : <div className="grid gap-6 lg:grid-cols-2">
        {Object.entries(byDoctor).map(([doc, list]) => {
          const inside = list.filter((r) => r.status === 'in_consultation');
          const queue = list.filter((r) => queued(r.status));
          const gone = list.filter((r) => r.status === 'cancelled' || r.status === 'no_show');
          return <Card key={doc} title={`${doc} · ${queue.length} ${t('waitingFor')}`}>
            {inside.length > 0 && <section className="mb-4"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('withDoctor')}</h3>
              <ul className="space-y-3">{inside.map((r) => <li key={r.appointment_id} className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-brand bg-brand-soft p-3">
                <div className="flex items-center gap-3"><span aria-hidden className="flex size-8 items-center justify-center rounded-full bg-brand font-semibold text-white">●</span>
                  <div><p className="font-semibold">{r.patient_name}</p><p className="text-xs text-muted tabular">⏰ {fmtTime(r.appointment_time, lang)}{r.called_at ? ` · ${t('inFor')} ${since(r.called_at)} ${t('min')}` : ''}</p></div></div>
                <div className="flex items-center gap-2"><Badge status={r.status}>{status(r.status)}</Badge>{actions(r)}</div>
              </li>)}</ul></section>}
            {queue.length > 0 ? <section className="mb-4"><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('inQueue')}</h3>
              <ol className="space-y-3">{queue.map((r, i) => <li key={r.appointment_id} className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line p-3">
                <div className="flex items-center gap-3"><span className="flex size-8 items-center justify-center rounded-full bg-brand-soft font-semibold text-brand tabular">{i + 1}</span>
                  <div><p className="font-semibold">{r.patient_name}</p><p className="text-xs text-muted tabular">⏰ {fmtTime(r.appointment_time, lang)} · <span className={mins(r) > 20 ? 'font-semibold text-warning' : ''}>{mins(r)} {t('min')} {t('waitingFor')}</span>{r.is_walk_in ? ` · ${t('walkIn')}` : ''}</p></div></div>
                <div className="flex items-center gap-2"><Badge status={r.status}>{status(r.status)}</Badge>{actions(r)}</div>
              </li>)}</ol></section> : <p className="mb-4 text-sm text-muted">{t('noOneWaiting')}</p>}
            {gone.length > 0 && <section><h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{t('cancelledToday')}</h3>
              <ul className="space-y-2">{gone.map((r) => <li key={r.appointment_id} className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line p-3 opacity-70">
                <div><p className="font-semibold line-through decoration-muted">{r.patient_name}</p><p className="text-xs text-muted tabular">⏰ {fmtTime(r.appointment_time, lang)}{r.cancelled_reason ? ` · ${r.cancelled_reason}` : ''}</p></div>
                <Badge status={r.status}>{status(r.status)}</Badge>
              </li>)}</ul></section>}
          </Card>;
        })}
      </div>}
    </>
  );
}
