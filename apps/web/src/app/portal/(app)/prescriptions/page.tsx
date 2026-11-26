'use client';
import { useEffect, useState } from 'react';
import { Badge, Card, Empty, ErrorNote, fmtDate } from '@/components/ui';
import { get } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

export default function PortalPrescriptions() {
  const { t, lang, status } = useI18n();
  const [rx, setRx] = useState<any[] | null>(null); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { get<any[]>('/portal/prescriptions', null).then(setRx).catch(setErr); }, []);
  return (
    <div className="space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">{t('pPrescriptions')}</h1>
      <p className="text-sm text-muted">{t('pSharedOnly')}</p>
      <ErrorNote error={err} />
      {rx === null ? <p className="text-sm text-muted">{t('loading')}</p> : rx.length === 0 ? <Empty>{t('pNoPrescriptions')}</Empty> : rx.map((r) => (
        <Card key={r.id} title={<span>{r.issued_at ? fmtDate(r.issued_at, lang) : '—'} · {r.doctor_name}</span>} actions={<Badge status={r.status}>{status(r.status)}</Badge>}>
          <p className="text-xs text-muted">{r.clinic}</p>
          <ul className="mt-2 divide-y divide-line">{(r.items ?? []).map((i: any, k: number) => <li key={k} className="py-2 text-sm">
            <p className="font-medium">{i.medication}</p>
            <p className="text-muted">{[i.dosage, i.frequency, i.duration, i.route].filter(Boolean).join(' · ')}</p>
            {i.instructions && <p>{i.instructions}</p>}
          </li>)}</ul>
          {r.notes && <p className="mt-2 text-sm">{r.notes}</p>}
        </Card>
      ))}
    </div>
  );
}
