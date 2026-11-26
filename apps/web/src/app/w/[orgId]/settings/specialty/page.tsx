'use client';
import { useEffect, useState } from 'react';
import { label as L } from '@medora/shared';
import { Badge, Button, Card, ErrorNote, Field, Input, Select } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { SpecialtyForm } from '@/components/SpecialtyForm';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';

export default function SpecialtySettings() {
  const { t, lang } = useI18n(); const { can, org, feature, orgId } = useWorkspace();
  const [ws, setWs] = useState<any>(null); const [hist, setHist] = useState<any[]>([]); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState(false);
  const [nf, setNf] = useState({ section: '', key: '', label: '', type: 'text', options: '' });
  const load = () => { get('/specialty/workspace').then((w) => { setWs(w); setNf((f) => ({ ...f, section: f.section || w.profile.schema.sections[0]?.key })); }).catch(setErr); get('/specialty/history').then(setHist).catch(() => {}); };
  useEffect(load, []);
  if (!can('template.manage') || !org.me.doctorMembershipId) return <Forbidden />;
  if (!ws) return <ErrorNote error={err} />;
  const apply = async (customization: any) => { setBusy(true); setErr(null); try { await post('/specialty/customize', { customization }); load(); } catch (e) { setErr(e); } finally { setBusy(false); } };
  const addField = (e: React.FormEvent) => {
    e.preventDefault();
    const field: any = { key: nf.key, type: nf.type, label: nf.label };
    if (nf.type === 'select') field.options = nf.options.split(',').map((s) => s.trim()).filter(Boolean).map((o) => ({ value: o.toLowerCase().replace(/[^a-z0-9]+/g, '_'), label: o }));
    apply({ addFields: [{ section: nf.section, field }] }).then(() => setNf({ ...nf, key: '', label: '', options: '' }));
  };
  const schema = ws.profile.schema;
  return (
    <>
      <PageTitle title={t('specialty')} sub={<>{ws.specialty.names?.[lang] ?? ws.specialty.name} · {t('version')} {ws.profile.version} <Badge>{ws.profile.isCustom ? 'custom' : 'preset'}</Badge></>} />
      <p className="mb-4 rounded-[10px] bg-info/10 p-3 text-sm text-info">{t('presetNote')}</p>
      <ErrorNote error={err} />
      {!feature('specialty_templates') ? <p className="rounded-[10px] border border-line bg-card p-4 text-sm">{t('featureNotInPlan')} {can('org.manage') && <a className="font-medium text-brand hover:underline" href={`/w/${orgId}/settings/subscription`}>{t('subscription')} →</a>}</p> :
      <div className="grid gap-6 lg:grid-cols-[1fr_1.3fr]">
        <div className="space-y-6">
          <Card title={t('customField')}>
            <form onSubmit={addField} className="grid gap-3">
              <Field label={t('section')}><Select value={nf.section} onChange={(e) => setNf({ ...nf, section: e.target.value })}>{schema.sections.map((s: any) => <option key={s.key} value={s.key}>{L(s.label, lang)}</option>)}</Select></Field>
              <Field label={t('fieldLabel')}><Input required value={nf.label} onChange={(e) => setNf({ ...nf, label: e.target.value, key: nf.key || '' })} /></Field>
              <Field label={t('fieldKey')} hint="lower_snake_case, e.g. iron_supplement"><Input required pattern="[a-z][a-z0-9_]*" value={nf.key} onChange={(e) => setNf({ ...nf, key: e.target.value })} /></Field>
              <Field label={t('fieldType')}><Select value={nf.type} onChange={(e) => setNf({ ...nf, type: e.target.value })}>{['text', 'textarea', 'number', 'date', 'boolean', 'select'].map((x) => <option key={x}>{x}</option>)}</Select></Field>
              {nf.type === 'select' && <Field label="Options" hint="comma separated"><Input required value={nf.options} onChange={(e) => setNf({ ...nf, options: e.target.value })} /></Field>}
              <Button busy={busy}>{t('add')}</Button>
            </form>
          </Card>
          <Card title="Fields">
            <ul className="space-y-3 text-sm">{schema.sections.map((s: any) => <li key={s.key}><p className="font-medium">{L(s.label, lang)}</p>
              <ul className="mt-1 space-y-1">{s.fields.map((f: any) => <li key={f.key} className="flex items-center justify-between gap-2 ps-3">
                <span className={f.hidden ? 'text-muted line-through' : ''}>{L(f.label, lang)} {f.custom && <Badge>custom</Badge>}</span>
                {f.required && !f.custom ? <span className="text-xs text-muted">required</span> :
                  <button className="text-xs text-brand" disabled={busy} onClick={() => apply(f.hidden ? { showFields: [{ section: s.key, key: f.key }] } : { hideFields: [{ section: s.key, key: f.key }] })}>{f.hidden ? t('show') : t('hide')}</button>}
              </li>)}</ul></li>)}</ul>
          </Card>
          {hist.length > 0 && <Card title={t('version')}><ul className="text-sm">{hist.map((h) => <li key={h.version_id}>v{h.version} · {new Date(h.published_at).toLocaleString()}</li>)}</ul></Card>}
        </div>
        <Card title="Preview"><SpecialtyForm key={ws.profile.versionId} schema={schema} initial={{}} readOnly /></Card>
      </div>}
    </>
  );
}
