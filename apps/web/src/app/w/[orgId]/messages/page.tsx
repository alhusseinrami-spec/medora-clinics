'use client';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, Empty, ErrorNote, Select, Tabs, Textarea, cx, fmtDate, fmtTime } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { PatientPicker } from '@/components/AppointmentDialog';
import { del, get, patch, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad } from '@/lib/hooks';
import { queueBadge } from '@/components/Comm';

export default function Messages() {
  const { t } = useI18n(); const { can, orgId } = useWorkspace();
  const [tab, setTab] = useState('inbox');
  const accounts = useLoad<any[]>(can('whatsapp.send') ? '/whatsapp/accounts' : null);
  if (!can('whatsapp.send')) return <Forbidden />;
  const connected = (accounts.data ?? []).some((a) => a.is_active && a.status === 'connected');
  return <>
    <PageTitle title={t('messages')} />
    {accounts.data && !connected && <p className="mb-4 rounded-[10px] bg-warning/10 p-3 text-sm text-warning">{t('notConnected')} <Link className="font-medium underline" href={`/w/${orgId}/settings/whatsapp`}>{t('connectNow')}</Link></p>}
    <Tabs tabs={[{ key: 'inbox', label: t('inbox') }, { key: 'outbox', label: t('outbox') }]} value={tab} onChange={setTab} />
    <div className="mt-5">{tab === 'inbox' ? <Suspense><Inbox /></Suspense> : <Outbox />}</div>
  </>;
}

function Inbox() {
  const { t, lang } = useI18n(); const { subscribe } = useWorkspace();
  const params = useSearchParams();
  const [filter, setFilter] = useState('unanswered'); const [sel, setSel] = useState<string | null>(params.get('c') || null);
  const { data, error, reload } = useLoad<any[]>(`/whatsapp/conversations?filter=${filter}`);
  const [tick, setTick] = useState(0);
  useEffect(() => subscribe((e) => { if (e.type === 'whatsapp') { reload(); setTick((x) => x + 1); } }), [subscribe, reload]);
  const filters = ['unanswered', 'needs_staff', 'mine', 'open', 'closed'];
  return <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
    <Card className="p-0">
      <div className="flex flex-wrap gap-1.5 border-b border-line p-3">{filters.map((f) => <button key={f} onClick={() => setFilter(f)}
        className={cx('rounded-full px-3 py-1 text-xs', filter === f ? 'bg-brand text-white' : 'bg-surface text-muted hover:text-ink')}>{t(f)}</button>)}</div>
      <ErrorNote error={error} />
      {!data ? <p className="p-4 text-muted">{t('loading')}</p> : data.length === 0 ? <p className="p-6 text-center text-sm text-muted">{t('noConversations')}</p> :
        <ul className="max-h-[65vh] divide-y divide-line overflow-y-auto">{data.map((c) => <li key={c.id}>
          <button onClick={() => setSel(c.id)} className={cx('w-full px-4 py-3 text-start hover:bg-surface', sel === c.id && 'bg-brand-soft')}>
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 items-center gap-1.5"><span className="truncate font-medium">{c.patient_name ?? `+${c.contact_number}`}</span>
                {c.needs_staff && <span title={t(`ns_${c.needs_staff_reason ?? 'message'}`)} className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[10px] font-medium text-warning">{t('needsPerson')}</span>}</span>
              <span className="shrink-0 text-xs text-muted tabular">{c.last_message_at ? fmtTime(c.last_message_at, lang) : ''}</span>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs text-muted">{c.last_body ?? ''}</span>
              {c.unread > 0 && <span className="rounded-full bg-brand px-1.5 text-[11px] text-white tabular">{c.unread}</span>}
            </div>
          </button></li>)}</ul>}
    </Card>
    {sel ? <Thread key={sel} id={sel} tick={tick} onChange={reload} /> : <Card><p className="py-10 text-center text-sm text-muted">{t('selectConversation')}</p></Card>}
  </div>;
}

function Thread({ id, tick, onChange }: { id: string; tick: number; onChange: () => void }) {
  const { t, lang } = useI18n(); const { orgId } = useWorkspace();
  const [c, setC] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [text, setText] = useState(''); const [busy, setBusy] = useState(false);
  const team = useLoad<any[]>('/whatsapp/team'); const [linking, setLinking] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => get(`/whatsapp/conversations/${id}`).then((x) => { setC(x); onChange(); }).catch(setErr), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load, tick]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [c?.messages?.length]);
  const act = async (a: 'take' | 'hand-back') => { try { await post(`/whatsapp/conversations/${id}/${a}`); load(); } catch (e) { setErr(e); } };
  const renew = async () => { try { await post('/refills', { patientId: c.patient_id, conversationId: id, note: null }); load(); } catch (e) { setErr(e); } };
  const update = async (b: object) => { try { await patch(`/whatsapp/conversations/${id}`, b); load(); } catch (e) { setErr(e); } };
  const send = async () => {
    if (!text.trim()) return; setBusy(true); setErr(null);
    try { await post(`/whatsapp/conversations/${id}/reply`, { body: text.trim() }); setText(''); load(); } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (!c) return <Card><ErrorNote error={err} /><p className="text-muted">{t('loading')}</p></Card>;
  return <Card title={<span>{c.patient_name ? <Link className="hover:underline" href={`/w/${orgId}/patients/${c.patient_id}`}>{c.patient_name}</Link> : t('unknownContact')}
      <span className="ms-2 text-xs font-normal text-muted tabular">+{c.contact_number} · {t('viaNumber')} {c.display_number}</span></span>}
    actions={<div className="flex flex-wrap items-center gap-2">
      <span className={cx('rounded-full px-2 py-0.5 text-[11px] font-medium', c.handled_by === 'staff' ? 'bg-brand-soft text-brand' : 'bg-surface text-muted')}>{c.handled_by === 'staff' ? t('handledByTeam') : t('handledAuto')}</span>
      {c.handled_by === 'staff' ? <Button size="sm" variant="ghost" onClick={() => act('hand-back')}>{t('handBack')}</Button>
        : <Button size="sm" variant="secondary" onClick={() => act('take')}>{t('takeOver')}</Button>}
      <Select className="!h-8 !w-44 text-xs" value={c.assigned_to ?? ''} onChange={(e) => update({ assignedTo: e.target.value || null })} aria-label={t('assignTo')}>
        <option value="">{t('unassigned')}</option>{(team.data ?? []).map((m) => <option key={m.id} value={m.id}>{m.full_name}</option>)}</Select>
      <Button size="sm" variant="secondary" onClick={() => update({ status: c.status === 'open' ? 'closed' : 'open' })}>{c.status === 'open' ? t('closeConv') : t('reopen')}</Button>
    </div>}>
    {c.needs_staff && <p className="mb-3 rounded-[10px] bg-warning/10 p-2.5 text-sm text-warning">{t('needsPerson')}: {t(`ns_${c.needs_staff_reason ?? 'message'}`)}</p>}
    {c.patient_id && <div className="mb-3 flex flex-wrap items-center gap-2 text-xs text-muted">
      {c.refills.filter((r: any) => r.status === 'pending').length > 0
        ? <Link href={`/w/${orgId}/prescriptions?tab=refills`} className="rounded-full bg-accent/15 px-2 py-0.5 font-medium text-accent hover:underline">℞ {t('refillPending')}</Link>
        : <button onClick={renew} className="text-brand hover:underline">℞ {t('requestRefill')}</button>}
      {c.refills.filter((r: any) => r.status !== 'pending').slice(0, 1).map((r: any) => <span key={r.id}>· {t(`refill_${r.status}`)} {fmtDate(r.decided_at, lang)}</span>)}
    </div>}
    {!c.patient_id && <div className="mb-3 rounded-[10px] bg-surface p-3 text-sm">{linking ? <PatientPicker value={null} onChange={(p: any) => { if (p) { update({ patientId: p.id }); setLinking(false); } }} />
      : <button className="text-brand hover:underline" onClick={() => setLinking(true)}>{t('linkPatient')}</button>}</div>}
    <div className="max-h-[52vh] space-y-2 overflow-y-auto pe-1">
      {c.messages.map((m: any) => <div key={m.id} className={cx('flex', m.direction === 'outbound' ? 'justify-end' : 'justify-start')}>
        <div className={cx('max-w-[80%] rounded-[12px] px-3 py-2 text-sm', m.direction === 'outbound' ? 'bg-brand-soft' : 'bg-surface')}>
          {m.purpose && <p className="mb-0.5 text-[11px] font-medium text-brand">{t(`p_${m.purpose}`)}</p>}
          <p className="whitespace-pre-wrap">{m.body}</p>
          <p className="mt-1 text-[11px] text-muted tabular">{fmtDate(m.created_at, lang)} {fmtTime(m.created_at, lang)}
            {m.direction === 'outbound' && <> · {t(`msg_${m.status}`)}{m.sent_by_name ? ` · ${m.sent_by_name}` : ` · ${t('automated')}`}</>}</p>
          {m.error && <p className="text-[11px] text-danger">{m.error}</p>}
        </div></div>)}
      <div ref={end} />
    </div>
    <div className="mt-4 border-t border-line pt-3">
      {c.window_open ? <div className="flex items-end gap-2">
        <Textarea rows={2} className="flex-1" placeholder={t('typeReply')} value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); }} />
        <Button busy={busy} disabled={!text.trim()} onClick={send}>{t('send')}</Button></div>
        : <p className="text-sm text-muted">{t('windowClosed')}</p>}
      <div className="mt-2"><ErrorNote error={err} /></div>
    </div>
  </Card>;
}

function Outbox() {
  const { t, lang } = useI18n(); const { orgId } = useWorkspace();
  const [status, setStatus] = useState(''); const [err, setErr] = useState<unknown>(null);
  const { data, error, reload } = useLoad<any[]>(`/whatsapp/queue${status ? `?status=${status}` : ''}`);
  return <>
    <div className="mb-3 flex flex-wrap gap-1.5">{['', 'pending', 'sent', 'skipped', 'failed', 'cancelled'].map((s) => <button key={s} onClick={() => setStatus(s)}
      className={cx('rounded-full px-3 py-1 text-xs', status === s ? 'bg-brand text-white' : 'bg-surface text-muted hover:text-ink')}>{s ? t(`q_${s}`) : t('all')}</button>)}</div>
    <ErrorNote error={error ?? err} />
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <Empty>—</Empty> :
      <Card><table className="w-full text-sm"><tbody>{data.map((s) => <tr key={s.id} className="border-t border-line first:border-0">
        <td className="py-2.5"><p className="font-medium">{t(`p_${s.purpose}`)}</p><p className="text-xs text-muted tabular">{fmtDate(s.send_at, lang)} {fmtTime(s.send_at, lang)} · {s.created_by_name ?? t('automated')}</p></td>
        <td><Link className="hover:underline" href={`/w/${orgId}/patients/${s.patient_id}`}>{s.patient_name}</Link></td>
        <td className="text-end">{queueBadge(s, t)}</td>
        <td className="w-20 text-end">{s.status === 'pending' && <Button size="sm" variant="ghost" onClick={async () => { try { await del(`/whatsapp/queue/${s.id}`); reload(); } catch (e) { setErr(e); } }}>✕</Button>}</td>
      </tr>)}</tbody></table></Card>}
  </>;
}
