'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, fmtDate, fmtTime } from '@/components/ui';
import { get } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { usePortal } from '@/lib/portal';

export default function PortalHome() {
  const { t, lang, status } = useI18n(); const { me, records } = usePortal();
  const [appts, setAppts] = useState<any[] | null>(null); const [reqs, setReqs] = useState<any[]>([]);
  const [install, setInstall] = useState<any>(null); const [ios, setIos] = useState(false);
  useEffect(() => {
    get<any[]>('/portal/appointments', null).then(setAppts).catch(() => setAppts([]));
    get<any[]>('/portal/requests', null).then((r) => setReqs(r.filter((x) => x.status === 'pending'))).catch(() => {});
    const standalone = window.matchMedia('(display-mode: standalone)').matches;
    const h = (e: Event) => { e.preventDefault(); setInstall(e); };
    window.addEventListener('beforeinstallprompt', h);
    if (!standalone && /iphone|ipad/i.test(navigator.userAgent)) setIos(true);
    return () => window.removeEventListener('beforeinstallprompt', h);
  }, []);
  const upcoming = (appts ?? []).filter((a) => new Date(a.starts_at) > new Date() && ['scheduled', 'confirmed'].includes(a.status)).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const next = upcoming[0];
  return (
    <div className="space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">{t('pHello')}, {me.user.full_name.split(' ')[0]}</h1>
      <Card title={t('pNextVisit')}>
        {appts === null ? <p className="text-sm text-muted">{t('loading')}</p> : next ? (
          <Link href="/portal/appointments" className="block">
            <p className="text-lg font-semibold">{fmtDate(next.starts_at, lang)} · {fmtTime(next.starts_at, lang)}</p>
            <p className="text-sm">{next.doctor_name} · {next.clinic}</p>
            {next.location_name && <p className="text-sm text-muted">{next.location_name}{next.location_address ? `, ${next.location_address}` : ''}</p>}
            <Badge status={next.status} className="mt-2">{status(next.status)}</Badge>
            {upcoming.length > 1 && <p className="mt-2 text-xs text-muted">+{upcoming.length - 1} {t('pUpcoming').toLowerCase()}</p>}
          </Link>
        ) : <p className="text-sm text-muted">{t('pNoUpcoming')}</p>}
        <Link href="/portal/appointments#request" className="mt-4 block"><Button className="w-full sm:w-auto">{t('pRequestVisit')}</Button></Link>
      </Card>
      {reqs.length > 0 && <Card title={t('pRequests')}>
        <ul className="divide-y divide-line">{reqs.map((r) => <li key={r.id} className="flex items-center justify-between py-2 text-sm">
          <span>{fmtDate(r.preferred_date, lang)} · {t(`t_${r.preferred_time}`)} · {r.clinic}</span><Badge>{t('rq_pending')}</Badge></li>)}</ul>
      </Card>}
      <div className="grid grid-cols-2 gap-3">
        <Link href="/portal/prescriptions" className="rounded-[12px] border border-line bg-card p-4 text-sm font-medium hover:border-brand"><span className="block text-2xl text-brand">℞</span>{t('pPrescriptions')}</Link>
        <Link href="/portal/documents" className="rounded-[12px] border border-line bg-card p-4 text-sm font-medium hover:border-brand"><span className="block text-2xl text-brand">▤</span>{t('pDocuments')}</Link>
      </div>
      <Card title={t('pYourClinics')}>
        {records.length ? <ul className="divide-y divide-line">{records.map((r) => <li key={r.patient_id} className="py-2 text-sm">
          <p className="font-medium">{r.clinic}</p>
          <p className="text-muted">{t('patientNumber')}: {r.patient_number}</p>
          {r.clinic_phone && <a href={`tel:${r.clinic_phone}`} className="text-brand hover:underline">{r.clinic_phone}</a>}
          {r.clinic_address && <p className="text-muted">{r.clinic_address}</p>}
        </li>)}</ul> : <Empty>{t('pNoRecords')}</Empty>}
      </Card>
      {(install || ios) && <Card title={t('pInstall')}>
        <p className="text-sm text-muted">{t('pInstallHint')}</p>
        {install ? <Button className="mt-3" onClick={async () => { await install.prompt(); setInstall(null); }}>{t('pInstall')}</Button> : <p className="mt-2 text-sm">{t('pInstallIos')}</p>}
      </Card>}
    </div>
  );
}
