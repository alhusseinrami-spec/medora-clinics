'use client';
import { useState } from 'react';
import { Button, Card, ErrorNote, Field, Input, Select } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { patch, post, del } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';

export default function WorkspaceSettings() {
  const { t } = useI18n(); const { org, can, reload } = useWorkspace();
  const o = org.organization;
  const [f, setF] = useState({ name: o.name, phone: o.phone ?? '', email: o.email ?? '', address: o.address ?? '', defaultLanguage: o.default_language, timezone: o.timezone });
  const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(false); const [busy, setBusy] = useState(false);
  const [loc, setLoc] = useState(''); const [room, setRoom] = useState<Record<string, string>>({}); const [dep, setDep] = useState('');
  if (!can('org.manage')) return <Forbidden />;
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); await reload(); } catch (e) { setErr(e); } };
  const save = async (e: React.FormEvent) => { e.preventDefault(); setBusy(true); setOk(false);
    await run(() => patch('/org', { name: f.name, phone: f.phone || null, email: f.email || null, address: f.address || null, defaultLanguage: f.defaultLanguage, timezone: f.timezone })); setOk(true); setBusy(false); };
  return (
    <>
      <PageTitle title={t('workspace')} />
      <ErrorNote error={err} />
      <div className="grid gap-6 lg:grid-cols-2">
        <Card title={o.kind === 'medical_center' ? t('centerName') : t('clinicName')}>
          <form onSubmit={save} className="grid gap-3">
            <Field label={t('fullName')}><Input required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label={t('phone')}><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
            <Field label={t('email')}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
            <Field label={t('address')}><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
            <Field label={t('language')}><Select value={f.defaultLanguage} onChange={(e) => setF({ ...f, defaultLanguage: e.target.value })}><option value="en">English</option><option value="ar">العربية</option><option value="fr">Français</option></Select></Field>
            <Field label="Time zone" hint="IANA name, e.g. Asia/Beirut"><Input value={f.timezone} onChange={(e) => setF({ ...f, timezone: e.target.value })} /></Field>
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
          {o.kind === 'medical_center' && <Card title={t('departments')}>
            <ul className="mb-3 flex flex-wrap gap-1.5">{org.departments.map((d) => <li key={d.id} className="rounded-full bg-brand-soft px-2.5 py-0.5 text-xs text-brand">{d.name}</li>)}</ul>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (dep) run(() => post('/org/departments', { name: dep }).then(() => setDep(''))); }}>
              <Input placeholder={`${t('departments')}…`} value={dep} onChange={(e) => setDep(e.target.value)} /><Button variant="secondary">{t('add')}</Button></form>
          </Card>}
        </div>
      </div>
    </>
  );
}
