'use client';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, Dialog, ErrorNote, Field, Input, Select, Switch, Textarea, fmtDate } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { del, patch, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useDoctors, useLoad } from '@/lib/hooks';

export default function WhatsAppSettings() {
  const { t } = useI18n(); const { can } = useWorkspace();
  if (!can('whatsapp.send')) return <Forbidden />;
  return <>
    <PageTitle title="WhatsApp" />
    <div className="space-y-6">
      <Numbers />
      <Automation />
      {can('template.manage') && <Templates />}
      {can('org.manage') && <Announcement />}
    </div>
  </>;
}

function Numbers() {
  const { t, lang } = useI18n(); const { org, can } = useWorkspace();
  const { data, error, reload } = useLoad<any[]>('/whatsapp/accounts');
  const [add, setAdd] = useState(false); const [token, setToken] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const [origin, setOrigin] = useState(''); useEffect(() => setOrigin(location.origin), []);
  const act = async (id: string, fn: () => Promise<unknown>) => { setBusy(id); setErr(null); try { await fn(); reload(); } catch (e) { setErr(e); } finally { setBusy(null); } };
  return <Card title={t('connection')} actions={<Button size="sm" onClick={() => setAdd(true)}>+ {t('addNumber')}</Button>}>
    <ErrorNote error={error ?? err} />
    {!data ? <p className="text-muted">{t('loading')}</p> : data.length === 0 ? <p className="text-sm text-muted">{t('notConnected')}</p> :
      <ul className="divide-y divide-line">{data.map((a) => <li key={a.id} className="flex flex-wrap items-start justify-between gap-3 py-3 text-sm">
        <div>
          <p className="font-medium tabular">{a.display_number} <span className="font-normal text-muted">· {a.membership_id ? a.doctor_name : t('workspaceNumber')}</span></p>
          <p className="text-xs text-muted tabular">{t('phoneNumberId')} {a.phone_number_id}{a.connected_at ? ` · ${fmtDate(a.connected_at, lang)}` : ''}</p>
          {a.last_error && a.status !== 'connected' && <p className="mt-1 text-xs text-danger">{a.last_error}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge status={a.status === 'connected' ? 'completed' : a.status === 'disconnected' ? 'cancelled' : 'scheduled'}>{t(`st_${a.status}`)}</Badge>
          {a.is_active && <>
            <Button size="sm" variant="secondary" busy={busy === a.id} onClick={() => act(a.id, () => post(`/whatsapp/accounts/${a.id}/test`))}>{t('testConnection')}</Button>
            <Button size="sm" variant="ghost" onClick={() => setToken(a)}>{t('replaceToken')}</Button>
            <Button size="sm" variant="ghost" onClick={() => confirm(`${t('deactivate')}?`) && act(a.id, () => patch(`/whatsapp/accounts/${a.id}`, { isActive: false }))}>{t('deactivate')}</Button>
          </>}
        </div></li>)}</ul>}
    <div className="mt-4 rounded-[10px] bg-surface p-3 text-xs text-muted">
      <p>{t('webhookHelp')}</p><p className="mt-1 select-all font-mono text-ink">{origin}/api/webhooks/whatsapp</p>
    </div>
    {add && <AddNumber orgKind={org.organization.kind} canWorkspace={can('org.manage')} onClose={() => setAdd(false)} onSaved={() => { setAdd(false); reload(); }} />}
    {token && <Dialog open onClose={() => setToken(null)} title={t('replaceToken')}><TokenForm onSubmit={async (accessToken) => { await patch(`/whatsapp/accounts/${token.id}`, { accessToken }); setToken(null); reload(); }} /></Dialog>}
  </Card>;
}

function TokenForm({ onSubmit }: { onSubmit: (token: string) => Promise<void> }) {
  const { t } = useI18n(); const [v, setV] = useState(''); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  return <>
    <Field label={t('accessToken')} hint={t('accessTokenHint')}><Input type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} /></Field>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button busy={busy} disabled={v.trim().length < 20} onClick={async () => { setBusy(true); try { await onSubmit(v.trim()); } catch (e) { setErr(e); } finally { setBusy(false); } }}>{t('save')}</Button></div>
  </>;
}

function AddNumber({ orgKind, canWorkspace, onClose, onSaved }: { orgKind: string; canWorkspace: boolean; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n(); const { org } = useWorkspace(); const doctors = useDoctors();
  const [f, setF] = useState({ phoneNumberId: '', displayNumber: '', wabaId: '', accessToken: '', membershipId: canWorkspace ? '' : (org.me.doctorMembershipId ?? '') });
  const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const s = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return <Dialog open onClose={onClose} title={t('addNumber')}>
    <div className="grid gap-3">
      {orgKind === 'medical_center' && <Field label={t('numberFor')}><Select value={f.membershipId} onChange={s('membershipId')}>
        {canWorkspace && <option value="">{t('workspaceNumber')}</option>}
        {doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select></Field>}
      <Field label={t('displayNumber')}><Input placeholder="+961 …" value={f.displayNumber} onChange={s('displayNumber')} /></Field>
      <Field label={t('phoneNumberId')}><Input inputMode="numeric" value={f.phoneNumberId} onChange={s('phoneNumberId')} /></Field>
      <Field label={t('wabaId')}><Input inputMode="numeric" value={f.wabaId} onChange={s('wabaId')} /></Field>
      <Field label={t('accessToken')} hint={t('accessTokenHint')}><Input type="password" autoComplete="off" value={f.accessToken} onChange={s('accessToken')} /></Field>
    </div>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end"><Button busy={busy} disabled={!f.phoneNumberId || !f.displayNumber || f.accessToken.length < 20} onClick={async () => {
      setBusy(true); setErr(null);
      try { await post('/whatsapp/accounts', { phoneNumberId: f.phoneNumberId.trim(), displayNumber: f.displayNumber.trim(), wabaId: f.wabaId.trim() || null, accessToken: f.accessToken.trim(), membershipId: f.membershipId || null }); onSaved(); }
      catch (e) { setErr(e); } finally { setBusy(false); }
    }}>{t('testConnection')}</Button></div>
  </Dialog>;
}

function Automation() {
  const { t } = useI18n(); const { can } = useWorkspace();
  const { data, error, setData } = useLoad<any[]>('/whatsapp/automation'); const [err, setErr] = useState<unknown>(null);
  const editable = can('org.manage');
  const save = async (row: any, change: Partial<any>) => {
    const next = { ...row, ...change };
    try {
      const r = await put(`/whatsapp/automation/${row.purpose}`, { enabled: next.enabled, offsetMinutes: next.offset_minutes, followUpDays: next.follow_up_days, sendHour: next.send_hour });
      setData((data ?? []).map((x) => (x.purpose === row.purpose ? r : x)));
    } catch (e) { setErr(e); }
  };
  return <Card title={t('automation')}>
    <p className="mb-3 text-sm text-muted">{t('automationHint')}</p>
    <ErrorNote error={error ?? err} />
    {!data ? <p className="text-muted">{t('loading')}</p> : <ul className="divide-y divide-line">{data.map((a) => <li key={a.purpose} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
      <div className="flex items-center gap-3"><Switch checked={a.enabled} disabled={!editable} onChange={(v) => save(a, { enabled: v })} label={t(`p_${a.purpose}`)} /><span>{t(`p_${a.purpose}`)}</span></div>
      <div className="flex items-center gap-2 text-xs text-muted">
        {a.purpose.startsWith('reminder') && <label className="flex items-center gap-2">{t('hoursBefore')}
          <Input className="h-8 w-20" type="number" min={1} max={168} disabled={!editable} defaultValue={Math.round(-a.offset_minutes / 60)}
            onBlur={(e) => { const h = Number(e.target.value); if (h >= 1 && -h * 60 !== a.offset_minutes) save(a, { offset_minutes: -h * 60 }); }} /></label>}
        {a.purpose === 'follow_up' && <>
          <label className="flex items-center gap-2">{t('daysBefore')}<Input className="h-8 w-16" type="number" min={0} max={30} disabled={!editable} defaultValue={a.follow_up_days ?? 2}
            onBlur={(e) => { const d = Number(e.target.value); if (d !== a.follow_up_days) save(a, { follow_up_days: d }); }} /></label>
          <label className="flex items-center gap-2">{t('atHour')}<Input className="h-8 w-16" type="number" min={0} max={23} disabled={!editable} defaultValue={a.send_hour ?? 10}
            onBlur={(e) => { const h = Number(e.target.value); if (h !== a.send_hour) save(a, { send_hour: h }); }} /></label></>}
      </div></li>)}</ul>}
  </Card>;
}

function Templates() {
  const { t } = useI18n();
  const { data, error, reload } = useLoad<any[]>('/whatsapp/templates');
  const [lang, setLang] = useState('en'); const [edit, setEdit] = useState<any>(null);
  return <Card title={t('msgTemplates')} actions={<Select className="h-8 w-28 text-xs" value={lang} onChange={(e) => setLang(e.target.value)}><option value="en">English</option><option value="fr">Français</option><option value="ar">العربية</option></Select>}>
    <ErrorNote error={error} />
    {!data ? <p className="text-muted">{t('loading')}</p> : <ul className="divide-y divide-line">{data.filter((x) => x.language === lang).map((x) => <li key={x.purpose} className="flex items-start justify-between gap-3 py-3 text-sm">
      <div className="min-w-0"><p className="font-medium">{t(`p_${x.purpose}`)} {x.custom_body && <Badge>{t('custom')}</Badge>} {x.meta_template_name && <Badge status="completed">Meta: {x.meta_template_name}</Badge>}</p>
        <p className="mt-0.5 text-muted" dir={lang === 'ar' ? 'rtl' : 'ltr'}>{x.custom_body ?? x.default_body}</p></div>
      <Button size="sm" variant="ghost" onClick={() => setEdit(x)}>{t('edit')}</Button></li>)}</ul>}
    {edit && <TemplateDialog tpl={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
  </Card>;
}

function TemplateDialog({ tpl, onClose, onSaved }: { tpl: any; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const [body, setBody] = useState(tpl.custom_body ?? tpl.default_body); const [name, setName] = useState(tpl.meta_template_name ?? ''); const [err, setErr] = useState<unknown>(null);
  return <Dialog open onClose={onClose} title={`${t(`p_${tpl.purpose}`)} · ${tpl.language.toUpperCase()}`} wide>
    <Field label={t('messageText')} hint="{patient} {doctor} {clinic} {date} {time} {amount} {message}"><Textarea rows={4} dir={tpl.language === 'ar' ? 'rtl' : 'ltr'} value={body} onChange={(e) => setBody(e.target.value)} /></Field>
    <Field className="mt-3" label={t('metaTemplateName')} hint={<>{t('templateHint')} {tpl.params.map((p: string, i: number) => <code key={p} className="me-1">{`{{${i + 1}}}=${p}`}</code>)}</>}>
      <Input value={name} placeholder="appointment_reminder" onChange={(e) => setName(e.target.value.toLowerCase())} /></Field>
    <div className="mt-3"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-between gap-2">
      {tpl.custom_body ? <Button variant="ghost" onClick={async () => { try { await del(`/whatsapp/templates/${tpl.purpose}/${tpl.language}`); onSaved(); } catch (e) { setErr(e); } }}>{t('resetDefault')}</Button> : <span />}
      <Button disabled={body.trim().length < 5} onClick={async () => { try { await put(`/whatsapp/templates/${tpl.purpose}/${tpl.language}`, { body: body.trim(), metaTemplateName: name.trim() || null }); onSaved(); } catch (e) { setErr(e); } }}>{t('save')}</Button>
    </div>
  </Dialog>;
}

function Announcement() {
  const { t } = useI18n(); const [msg, setMsg] = useState(''); const [err, setErr] = useState<unknown>(null); const [done, setDone] = useState<number | null>(null);
  return <Card title={t('announcement')}>
    <Textarea rows={3} maxLength={600} value={msg} onChange={(e) => { setMsg(e.target.value); setDone(null); }} />
    <div className="mt-3 flex items-center justify-between gap-3">
      <span className="text-sm text-muted">{done !== null ? `${done} ${t('queuedN')}` : ''}</span>
      <Button disabled={msg.trim().length < 5} onClick={async () => {
        if (!confirm(t('announcementConfirm'))) return;
        try { const r = await post('/whatsapp/announcements', { message: msg.trim() }); setDone(r.queued); setMsg(''); } catch (e) { setErr(e); }
      }}>{t('sendAnnouncement')}</Button>
    </div>
    <div className="mt-2"><ErrorNote error={err} /></div>
  </Card>;
}
