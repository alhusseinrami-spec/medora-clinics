'use client';
import { useEffect, useState } from 'react';
import { Button, Dialog, ErrorNote, Field, Input, Select, Textarea, fmtTime } from './ui';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useDoctors, useLoad, toLocalInput } from '@/lib/hooks';

export function PatientPicker({ value, onChange }: { value: { id: string; full_name: string } | null; onChange: (p: { id: string; full_name: string } | null) => void }) {
  const { t } = useI18n();
  const [q, setQ] = useState(''); const [res, setRes] = useState<any[]>([]);
  useEffect(() => { if (q.length < 2) { setRes([]); return; } const h = setTimeout(() => get(`/patients?q=${encodeURIComponent(q)}&limit=8`).then(setRes).catch(() => setRes([])), 200); return () => clearTimeout(h); }, [q]);
  if (value) return <div className="flex h-10 items-center justify-between rounded-[10px] border border-line px-3 text-sm"><span>{value.full_name}</span><button type="button" className="text-muted" onClick={() => onChange(null)}>✕</button></div>;
  return <div className="relative"><Input placeholder={`${t('search')}: name, phone, P-000123`} value={q} onChange={(e) => setQ(e.target.value)} />
    {res.length > 0 && <ul className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded-[10px] border border-line bg-card shadow-lg">
      {res.map((p) => <li key={p.id}><button type="button" className="w-full px-3 py-2 text-start text-sm hover:bg-surface" onClick={() => { onChange(p); setQ(''); }}>{p.full_name} <span className="text-xs text-muted">{p.patient_number} · {p.phone ?? ''}</span></button></li>)}
    </ul>}</div>;
}

export function AppointmentDialog({ open, onClose, onSaved, patient, start, walkIn }: { open: boolean; onClose: () => void; onSaved: () => void; patient?: { id: string; full_name: string } | null; start?: Date; walkIn?: boolean }) {
  const { t, lang } = useI18n(); const { org } = useWorkspace();
  const doctors = useDoctors();
  const { data: services } = useLoad<any[]>('/services');
  const [p, setP] = useState(patient ?? null);
  const [doctor, setDoctor] = useState(''); const [service, setService] = useState(''); const [when, setWhen] = useState(toLocalInput(start ?? new Date(Date.now() + 3600e3)));
  const [minutes, setMinutes] = useState(20); const [room, setRoom] = useState(''); const [notes, setNotes] = useState(''); const [rec, setRec] = useState(''); const [count, setCount] = useState(4);
  const [slots, setSlots] = useState<any[]>([]); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setP(patient ?? null); setErr(null); if (start) setWhen(toLocalInput(start)); } }, [open, patient, start]);
  useEffect(() => { if (!doctor && doctors.length) setDoctor(org.me.doctorMembershipId && doctors.some((d) => d.id === org.me.doctorMembershipId) ? org.me.doctorMembershipId : doctors[0].id); }, [doctors, doctor, org]);
  useEffect(() => { const s = services?.find((x) => x.id === service); if (s) setMinutes(s.default_minutes); }, [service, services]);
  useEffect(() => {
    if (!doctor || walkIn || !open) return;
    get(`/availability/slots?doctor=${doctor}&date=${when.slice(0, 10)}&minutes=${minutes}`).then(setSlots).catch(() => setSlots([]));
  }, [doctor, when, minutes, walkIn, open]);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); if (!p) return; setBusy(true); setErr(null);
    try {
      if (walkIn) await post('/appointments/walk-in', { patientId: p.id, doctorMembershipId: doctor, serviceId: service || undefined, notes: notes || undefined });
      else await post('/appointments', { patientId: p.id, doctorMembershipId: doctor, startsAt: new Date(when).toISOString(), durationMinutes: minutes, serviceId: service || undefined,
        roomId: room || undefined, notes: notes || undefined, recurrence: rec ? `FREQ=${rec};COUNT=${count}` : undefined });
      onSaved(); onClose();
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={walkIn ? t('walkIn') : t('newAppointment')} wide>
      <form onSubmit={submit} className="grid gap-4 sm:grid-cols-2">
        <Field label={t('patient')} className="sm:col-span-2"><PatientPicker value={p} onChange={setP} /></Field>
        <Field label={t('doctor')}><Select value={doctor} onChange={(e) => setDoctor(e.target.value)} required>{doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select></Field>
        <Field label={t('service')}><Select value={service} onChange={(e) => setService(e.target.value)}><option value="">—</option>{services?.map((s) => <option key={s.id} value={s.id}>{s.name} · {s.default_minutes} {t('min')}</option>)}</Select></Field>
        {!walkIn && <>
          <Field label={t('start')}><Input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} required /></Field>
          <Field label={t('duration')}><Input type="number" min={5} max={480} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></Field>
          {slots.length > 0 && <div className="sm:col-span-2"><p className="mb-1 text-xs font-medium text-muted">{t('freeSlots')}</p><div className="flex flex-wrap gap-1.5">
            {slots.slice(0, 16).map((s) => <button type="button" key={s.starts_at} onClick={() => setWhen(toLocalInput(new Date(s.starts_at)))} className="rounded-md border border-line px-2 py-1 text-xs hover:border-brand hover:text-brand">{fmtTime(s.starts_at, lang)}</button>)}
          </div></div>}
          <Field label={t('room')}><Select value={room} onChange={(e) => setRoom(e.target.value)}><option value="">—</option>{org.rooms.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</Select></Field>
          <Field label={t('recurrence')}><div className="flex gap-2"><Select value={rec} onChange={(e) => setRec(e.target.value)}><option value="">{t('noRepeat')}</option><option value="WEEKLY">{t('weekly')}</option><option value="DAILY">{t('daily')}</option></Select>
            {rec && <Input type="number" min={2} max={52} value={count} onChange={(e) => setCount(Number(e.target.value))} className="w-20" aria-label={t('times')} />}</div></Field>
        </>}
        <Field label={t('notes')} className="sm:col-span-2"><Textarea value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <div className="sm:col-span-2"><ErrorNote error={err} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button><Button busy={busy} disabled={!p || !doctor}>{t('save')}</Button></div>
      </form>
    </Dialog>
  );
}
