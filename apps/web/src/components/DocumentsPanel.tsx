'use client';
import { useRef, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, fmtDate } from './ui';
import { del, openFile, patch, uploadFile } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad } from '@/lib/hooks';

const KINDS = ['lab_result', 'imaging', 'report', 'photo', 'insurance_card', 'other'];
const ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp,image/heic';
const size = (b: number) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);

/** Patient documents: upload (encrypted at rest), view, download, share flag, remove. Downloads are audited by the API. */
export function DocumentsPanel({ patientId, consultationId, compact, readOnly }: { patientId: string; consultationId?: string; compact?: boolean; readOnly?: boolean }) {
  const { t, lang } = useI18n(); const { can } = useWorkspace();
  const { data, reload } = useLoad<any[]>(`/patients/${patientId}/documents`);
  const [file, setFile] = useState<File | null>(null); const [title, setTitle] = useState(''); const [kind, setKind] = useState('lab_result');
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false); const input = useRef<HTMLInputElement>(null);
  const list = consultationId ? (data ?? []).filter((d) => d.consultation_id === consultationId) : data;
  const upload = async () => {
    if (!file) return; setBusy(true); setErr(null);
    try {
      const q = new URLSearchParams({ kind, title: title.trim() || file.name, filename: file.name, ...(consultationId ? { consultationId } : {}) });
      await uploadFile(`/patients/${patientId}/documents?${q}`, file);
      setFile(null); setTitle(''); if (input.current) input.current.value = ''; reload();
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const act = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); reload(); } catch (e) { setErr(e); } };
  return <div className="space-y-4">
    {can('document.upload') && !readOnly && <Card title={t('uploadDocument')}>
      <div className={compact ? 'grid gap-3' : 'grid gap-3 sm:grid-cols-[2fr_1fr_1fr_auto] sm:items-end'}>
        <Field label={t('title')}><Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={file?.name} /></Field>
        <Field label={t('kind')}><Select value={kind} onChange={(e) => setKind(e.target.value)}>{KINDS.map((k) => <option key={k} value={k}>{t(k)}</option>)}</Select></Field>
        <Field label="File"><input ref={input} type="file" accept={ACCEPT} className="block w-full text-sm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></Field>
        <Button busy={busy} disabled={!file} onClick={upload}>{t('upload')}</Button>
      </div>
      <p className="mt-2 text-xs text-muted">{t('fileTypes')}</p>
    </Card>}
    <ErrorNote error={err} />
    {!list ? <p className="text-muted">{t('loading')}</p> : list.length === 0 ? <Empty>{t('noDocuments')}</Empty> :
      <Card><ul className="divide-y divide-line">{list.map((d) => <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
        <div><p className="font-medium">{d.title}</p>
          <p className="text-xs text-muted tabular">{t(d.kind)} · {fmtDate(d.created_at, lang)} · {d.size_bytes ? size(d.size_bytes) : ''} · {t('uploadedBy')} {d.uploaded_by_name ?? '—'}</p></div>
        <div className="flex flex-wrap items-center gap-1.5">
          {d.shared_with_patient && <Badge>{t('sharedWithPatient')}</Badge>}
          <Button size="sm" variant="secondary" onClick={() => act(() => openFile(`/documents/${d.id}/content`))}>{t('view')}</Button>
          <Button size="sm" variant="ghost" onClick={() => act(() => openFile(`/documents/${d.id}/content?download=1`, d.original_filename ?? d.title))}>{t('download')}</Button>
          {can('document.upload') && <Button size="sm" variant="ghost" onClick={() => act(() => patch(`/documents/${d.id}`, { sharedWithPatient: !d.shared_with_patient }))}>{d.shared_with_patient ? t('unshare') : t('share')}</Button>}
          {can('document.upload') && <Button size="sm" variant="ghost" onClick={() => confirm(t('removeDocConfirm')) && act(() => del(`/documents/${d.id}`))}>{t('remove')}</Button>}
        </div>
      </li>)}</ul></Card>}
  </div>;
}
