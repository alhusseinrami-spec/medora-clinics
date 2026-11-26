'use client';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Empty, ErrorNote, Field, Input, Select, Textarea, cx, fmtDate, fmtTime } from '@/components/ui';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/** One support conversation. Used by the requester and by MEDORA staff in the admin console. */
export function SupportThread({ id, onChange, staff }: { id: string; onChange?: () => void; staff?: boolean }) {
  const { t, lang } = useI18n();
  const [r, setR] = useState<any>(null); const [body, setBody] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  useEffect(() => { setR(null); get(`/support/${id}`, null).then(setR).catch(setErr); }, [id]);
  const run = async (fn: () => Promise<any>) => { setBusy(true); setErr(null); try { setR(await fn()); onChange?.(); } catch (x) { setErr(x); } finally { setBusy(false); } };
  if (!r) return <ErrorNote error={err} />;
  return (
    <Card title={r.subject} actions={<Badge status={r.status}>{t(`rs_${r.status}`)}</Badge>}>
      <p className="text-xs text-muted">{t(`c_${r.category}`)}{r.organization_name ? ` · ${r.organization_name}` : ''}{staff ? ` · ${r.user_name} <${r.user_email}>` : ''}</p>
      <ul className="mt-4 space-y-3">{r.messages.map((m: any) => (
        <li key={m.id} className={cx('max-w-[85%] rounded-[12px] px-3 py-2 text-sm', m.from_staff ? 'bg-brand-soft' : 'ms-auto bg-surface')}>
          <p className="whitespace-pre-wrap">{m.body}</p>
          <p className="mt-1 text-[11px] text-muted">{m.author} · {fmtDate(m.created_at, lang)} {fmtTime(m.created_at, lang)}</p>
        </li>))}</ul>
      <ErrorNote error={err} />
      {r.status !== 'closed' ? <form className="mt-4 space-y-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) run(() => post(`/support/${id}/messages`, { body }).then((x) => { setBody(''); return x; })); }}>
        <Textarea required maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} placeholder={`${t('reply')}…`} />
        <div className="flex justify-between gap-2"><Button type="button" variant="ghost" busy={busy} onClick={() => run(() => post(`/support/${id}/status`, { status: 'closed' }))}>{t('closeRequest')}</Button><Button busy={busy}>{t('reply')}</Button></div>
      </form> : <Button className="mt-4" variant="secondary" busy={busy} onClick={() => run(() => post(`/support/${id}/status`, { status: 'open' }))}>{t('reopenRequest')}</Button>}
    </Card>
  );
}

/** The signed-in user's own support requests, with a form for a new one. */
export function MySupport({ organizationId }: { organizationId: string | null }) {
  const { t, lang } = useI18n();
  const [list, setList] = useState<any[] | null>(null); const [sel, setSel] = useState<string | null>(null);
  const [f, setF] = useState({ category: 'billing', subject: '', body: '' }); const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => get<any[]>('/support', null).then(setList).catch(setErr), []);
  useEffect(() => { load(); }, [load]);
  const create = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { const r = await post('/support', { organizationId, ...f }); setF({ category: 'billing', subject: '', body: '' }); await load(); setSel(r.id); } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
      <div className="space-y-6">
        <Card title={t('newRequest')}>
          <p className="mb-3 text-sm text-muted">{t('supportHint')}</p>
          <form onSubmit={create} className="space-y-3">
            <Field label={t('category')}><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['billing', 'plan', 'technical', 'account', 'other'].map((c) => <option key={c} value={c}>{t(`c_${c}`)}</option>)}</Select></Field>
            <Field label={t('subject')}><Input required minLength={3} maxLength={200} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></Field>
            <Field label={t('message')}><Textarea required rows={4} maxLength={5000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
            <ErrorNote error={err} /><Button busy={busy}>{t('sendRequest')}</Button>
          </form>
        </Card>
        <Card title={t('support')}>
          {!list ? <p className="text-sm text-muted">{t('loading')}</p> : list.length === 0 ? <Empty>{t('noRequests6')}</Empty> : <ul className="divide-y divide-line">{list.map((r) => (
            <li key={r.id}><button onClick={() => setSel(r.id)} className={cx('flex w-full items-center justify-between gap-2 py-2.5 text-start text-sm', sel === r.id && 'text-brand')}>
              <span><span className="font-medium">{r.subject}</span><span className="block text-xs text-muted">{fmtDate(r.updated_at, lang)}{r.organization_name ? ` · ${r.organization_name}` : ''}</span></span>
              <Badge status={r.status}>{t(`rs_${r.status}`)}</Badge></button></li>))}</ul>}
        </Card>
      </div>
      <div>{sel && <SupportThread id={sel} onChange={load} />}</div>
    </div>
  );
}
