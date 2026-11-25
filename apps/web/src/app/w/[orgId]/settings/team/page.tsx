'use client';
import { useState } from 'react';
import { PERMISSIONS, PERMISSION_CODES, isGrantable } from '@medora/shared';
import { Badge, Button, Card, Dialog, Empty, ErrorNote, Field, Input, Select, Switch } from '@/components/ui';
import { PageTitle } from '@/components/Shell';
import { del, patch, post, put } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';
import { useLoad, type Member } from '@/lib/hooks';

export default function Team() {
  const { t, role } = useI18n(); const { org, can, me } = useWorkspace();
  const { data: members, reload } = useLoad<Member[]>('/staff');
  const { data: invites, reload: reloadInv } = useLoad<any[]>(can('staff.manage') ? '/staff/invitations' : null);
  const [inviteOpen, setInviteOpen] = useState(false); const [permFor, setPermFor] = useState<Member | null>(null);
  const doctors = (members ?? []).filter((m) => m.role_code === 'doctor');
  const name = (id: string) => doctors.find((d) => d.id === id)?.full_name ?? '—';
  const canEditPerms = (m: Member) => m.user_id !== me.user.id && (can('staff.manage') ? can('permission.manage') : can('permission.manage') && m.assists.includes(org.me.doctorMembershipId ?? ''));
  return (
    <>
      <PageTitle title={t('team')} sub={org.organization.name} actions={can('staff.manage') && <Button onClick={() => setInviteOpen(true)}>{t('invite')}</Button>} />
      <Card>
        {!members ? <p className="text-muted">{t('loading')}</p> : <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead className="text-xs uppercase text-muted"><tr><th className="py-2 text-start">{t('fullName')}</th><th className="text-start">{t('role')}</th><th className="text-start">{t('assignTo')}</th><th className="text-start">{t('status')}</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{members.map((m) => <tr key={m.id}>
            <td className="py-2.5"><p className="font-medium">{m.full_name}</p><p className="text-xs text-muted">{m.email ?? ''}{m.specialty_code ? ` · ${m.specialty_code}` : ''}</p></td>
            <td>{role(m.role_code)}</td>
            <td className="text-xs">{m.assists.map(name).join(', ') || '—'}</td>
            <td><Badge status={m.status === 'active' ? 'completed' : 'cancelled'}>{t(m.status)}</Badge></td>
            <td className="space-x-1 text-end whitespace-nowrap">
              {canEditPerms(m) && <Button size="sm" variant="secondary" onClick={() => setPermFor(m)}>{t('permissions')}</Button>}
              {can('staff.manage') && m.user_id !== me.user.id && <Button size="sm" variant="ghost" onClick={async () => { await patch(`/staff/${m.id}`, { status: m.status === 'active' ? 'suspended' : 'active' }); reload(); }}>{m.status === 'active' ? 'Suspend' : 'Reactivate'}</Button>}
            </td></tr>)}</tbody></table></div>}
      </Card>
      {can('staff.manage') && <Card title="Invitations" className="mt-6">
        {!invites?.length ? <Empty>{t('none')}</Empty> : <ul className="divide-y divide-line text-sm">{invites.map((i) => <li key={i.id} className="flex items-center justify-between py-2">
          <span>{i.email} · {role(i.role_code)} <span className="text-xs text-muted">· {i.accepted_at ? 'accepted' : i.revoked_at ? 'revoked' : new Date(i.expires_at) < new Date() ? 'expired' : 'pending'}</span></span>
          {!i.accepted_at && !i.revoked_at && <Button size="sm" variant="ghost" onClick={async () => { await del(`/staff/invitations/${i.id}`); reloadInv(); }}>Revoke</Button>}
        </li>)}</ul>}
      </Card>}
      <InviteDialog open={inviteOpen} onClose={() => { setInviteOpen(false); reloadInv(); }} doctors={doctors} />
      {permFor && <PermissionsDialog m={permFor} onClose={() => { setPermFor(null); reload(); }} />}
    </>
  );
}

function InviteDialog({ open, onClose, doctors }: { open: boolean; onClose: () => void; doctors: Member[] }) {
  const { t, role, lang } = useI18n(); const { org } = useWorkspace();
  const { data: specialties } = useLoad<any[]>('/specialties');
  const roles = org.organization.kind === 'independent_practice' ? ['assistant', 'receptionist', 'accountant'] : ['doctor', 'assistant', 'receptionist', 'center_admin', 'accountant', 'insurance_admin'];
  const [f, setF] = useState({ email: '', role: 'assistant', specialty: 'general_practice', departmentId: '', consultationFee: '', assignTo: '' });
  const [res, setRes] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      setRes(await post('/staff/invitations', { email: f.email, role: f.role, specialty: f.role === 'doctor' ? f.specialty : undefined, departmentId: f.departmentId || undefined,
        consultationFee: f.role === 'doctor' && f.consultationFee ? Number(f.consultationFee) : undefined, assignToDoctorMembershipId: ['assistant', 'receptionist'].includes(f.role) && f.assignTo ? f.assignTo : undefined }));
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  const close = () => { setRes(null); setF({ ...f, email: '' }); onClose(); };
  return <Dialog open={open} onClose={close} title={t('invite')}>
    {res ? <div className="space-y-3 text-sm">
      <p>Invitation created for <b>{res.email}</b>.</p>
      {res.emailDelivery === 'awaiting_credentials' && <p className="rounded-[10px] bg-warning/10 p-3 text-warning">{t('emailAwaiting')}</p>}
      <Field label={t('inviteLink')}><div className="flex gap-2"><Input readOnly value={res.acceptUrl} onFocus={(e) => e.target.select()} /><Button type="button" variant="secondary" onClick={() => navigator.clipboard.writeText(res.acceptUrl)}>Copy</Button></div></Field>
      <div className="flex justify-end"><Button onClick={close}>{t('close')}</Button></div>
    </div> : <form onSubmit={submit} className="space-y-4">
      <Field label={t('email')}><Input type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
      <Field label={t('role')}><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{role(r)}</option>)}</Select></Field>
      {f.role === 'doctor' && <div className="grid grid-cols-2 gap-3">
        <Field label={t('specialtyLabel')}><Select value={f.specialty} onChange={(e) => setF({ ...f, specialty: e.target.value })}>{specialties?.map((s) => <option key={s.code} value={s.code}>{s.names?.[lang] ?? s.name}</option>)}</Select></Field>
        <Field label={t('consultationFee')}><Input type="number" min={0} value={f.consultationFee} onChange={(e) => setF({ ...f, consultationFee: e.target.value })} /></Field></div>}
      {org.departments.length > 0 && f.role === 'doctor' && <Field label={t('departments')}><Select value={f.departmentId} onChange={(e) => setF({ ...f, departmentId: e.target.value })}><option value="">—</option>{org.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</Select></Field>}
      {['assistant', 'receptionist'].includes(f.role) && doctors.length > 0 && <Field label={t('assignTo')}><Select value={f.assignTo} onChange={(e) => setF({ ...f, assignTo: e.target.value })}><option value="">—</option>{doctors.map((d) => <option key={d.id} value={d.id}>{d.full_name}</option>)}</Select></Field>}
      <ErrorNote error={err} />
      <div className="flex justify-end"><Button busy={busy}>{t('invite')}</Button></div>
    </form>}
  </Dialog>;
}

function PermissionsDialog({ m, onClose }: { m: Member; onClose: () => void }) {
  const { t, role } = useI18n(); const { org } = useWorkspace();
  const [perms, setPerms] = useState<Set<string>>(new Set(m.permissions ?? [])); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const mine = new Set(org.me.permissions);
  const save = async () => { setBusy(true); setErr(null); try { await put(`/staff/${m.id}/permissions`, { permissions: [...perms] }); onClose(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  return <Dialog open onClose={onClose} title={`${t('permissions')} · ${m.full_name}`} wide>
    <p className="mb-4 text-sm text-muted">{role(m.role_code)}. Each switch applies immediately after saving and is recorded in the audit log. You can only grant permissions you hold yourself.</p>
    <ul className="divide-y divide-line">{PERMISSION_CODES.map((p) => {
      const grantable = isGrantable(m.role_code, p); const held = mine.has(p);
      return <li key={p} className="flex items-center justify-between gap-4 py-2">
        <div><p className="text-sm font-medium">{PERMISSIONS[p]}</p><p className="text-xs text-muted">{p}{!grantable ? ' · doctors only' : !held && !perms.has(p) ? ' · you do not hold this' : ''}</p></div>
        <Switch label={p} checked={perms.has(p)} disabled={!grantable || (!held && !perms.has(p))} onChange={(v) => { const n = new Set(perms); v ? n.add(p) : n.delete(p); setPerms(n); }} />
      </li>;
    })}</ul>
    <div className="mt-4"><ErrorNote error={err} /></div>
    <div className="mt-4 flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>{t('cancel')}</Button><Button busy={busy} onClick={save}>{t('save')}</Button></div>
  </Dialog>;
}
