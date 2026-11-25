'use client';
import { useEffect, useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, Select, fmtDate, fmtTime } from '@/components/ui';
import { PageTitle } from '@/components/Shell';
import { del, get, patch, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useDoctors, useLoad } from '@/lib/hooks';

const DAYS = { en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], fr: ['Dim', 'Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam'], ar: ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'] };

export default function Availability() {
  const { t, lang } = useI18n(); const doctors = useDoctors();
  const [doctor, setDoctor] = useState(''); const [hours, setHours] = useState<any[]>([]); const [exc, setExc] = useState<any[]>([]);
  const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(false); const [x, setX] = useState({ kind: 'holiday', startsAt: '', endsAt: '' });
  const { data: services, reload: reloadServices } = useLoad<any[]>('/services');
  const [svc, setSvc] = useState({ name: '', defaultMinutes: 20, price: 0 });
  useEffect(() => { if (!doctor && doctors.length) setDoctor(doctors[0].id); }, [doctors, doctor]);
  const load = () => doctor && get(`/availability?doctor=${doctor}`).then((r) => { setHours(r.workingHours); setExc(r.exceptions); });
  useEffect(() => { load(); }, [doctor]); // eslint-disable-line
  const run = async (fn: () => Promise<unknown>) => { setErr(null); setOk(false); try { await fn(); setOk(true); load(); } catch (e) { setErr(e); } };
  return (
    <>
      <PageTitle title={t('availability')} actions={doctors.length > 1 && <Select value={doctor} onChange={(e) => setDoctor(e.target.value)} className="w-56">{doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select>} />
      <ErrorNote error={err} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={t('workingHours')} actions={ok && <span className="text-sm text-success">{t('saved')}</span>}>
          <ul className="space-y-2">{hours.map((h, i) => <li key={i} className="grid grid-cols-[1fr_1fr_1fr_auto] items-center gap-2">
            <Select value={h.weekday} onChange={(e) => setHours(hours.map((y, j) => (j === i ? { ...y, weekday: Number(e.target.value) } : y)))}>{DAYS[lang].map((d, k) => <option key={k} value={k}>{d}</option>)}</Select>
            <Input type="time" value={h.starts} onChange={(e) => setHours(hours.map((y, j) => (j === i ? { ...y, starts: e.target.value } : y)))} />
            <Input type="time" value={h.ends} onChange={(e) => setHours(hours.map((y, j) => (j === i ? { ...y, ends: e.target.value } : y)))} />
            <button className="text-muted hover:text-danger" aria-label="Remove" onClick={() => setHours(hours.filter((_, j) => j !== i))}>✕</button></li>)}</ul>
          <div className="mt-3 flex justify-between"><Button variant="ghost" size="sm" onClick={() => setHours([...hours, { weekday: 1, starts: '09:00', ends: '13:00' }])}>+ {t('add')}</Button>
            <Button onClick={() => run(() => put('/availability/working-hours', { doctorMembershipId: doctor, hours: hours.map(({ weekday, starts, ends }) => ({ weekday, starts, ends })) }))}>{t('save')}</Button></div>
        </Card>
        <Card title="Breaks, holidays, leave">
          <ul className="mb-4 space-y-1.5 text-sm">{exc.map((e) => <li key={e.id} className="flex justify-between"><span>{e.kind} · {fmtDate(e.starts_at, lang)} {fmtTime(e.starts_at, lang)} → {fmtDate(e.ends_at, lang)} {fmtTime(e.ends_at, lang)}</span>
            <button className="text-muted hover:text-danger" onClick={() => run(() => del(`/availability/exceptions/${e.id}`))}>✕</button></li>)}</ul>
          <div className="grid grid-cols-3 gap-2">
            <Select value={x.kind} onChange={(e) => setX({ ...x, kind: e.target.value })}><option value="break">Break</option><option value="holiday">Holiday</option><option value="leave">Leave</option></Select>
            <Input type="datetime-local" value={x.startsAt} onChange={(e) => setX({ ...x, startsAt: e.target.value })} aria-label={t('from')} />
            <Input type="datetime-local" value={x.endsAt} onChange={(e) => setX({ ...x, endsAt: e.target.value })} aria-label={t('to')} />
          </div>
          <div className="mt-2 flex justify-end"><Button variant="secondary" disabled={!x.startsAt || !x.endsAt} onClick={() => run(() => post('/availability/exceptions', { doctorMembershipId: doctor, kind: x.kind, startsAt: new Date(x.startsAt).toISOString(), endsAt: new Date(x.endsAt).toISOString() }))}>{t('add')}</Button></div>
        </Card>
        <Card title={t('service')} className="lg:col-span-2">
          <ul className="mb-4 divide-y divide-line text-sm">{services?.map((s) => <li key={s.id} className="flex justify-between py-1.5"><span>{s.name}</span><span className="tabular text-muted">{s.default_minutes} {t('min')} · {s.price} {s.currency}</span></li>)}</ul>
          <form className="grid grid-cols-[2fr_1fr_1fr_auto] gap-2" onSubmit={(e) => { e.preventDefault(); run(() => post('/services', { ...svc, doctorMembershipId: doctor || null }).then(() => { setSvc({ name: '', defaultMinutes: 20, price: 0 }); reloadServices(); })); }}>
            <Input required placeholder={t('service')} value={svc.name} onChange={(e) => setSvc({ ...svc, name: e.target.value })} />
            <Input type="number" min={5} value={svc.defaultMinutes} onChange={(e) => setSvc({ ...svc, defaultMinutes: Number(e.target.value) })} aria-label={t('duration')} />
            <Input type="number" min={0} value={svc.price} onChange={(e) => setSvc({ ...svc, price: Number(e.target.value) })} aria-label="Price USD" />
            <Button variant="secondary">{t('add')}</Button></form>
        </Card>
      </div>
    </>
  );
}
