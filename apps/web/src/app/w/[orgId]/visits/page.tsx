'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Badge, Card, Empty, ErrorNote, Field, Input, Select, Tabs, fmtDate, fmtTime } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad, useDoctors } from '@/lib/hooks';

/** Every visit (consultation) the user may see, newest first, with search by patient, complaint or diagnosis. */
export default function Visits() {
  const { t, lang } = useI18n(); const { can, orgId } = useWorkspace(); const doctors = useDoctors();
  const [tab, setTab] = useState('all'); const [q, setQ] = useState(''); const [doctor, setDoctor] = useState(''); const [from, setFrom] = useState(''); const [to, setTo] = useState('');
  const params = new URLSearchParams({ ...(tab !== 'all' ? { status: tab } : {}), ...(q.trim().length > 1 ? { q: q.trim() } : {}),
    ...(doctor ? { doctor } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) });
  const { data, error } = useLoad<any[]>(`/consultations?${params}`, [tab, q, doctor, from, to]);
  if (!can('clinical_notes.read')) return <Forbidden />;
  return <>
    <PageTitle title={t('visits')} sub={data ? `${data.length}${data.length >= 300 ? '+' : ''}` : undefined} />
    <div className="flex flex-wrap items-end gap-3">
      <Tabs tabs={[{ key: 'all', label: t('all') }, { key: 'draft', label: t('drafts') }, { key: 'signed', label: t('signed') }]} value={tab} onChange={setTab} />
      <Input className="!w-64" placeholder={`${t('search')}…`} value={q} onChange={(e) => setQ(e.target.value)} />
      <Field label={t('windowFrom')}><Input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} /></Field>
      <Field label={t('to')}><Input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} /></Field>
      {doctors.length > 1 && <Field label={t('doctor')}><Select value={doctor} onChange={(e) => setDoctor(e.target.value)} className="!w-52"><option value="">{t('allDoctors')}</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select></Field>}
    </div>
    <div className="mt-4"><ErrorNote error={error} /></div>
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>{t('noVisits')}</Empty> :
      <Card className="overflow-x-auto !p-0"><table className="w-full min-w-[720px] text-sm">
        <thead><tr className="border-b border-line text-start text-xs uppercase text-muted">
          <th className="px-4 py-2.5 text-start">{t('date')}</th><th className="text-start">{t('patient')}</th><th className="text-start">{t('doctor')}</th>
          <th className="text-start">{t('chiefComplaint')}</th><th className="text-start">{t('diagnosis')}</th><th className="pe-4 text-start">{t('status')}</th></tr></thead>
        <tbody>{data.map((c) => <tr key={c.id} className="border-b border-line/60 align-top last:border-0 hover:bg-surface/60">
          <td className="tabular px-4 py-2.5"><Link href={`/w/${orgId}/consultations/${c.id}`} className="font-medium text-brand hover:underline">{fmtDate(c.created_at, lang)}</Link><span className="block text-xs text-muted">{fmtTime(c.created_at, lang)}</span></td>
          <td className="py-2.5"><Link href={`/w/${orgId}/patients/${c.patient_id}`} className="font-medium hover:underline">{c.patient_name}</Link><span className="tabular block text-xs text-muted">{c.patient_number}</span></td>
          <td className="py-2.5">{c.doctor_name}</td>
          <td className="max-w-56 py-2.5"><span className="line-clamp-2">{c.chief_complaint ?? '—'}</span></td>
          <td className="max-w-56 py-2.5">{c.diagnoses.length ? c.diagnoses.join(', ') : '—'}</td>
          <td className="py-2.5 pe-4">{c.status === 'signed' ? <Badge status="completed">{t('signed')}</Badge> : <Badge status="draft">{t('draft')}</Badge>}</td>
        </tr>)}</tbody></table></Card>}
  </>;
}
