'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, Input, Select, Textarea, fmtDate } from '@/components/ui';
import { del, get, post } from '@/lib/api';
import { toLocalInput, useDoctors } from '@/lib/hooks';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';

const TIME_HOUR: Record<string, number> = { morning: 9, afternoon: 14, evening: 17, any: 10 };

/** Dashboard card: visit requests patients sent from the patient app. Booking creates a real confirmed appointment. */
export function AppointmentRequests() {
  const { t, lang } = useI18n(); const { orgId, subscribe } = useWorkspace();
  const [rows, setRows] = useState<any[] | null>(null); const [book, setBook] = useState<any>(null); const [decline, setDecline] = useState<any>(null);
  const load = useCallback(() => get<any[]>('/appointment-requests').then(setRows).catch(() => setRows([])), []);
  useEffect(() => { load(); return subscribe((e: any) => { if (e.type === 'notification') load(); }); }, [load, subscribe]);
  if (rows === null || rows.length === 0) return rows === null ? null : <Card title={t('apptRequests')}><Empty>{t('noRequests')}</Empty></Card>;
  return (
    <Card title={<span>{t('apptRequests')} <Badge className="ms-1">{rows.length}</Badge></span>}>
      <ul className="divide-y divide-line">{rows.map((r) => <li key={r.id} className="py-2.5 text-sm">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div><Link href={`/w/${orgId}/patients/${r.patient_id}`} className="font-medium hover:text-brand">{r.patient_name}</Link>
            <p className="text-xs text-muted">{t('reqPrefers')} {fmtDate(r.preferred_date, lang)} · {t(`t_${r.preferred_time}`)}{r.doctor_name ? ` · ${r.doctor_name}` : ''}</p>
            {r.note && <p className="mt-1 text-xs"><span className="text-muted">{t('patientNote')}:</span> {r.note}</p>}</div>
          <div className="flex gap-2"><Button size="sm" onClick={() => setBook(r)}>{t('reqAccept')}</Button><Button size="sm" variant="ghost" onClick={() => setDecline(r)}>{t('reqDecline')}</Button></div>
        </div>
      </li>)}</ul>
      {book && <BookDialog r={book} onClose={() => setBook(null)} onDone={() => { setBook(null); load(); }} />}
      {decline && <DeclineDialog r={decline} onClose={() => setDecline(null)} onDone={() => { setDecline(null); load(); }} />}
    </Card>
  );
}

function BookDialog({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n(); const doctors = useDoctors();
  const bookable = doctors;
  const start = new Date(`${String(r.preferred_date).slice(0, 10)}T00:00:00`); start.setHours(TIME_HOUR[r.preferred_time] ?? 10);
  const [f, setF] = useState({ doctorMembershipId: r.doctor_membership_id ?? '', startsAt: toLocalInput(start), durationMinutes: 20, note: '' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { if (!f.doctorMembershipId && bookable.length) setF((x) => ({ ...x, doctorMembershipId: bookable[0].id })); }, [bookable, f.doctorMembershipId]);
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await post(`/appointment-requests/${r.id}/accept`, { doctorMembershipId: f.doctorMembershipId, startsAt: new Date(f.startsAt).toISOString(), durationMinutes: Number(f.durationMinutes), note: f.note.trim() || null }); onDone(); }
    catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={`${t('reqBookFor')} ${r.patient_name}`}>
      <form onSubmit={go} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('doctor')} className="sm:col-span-2"><Select required value={f.doctorMembershipId} onChange={(e) => setF({ ...f, doctorMembershipId: e.target.value })}>
          {bookable.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select></Field>
        <Field label={t('start')}><Input type="datetime-local" required value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} /></Field>
        <Field label={t('duration')}><Input type="number" min={5} max={480} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })} /></Field>
        <Field label={t('reqDeclineNote')} className="sm:col-span-2"><Textarea maxLength={300} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <div className="sm:col-span-2"><ErrorNote error={err} /></div>
        <div className="flex justify-end gap-2 sm:col-span-2"><Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button><Button busy={busy}>{t('reqAccept')}</Button></div>
      </form>
    </Dialog>
  );
}

function DeclineDialog({ r, onClose, onDone }: { r: any; onClose: () => void; onDone: () => void }) {
  const { t } = useI18n(); const [note, setNote] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const go = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setErr(null); try { await post(`/appointment-requests/${r.id}/decline`, { note: note.trim() }); onDone(); } catch (x) { setErr(x); } finally { setBusy(false); } };
  return (
    <Dialog open onClose={onClose} title={`${t('reqDecline')} · ${r.patient_name}`}>
      <form onSubmit={go} className="space-y-3">
        <Field label={t('reqDeclineNote')}><Textarea required minLength={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} /></Field>
        <ErrorNote error={err} />
        <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={onClose}>{t('cancel')}</Button><Button variant="danger" busy={busy}>{t('reqDecline')}</Button></div>
      </form>
    </Dialog>
  );
}

/** Patient file card: invite the patient to the patient app, see whether they joined, remove access. */
export function PatientAppAccess({ patientId, email }: { patientId: string; email: string | null }) {
  const { t, lang } = useI18n(); const { can } = useWorkspace();
  const [s, setS] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [open, setOpen] = useState(false);
  const [addr, setAddr] = useState(email ?? ''); const [link, setLink] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [copied, setCopied] = useState(false);
  const load = useCallback(() => get(`/patients/${patientId}/portal`).then(setS).catch(setErr), [patientId]);
  useEffect(() => { load(); }, [load]);
  const invite = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await post(`/patients/${patientId}/portal/invitations`, { email: addr.trim() }); setLink(r.inviteUrl); load(); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const revoke = async () => { if (!confirm(t('paRevokeConfirm'))) return; try { await del(`/patients/${patientId}/portal`); load(); } catch (x) { setErr(x); } };
  const copy = async () => { if (!link) return; await navigator.clipboard.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 2000); };
  const manage = can('patient.register');
  return (
    <Card title={t('patientApp')} actions={manage && !s?.account && <Button size="sm" variant="ghost" onClick={() => { setOpen(true); setLink(null); }}>{t('invite')}</Button>}>
      <ErrorNote error={err} />
      {!s ? <p className="text-sm text-muted">{t('loading')}</p> : s.account ? (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <div><Badge status="confirmed">{t('paActive')}</Badge><p className="mt-1 text-muted">{s.account.email ?? ''} · {t('paSince')} {fmtDate(s.account.created_at, lang)}</p></div>
          {manage && <Button size="sm" variant="ghost" onClick={revoke}>{t('paRevoke')}</Button>}
        </div>
      ) : <p className="text-sm text-muted">{t('paNone')}</p>}
      {s?.invitations?.length > 0 && <ul className="mt-3 space-y-1 border-t border-line pt-3 text-xs text-muted">{s.invitations.map((i: any) => <li key={i.id}>
        {i.email} · {i.accepted_at ? `${t('paAccepted')} ${fmtDate(i.accepted_at, lang)}` : `${t('paExpires')} ${fmtDate(i.expires_at, lang)}`}</li>)}</ul>}
      <Dialog open={open} onClose={() => setOpen(false)} title={t('paInvite')}>
        {!link ? <form onSubmit={invite} className="space-y-3">
          <Field label={t('email')} hint={t('paEmailHint')}><Input type="email" required value={addr} onChange={(e) => setAddr(e.target.value)} /></Field>
          <ErrorNote error={err} />
          <div className="flex justify-end gap-2"><Button type="button" variant="secondary" onClick={() => setOpen(false)}>{t('cancel')}</Button><Button busy={busy}>{t('invite')}</Button></div>
        </form> : <div className="space-y-3">
          <p className="text-sm text-muted">{t('paLinkHint')}</p>
          <Input readOnly value={link} onFocus={(e) => e.target.select()} />
          <div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setOpen(false)}>{t('close')}</Button><Button onClick={copy}>{copied ? t('paCopied') : t('paCopy')}</Button></div>
        </div>}
      </Dialog>
    </Card>
  );
}
