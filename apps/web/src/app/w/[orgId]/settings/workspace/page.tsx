'use client';
import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, Select, Switch, cx, fmtDate, fmtTime } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { patch, post, del } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad } from '@/lib/hooks';

export default function WorkspaceSettings() {
  const { t, lang } = useI18n(); const { org, can, reload, feature } = useWorkspace();
  const o = org.organization;
  const [f, setF] = useState({ name: o.name, phone: o.phone ?? '', email: o.email ?? '', address: o.address ?? '', defaultLanguage: o.default_language, timezone: o.timezone, legalName: o.legal_name ?? '', taxId: o.tax_id ?? '' });
  const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false);
  const [loc, setLoc] = useState(''); const [room, setRoom] = useState<Record<string, string>>({}); const [dep, setDep] = useState('');
  if (!can('org.manage')) return <Forbidden />;
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await reload(); } catch (e) { setErr(e); } };
  const save = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setOk(false);
    await run(() => patch('/org', { name: f.name, phone: f.phone || null, email: f.email || null, address: f.address || null, defaultLanguage: f.defaultLanguage, timezone: f.timezone, legalName: f.legalName || null, taxId: f.taxId || null })); setOk(true); setBusy(false); };
  return (
    <>
      <PageTitle title={t('workspace')} />
      <ErrorNote error={err} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={o.kind === 'medical_center' ? t('centerName') : t('clinicName')}>
          <form onSubmit={save} className="grid gap-3">
            <Field label={t('fullName')}><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label={t('legalName')}><Input value={f.legalName} onChange={(e) => setF({ ...f, legalName: e.target.value })} /></Field>
            <Field label={t('taxId')}><Input value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} /></Field>
            <Field label={t('phone')}><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label={t('email')}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label={t('address')}><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
            <Field label={t('language')}><Select value={f.defaultLanguage} onChange={(e) => setF({ ...f, defaultLanguage: e.target.value })}><option value="en">English</option><option value="ar">العربية</option><option value="fr">Français</option></Select></Field>
            <Field label={t('timeZone')} hint="Asia/Beirut"><Input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
            <div className="flex items-center justify-end gap-3">{ok && <span className="text-sm text-success">{t('saved')}</span>}<Button busy={busy}>{t('save')}</Button></div>
          </form>
        </Card>
        <div className="space-y-6">
          <Card title={`${t('locations')} & ${t('rooms')}`}>
            <ul className="space-y-4">{org.locations.map((l) => <li key={l.id}>
              <p className="font-medium">{l.name} <span className="text-xs text-muted">{l.address ?? ''}</span></p>
              <div className="mt-1 flex flex-wrap gap-1.5">{org.rooms.filter((r) => r.location_id === l.id).map((r) => <span key={r.id} className="inline-flex items-center gap-1 rounded-full bg-brand-soft px-2.5 py-0.5 text-xs text-brand">{r.name}
                <button aria-label={`Remove ${r.name}`} onClick={() => run(() => del(`/org/rooms/${r.id}`))}>✕</button></span>)}</div>
              <form className="mt-2 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (room[l.id]) run(() => post(`/org/locations/${l.id}/rooms`, { name: room[l.id] }).then(() => setRoom({ ...room, [l.id]: '' }))); }}>
                <Input className="!h-8" placeholder={`${t('room')}…`} value={room[l.id] ?? ''} onChange={(e) => setRoom({ ...room, [l.id]: e.target.value })} /><Button size="sm" variant="secondary">{t('add')}</Button></form>
            </li>)}</ul>
            <form className="mt-5 flex gap-2 border-t border-line pt-4" onSubmit={(e) => { e.preventDefault(); if (loc) run(() => post('/org/locations', { name: loc }).then(() => setLoc(''))); }}>
              <Input placeholder={`${t('locations')}…`} value={loc} onChange={(e) => setLoc(e.target.value)} /><Button variant="secondary">{t('add')}</Button></form>
          </Card>
          {o.kind === 'medical_center' && feature('departments') && <Card title={t('departments')}>
            <ul className="mb-3 flex flex-wrap gap-1.5">{org.departments.map((d) => <li key={d.id} className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs text-brand">{d.name}</li>)}</ul>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (dep) run(() => post('/org/departments', { name: dep }).then(() => setDep(''))); }}>
              <Input placeholder={`${t('departments')}…`} value={dep} onChange={(e) => setDep(e.target.value)} /><Button variant="secondary">{t('add')}</Button></form>
          </Card>}
        </div>
      </div>
      <ClinicRules onError={setErr} />
      {can('staff.manage') && <EmergencyLog />}
    </>
  );
}

/** Clinic-wide rules. Each change is saved at once (owners and admins only). */
function ClinicRules({ onError }: { onError: (e: unknown) => void }) {
  const { t } = useI18n(); const { org, reload } = useWorkspace(); const o = org.organization;
  const [hours, setHours] = useState({ start: o.message_window_start ?? '08:00', end: o.message_window_end ?? '20:00' });
  const save = async (b: Record<string, unknown>) => { onError(null); try { await patch('/org', b); await reload(); } catch (e) { onError(e); } };
  const Choice = ({ on, title, hint, tag, pick }: { on: boolean; title: string; hint: string; tag?: string; pick: () => void }) =>
    <button type="button" onClick={pick} aria-pressed={on} className={cx('w-full rounded-[12px] border p-4 text-start transition', on ? 'border-brand bg-brand-soft/40' : 'border-line hover:bg-surface')}>
      <span className="flex flex-wrap items-center gap-2 font-medium"><span aria-hidden className={cx('inline-block h-4 w-4 rounded-full border-2', on ? 'border-brand bg-brand' : 'border-line')} />{title}
        {tag && <span className="rounded-full bg-brand-soft px-2 py-0.5 text-xs font-normal text-brand">{tag}</span>}</span>
      <span className="mt-1 block text-sm text-muted">{hint}</span></button>;
  const Toggle = ({ k, value, title, hint }: { k: string; value: boolean; title: string; hint: string }) =>
    <div className="flex items-start justify-between gap-4 border-t border-line pt-4"><div><p className="font-medium">{title}</p><p className="text-sm text-muted">{hint}</p></div>
      <Switch checked={value} onChange={(v) => save({ [k]: v })} label={title} /></div>;
  return <div className="mt-6 grid gap-6 lg:grid-cols-2">
    <Card title={t('clinicRules')}>
      <p className="mb-3 text-sm text-muted">{t('ownerAdminOnly')}</p>
      {o.kind === 'medical_center' && <div className="mb-4 space-y-2">
        <p className="font-medium">{t('shareQuestion')}</p>
        <Choice on={!o.share_patients_between_doctors} title={t('shareOwn')} hint={t('shareOwnHint')} tag={t('mostClinics')} pick={() => save({ sharePatientsBetweenDoctors: false })} />
        <Choice on={!!o.share_patients_between_doctors} title={t('shareAll')} hint={t('shareAllHint')} pick={() => save({ sharePatientsBetweenDoctors: true })} />
        <p className="text-xs text-muted">{t('frontDeskNotesHint')}</p>
      </div>}
      <div className="space-y-4">
        <Toggle k="allowOverbooking" value={!!o.allow_overbooking} title={t('allowOverbooking')} hint={t('allowOverbookingHint')} />
        {o.kind === 'medical_center' && <Toggle k="doctorsManageAbsences" value={o.doctors_manage_absences !== false} title={t('doctorsAbsences')} hint={t('doctorsAbsencesHint')} />}
        <Toggle k="daySheetPhones" value={!!o.day_sheet_phones} title={t('daySheetPhones')} hint={t('daySheetPhonesHint')} />
      </div>
    </Card>
    <Card title={t('messageHours')}>
      <p className="mb-3 text-sm text-muted">{t('messageHoursHint')}</p>
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); save({ messageWindowStart: hours.start, messageWindowEnd: hours.end }); }}>
        <Field label={t('windowFrom')}><Input type="time" value={hours.start} onChange={(e) => setHours({ ...hours, start: e.target.value })} /></Field>
        <Field label={t('until')}><Input type="time" value={hours.end} onChange={(e) => setHours({ ...hours, end: e.target.value })} /></Field>
        <Button variant="secondary">{t('save')}</Button>
      </form>
      <p className="mt-3 text-xs text-muted">{t('timeZone')}: {o.timezone}</p>
    </Card>
  </div>;
}

function EmergencyLog() {
  const { t, lang } = useI18n(); const { data } = useLoad<any[]>('/org/emergency-access');
  return <Card title={t('emergencyLog')} className="mt-6">
    <p className="mb-3 text-sm text-muted">{t('emergencyLogHint')}</p>
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <p className="text-sm text-muted">{t('noEmergency')}</p> :
      <table className="w-full text-sm"><thead><tr className="text-xs text-muted"><th className="py-2 text-start">{t('date')}</th><th className="text-start">{t('openedBy')}</th>
        <th className="text-start">{t('patients')}</th><th className="text-start">{t('reason')}</th></tr></thead>
        <tbody>{data.map((e) => <tr key={e.id} className="border-t border-line"><td className="py-2 tabular">{fmtDate(e.opened_at, lang)} {fmtTime(e.opened_at, lang)}</td>
          <td>{e.doctor_name}</td><td>{e.patient_name} <span className="text-xs text-muted tabular">{e.patient_number}</span></td><td>{e.reason}</td></tr>)}</tbody></table>}
  </Card>;
}
