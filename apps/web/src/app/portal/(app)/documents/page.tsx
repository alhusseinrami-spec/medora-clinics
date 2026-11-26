'use client';
import { useEffect, useState } from 'react';
import { Button, Card, Empty, ErrorNote, fmtDate } from '@/components/ui';
import { get, openFile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export default function PortalDocuments() {
  const { t, lang } = useI18n();
  const [docs, setDocs] = useState<any[] | null>(null); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { get<any[]>('/portal/documents', null).then(setDocs).catch(setErr); }, []);
  const open = (d: any, download: boolean) => openFile(`/portal/documents/${d.id}/content${download ? '?download=1' : ''}`, download ? d.title : undefined).catch(setErr);
  return (
    <div className="space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">{t('pDocuments')}</h1>
      <ErrorNote error={err} />
      <Card>
        {docs === null ? <p className="text-sm text-muted">{t('loading')}</p> : docs.length === 0 ? <Empty>{t('pNoDocuments')}</Empty> : (
          <ul className="divide-y divide-line">{docs.map((d) => <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-3 text-sm">
            <div><p className="font-medium">{d.title}</p><p className="text-muted">{d.clinic} · {fmtDate(d.created_at, lang)} · {size(Number(d.size_bytes))}</p></div>
            <div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => open(d, false)}>{t('pOpen')}</Button><Button size="sm" variant="ghost" onClick={() => open(d, true)}>{t('pDownload')}</Button></div>
          </li>)}</ul>
        )}
      </Card>
    </div>
  );
}
