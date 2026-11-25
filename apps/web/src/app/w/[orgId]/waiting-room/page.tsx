'use client';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Empty, Select } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { ApptActions } from '@/components/ApptActions';
import { get } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useLiveReload, useWorkspace } from '@/lib/workspace';
import { fmtTime } from '@/components/ui';

/** Live queues, one per doctor. Updates arrive over the WebSocket; waiting time ticks every 30 s. */
export default function WaitingRoom() {
  const { t, lang, status } = useI18n(); const { can, org } = useWorkspace();
  const [rows, setRows] = useState<any[]>([]); const [dep, setDep] = useState(''); const [, tick] = useState(0); const [loadedAt, setLoadedAt] = useState(Date.now());
  const load = useCallback(() => get(`/waiting-room${dep ? `?department=${dep}` : ''}`).then((r) => { setRows(r); setLoadedAt(Date.now()); }).catch(() => {}), [dep]);
  useLiveReload(load);
  useEffect(() => { const i = setInterval(() => tick((x) => x + 1), 30000); return () => clearInterval(i); }, []);
  if (!can('appointment.manage')) return <Forbidden />;
  const byDoctor = rows.reduce<Record<string, any[]>>((m, r) => ((m[r.doctor_name] ??= []).push(r), m), {});
  const mins = (r: any) => Math.floor((r.waiting_seconds + (Date.now() - loadedAt) / 1000) / 60);
  return (
    <>
      <PageTitle title={t('waitingRoom')} actions={org.departments.length > 0 && <Select value={dep} onChange={(e) => setDep(e.target.value)} className="w-48"><option value="">{t('departments')}: all</option>{org.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select>} />
      {rows.length === 0 ? <Empty>{t('noOneWaiting')}</Empty> : <div className="grid gap-6 lg:grid-cols-2">
        {Object.entries(byDoctor).map(([doc, list]) => <Card key={doc} title={`${doc} · ${list.length}`}>
          <ol className="space-y-3">{list.map((r, i) => <li key={r.appointment_id} className="flex flex-wrap items-center justify-between gap-3 rounded-[10px] border border-line p-3">
            <div className="flex items-center gap-3"><span className="flex size-8 items-center justify-center rounded-full bg-brand-soft font-semibold text-brand tabular">{i + 1}</span>
              <div><p className="font-semibold">{r.patient_name}</p><p className="text-xs text-muted tabular">⏰ {fmtTime(r.appointment_time, lang)} · <span className={mins(r) > 20 ? 'font-semibold text-warning' : ''}>{mins(r)} {t('min')} {t('waitingFor')}</span>{r.is_walk_in ? ` · ${t('walkIn')}` : ''}</p></div></div>
            <div className="flex items-center gap-2"><Badge status={r.status}>{status(r.status)}</Badge><ApptActions appt={{ id: r.appointment_id, status: r.status }} onDone={load} compact /></div>
          </li>)}</ol></Card>)}
      </div>}
    </>
  );
}
