'use client';
import { useState } from 'react';
import { PushToggle } from '@/components/Pwa';
import { Button, Card, ErrorNote, Field, Input, Select, Switch } from '@/components/ui';
import { patch, post } from '@/lib/api';
import { useI18n, type Lang } from '@/lib/i18n';
import { usePortal, type PortalRecord } from '@/lib/portal';

export default function PortalProfile() {
  const { t, lang, setLang } = useI18n(); const { me, records } = usePortal();
  const [err, setErr] = useState<unknown>(null);
  const changeAppLang = async (l: Lang) => { setLang(l); try { await patch('/auth/me', { interfaceLanguage: l }); } catch (x) { setErr(x); } };
  return (
    <div className="space-y-4">
      <h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">{t('pProfile')}</h1>
      <Card title={me.user.full_name}>
        <p className="text-sm text-muted">{me.user.email}</p>
        <Field label={t('pAppLanguage')} className="mt-3 max-w-xs"><Select value={lang} onChange={(e) => changeAppLang(e.target.value as Lang)}>
          <option value="en">English</option><option value="fr">Français</option><option value="ar">العربية</option></Select></Field>
        <ErrorNote error={err} />
      </Card>
      <Card title={t('pPhoneNotifications')}><PushToggle /></Card>
      {records.map((r) => <RecordCard key={r.patient_id} r={r} multi={records.length > 1} />)}
    </div>
  );
}

function RecordCard({ r, multi }: { r: PortalRecord; multi: boolean }) {
  const { t } = useI18n(); const { setRecords } = usePortal();
  const [f, setF] = useState({ phone: r.phone ?? '', whatsappNumber: r.whatsapp_number ?? '', email: r.email ?? '', address: r.address ?? '', preferredLanguage: r.preferred_language ?? 'en' });
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<unknown>(null); const [ok, setOk] = useState(false);
  const send = async (extra: Record<string, unknown> = {}) => {
    setBusy(true); setErr(null); setOk(false);
    try {
      const res = await post('/portal/profile', { patientId: r.patient_id, phone: f.phone.trim() || null, whatsappNumber: f.whatsappNumber.trim() || null,
        email: f.email.trim() || null, address: f.address.trim() || null, preferredLanguage: f.preferredLanguage, ...extra });
      setRecords(res.records); setOk(true);
    } catch (x) { setErr(x); } finally { setBusy(false); }
  };
  return (
    <Card title={multi ? `${t('pContact')} · ${r.clinic}` : t('pContact')}>
      <form onSubmit={(e) => { e.preventDefault(); send(); }} className="grid gap-3 sm:grid-cols-2">
        <Field label={t('phone')}><Input type="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
        <Field label={t('whatsapp')}><Input type="tel" value={f.whatsappNumber} onChange={(e) => setF({ ...f, whatsappNumber: e.target.value })} /></Field>
        <Field label={t('email')}><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
        <Field label={t('pClinicLanguage')}><Select value={f.preferredLanguage} onChange={(e) => setF({ ...f, preferredLanguage: e.target.value })}>
          <option value="en">English</option><option value="fr">Français</option><option value="ar">العربية</option></Select></Field>
        <Field label={t('address')} className="sm:col-span-2"><Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} /></Field>
        <div className="sm:col-span-2"><ErrorNote error={err} />{ok && <p className="mb-2 text-sm font-medium text-brand">{t('saved')}</p>}<Button busy={busy}>{t('save')}</Button></div>
      </form>
      <div className="mt-5 flex items-start justify-between gap-4 border-t border-line pt-4">
        <div><p className="text-sm font-medium">{t('consentLabel')}</p><p className="text-xs text-muted">{t('pConsentHint')}</p></div>
        <Switch checked={!!r.whatsapp_consent} disabled={busy} label={t('consentLabel')} onChange={(v) => send({ whatsappConsent: v })} />
      </div>
    </Card>
  );
}
