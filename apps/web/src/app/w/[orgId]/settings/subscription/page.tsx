'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge, Button, Card, ErrorNote, Tabs, cx, fmtDate, fmtMoney } from '@/components/ui';
import { Forbidden, PageTitle } from '@/components/Shell';
import { get, post } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';

export default function Subscription() {
  const { t, lang } = useI18n(); const { can, orgId, reload } = useWorkspace();
  const [d, setD] = useState<any>(null); const [err, setErr] = useState<unknown>(null); const [busy, setBusy] = useState<string | null>(null);
  const [cycle, setCycle] = useState<'monthly' | 'yearly'>('monthly');
  useEffect(() => { if (can('org.manage')) get('/subscription').then((x) => { setD(x); setCycle(x.subscription.billing_cycle); }).catch(setErr); }, [can]);
  if (!can('org.manage')) return <Forbidden />;
  if (!d) return <ErrorNote error={err} />;
  const s = d.subscription; const u = d.usage;
  const act = async (key: string, fn: () => Promise<any>) => { setBusy(key); setErr(null); try { setD(await fn()); await reload(); } catch (x) { setErr(x); } finally { setBusy(null); } };
  const daysLeft = s.status === 'trial' ? Math.max(0, Math.ceil((Date.parse(s.trial_ends_at) - Date.now()) / 86400e3)) : null;
  const price = (p: any, c: string) => (c === 'yearly' ? p.yearly_price : p.monthly_price);
  const limits: [string, number, number | null][] = [['u_doctors', u.doctors, s.max_doctors], ['u_assistants', u.assistants, s.max_assistants], ['u_locations', u.locations, s.max_locations], ['u_patients', u.patients, s.max_patients]];
  return (
    <>
      <PageTitle title={t('subscription')} />
      <ErrorNote error={err} />
      <div className="mt-2 grid gap-6 lg:grid-cols-[1.1fr_1fr]">
        <Card title={t('currentPlan')}>
          <div className="flex flex-wrap items-center gap-3">
            <p className="font-[family-name:var(--font-display)] text-2xl font-semibold">{s.plan_name}</p>
            <Badge status={s.effective_status}>{t(`s_${s.effective_status}`)}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">
            {s.price != null ? `${fmtMoney(s.price, s.currency, lang)} ${s.billing_cycle === 'yearly' ? t('perYear') : t('perMonth')}` : t('onRequest')}
          </p>
          <dl className="mt-4 space-y-1 text-sm">
            {s.status === 'trial' && <div><dt className="inline text-muted">{t('trialEnds')}: </dt><dd className="inline font-medium">{fmtDate(s.trial_ends_at, lang)} · {daysLeft} {t('daysLeft')}</dd></div>}
            {s.current_period_end && <div><dt className="inline text-muted">{s.cancel_at_period_end ? t('cancelsOn') : t('renewsOn')}: </dt><dd className="inline font-medium">{fmtDate(s.current_period_end, lang)}</dd></div>}
          </dl>
          {s.cancel_at_period_end && <p className="mt-2 text-sm text-warning">{t('cancelScheduled')}</p>}
          <ul className="mt-4 grid gap-1 text-sm">{Object.entries(s.features ?? {}).map(([k, on]) => <li key={k} className={on ? '' : 'text-muted line-through'}>{on ? '✓' : '–'} {t(`f_${k}`)}</li>)}</ul>
          <p className="mt-4 rounded-[10px] bg-info/10 p-3 text-xs text-info">{t('paymentHow')} <Link href={`/w/${orgId}/support`} className="font-medium underline">{t('support')}</Link></p>
          {!['cancelled', 'suspended'].includes(s.status) && <div className="mt-4">
            {s.cancel_at_period_end
              ? <Button variant="secondary" busy={busy === 'resume'} onClick={() => act('resume', () => post('/subscription/cancel', { cancel: false }))}>{t('resumeSub')}</Button>
              : <Button variant="ghost" className="text-danger" busy={busy === 'cancel'} onClick={() => confirm(t('cancelConfirm')) && act('cancel', () => post('/subscription/cancel', { cancel: true }))}>{t('cancelSub')}</Button>}
          </div>}
        </Card>
        <Card title={t('usage')}>
          <ul className="space-y-3 text-sm">{limits.map(([k, used, max]) => <li key={k}>
            <div className="flex justify-between"><span>{t(k)}</span><span className="tabular text-muted">{used} / {max ?? t('unlimited')}</span></div>
            {max != null && <div className="mt-1 h-1.5 rounded-full bg-line"><div className={cx('h-1.5 rounded-full', used >= max ? 'bg-warning' : 'bg-brand')} style={{ width: `${Math.min(100, (used / max) * 100)}%` }} /></div>}
          </li>)}
            <li className="flex justify-between border-t border-line pt-3"><span>{t('u_appointments_30d')}</span><span className="tabular text-muted">{u.appointments_30d}</span></li>
            <li className="flex justify-between"><span>{t('u_messages_30d')}</span><span className="tabular text-muted">{u.messages_30d}</span></li>
          </ul>
        </Card>
      </div>

      <div className="mt-8 flex flex-wrap items-end justify-between gap-3">
        <h2 className="font-[family-name:var(--font-display)] text-lg font-semibold">{t('comparePlans')}</h2>
        <div className="w-56"><Tabs tabs={[{ key: 'monthly', label: t('monthly') }, { key: 'yearly', label: t('yearly') }]} value={cycle} onChange={(k) => setCycle(k as any)} /></div>
      </div>
      <p className="mt-1 text-xs text-muted">{t('planChangeNote')}</p>
      <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">{d.plans.map((p: any) => {
        const current = p.code === s.plan_code; const sameCycle = cycle === s.billing_cycle;
        return (
          <div key={p.code} className={cx('flex flex-col rounded-[14px] border bg-card p-5', current ? 'border-brand ring-1 ring-brand' : 'border-line')}>
            <p className="font-semibold">{p.name}</p>
            <p className="mt-1 text-2xl font-semibold">{price(p, cycle) != null ? fmtMoney(price(p, cycle), p.currency, lang) : t('onRequest')}{price(p, cycle) != null && <span className="text-sm font-normal text-muted"> {cycle === 'yearly' ? t('perYear') : t('perMonth')}</span>}</p>
            <p className="mt-2 text-sm text-muted">{p.description}</p>
            <ul className="mt-3 space-y-1 text-sm">
              <li>{p.max_doctors ?? '∞'} {t('limitDoctors')} · {p.max_assistants ?? '∞'} {t('limitStaff')} · {p.max_locations ?? '∞'} {t('limitLocations')}</li>
              {Object.entries(p.features).filter(([, on]) => on).map(([k]) => <li key={k} className="text-muted">✓ {t(`f_${k}`)}</li>)}
            </ul>
            <div className="mt-auto pt-4">
              {p.monthly_price == null ? <Link href={`/w/${orgId}/support`}><Button variant="secondary" className="w-full">{t('support')}</Button></Link>
                : current && sameCycle ? <Button variant="secondary" className="w-full" disabled>{t('thisPlan')}</Button>
                : <Button className="w-full" variant={current ? 'secondary' : 'primary'} busy={busy === p.code} disabled={['cancelled', 'suspended'].includes(s.status)}
                    onClick={() => act(p.code, () => post('/subscription/plan', { plan: p.code, cycle }))}>{current ? t('switchCycle') : t('choosePlan')}</Button>}
            </div>
          </div>
        );
      })}</div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card title={t('payments')}>
          {d.payments.length === 0 ? <p className="text-sm text-muted">{t('none')}</p> : <table className="w-full text-sm"><tbody className="divide-y divide-line">{d.payments.map((p: any) => (
            <tr key={p.id}><td className="py-2">{fmtDate(p.created_at, lang)}</td><td>{fmtMoney(p.amount, p.currency, lang)}</td><td className="text-muted">{fmtDate(p.period_start, lang)} – {fmtDate(p.period_end, lang)}</td><td><Badge status={p.status}>{p.status}</Badge></td></tr>))}</tbody></table>}
        </Card>
        <Card title={t('history')}>
          <ul className="space-y-1.5 text-sm">{d.events.map((e: any, i: number) => <li key={i} className="flex justify-between gap-3"><span>{t(`ev_${e.kind}`)}{e.to_plan && e.from_plan !== e.to_plan ? ` · ${e.to_plan}` : ''}</span><span className="text-muted">{fmtDate(e.created_at, lang)}</span></li>)}</ul>
        </Card>
      </div>
    </>
  );
}
