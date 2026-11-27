'use client';
import { use, useEffect, useState } from 'react';
import { CONSENT_PURPOSES } from '@medora/shared';
import { get, setActiveOrg } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/**
 * The paper the patient signs: every Law 81/2018 purpose with yes / no boxes, prefilled with the answers on file.
 * Once signed, the scan goes to the patient documents.
 */
export default function PrintConsentForm({ searchParams }: { searchParams: Promise<{ org?: string; patient?: string }> }) {
  const { org, patient } = use(searchParams);
  const { t, lang, dir } = useI18n();
  const [d, setD] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setActiveOrg(org ?? null);
    Promise.all([get('/org'), get(`/patients/${patient}`), get(`/patients/${patient}/data-consents`)])
      .then(([o, p, c]) => setD({ org: o.organization, p, c })).catch((e) => setErr(e.message));
  }, [org, patient]);
  if (err) return <p className="p-8 text-danger">{err}</p>;
  if (!d) return <p className="p-8 text-muted">{t('loading')}</p>;
  const date = (iso: string) => new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-LB' : lang, { day: 'numeric', month: 'long', year: 'numeric' });
  const box = (on: boolean) => <span className={`inline-flex size-4 items-center justify-center border border-black text-[11px] leading-none`}>{on ? '✓' : ''}</span>;
  return <div dir={dir} className="mx-auto min-h-screen max-w-[210mm] bg-white p-8 text-[12px] text-black print:p-0">
    <style>{`@page { size: A4; margin: 14mm } @media print { .no-print { display: none } body { background: white } }`}</style>
    <div className="no-print mb-6 flex justify-end"><button onClick={() => window.print()} className="rounded-[10px] bg-[#115D62] px-4 py-2 text-sm font-medium text-white">{t('printNow')}</button></div>
    <header className="flex items-end justify-between border-b-2 border-[#115D62] pb-3">
      <div><p className="text-lg font-semibold">{d.org.name}</p>{d.org.phone && <p>{d.org.phone}</p>}{d.org.address && <p>{d.org.address}</p>}</div>
      <p className="max-w-[55%] text-end text-lg font-semibold text-[#115D62]">{t('consentFormTitle')}</p>
    </header>
    <section className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1">
      <p><span className="text-neutral-500">{t('patient')}:</span> <b>{d.p.full_name}</b></p>
      <p><span className="text-neutral-500">{t('patientNumber')}:</span> {d.p.patient_number}</p>
      <p><span className="text-neutral-500">{t('dateOfBirth')}:</span> {d.p.date_of_birth ? date(d.p.date_of_birth) : '—'}</p>
      <p><span className="text-neutral-500">{t('civilRegistry')}:</span> {d.p.civil_registry ?? '—'}</p>
    </section>
    <p className="mt-4">{t('consentFormIntro')}</p>
    <table className="mt-3 w-full border-collapse">
      <tbody>{CONSENT_PURPOSES.map((purpose) => {
        const c = d.c.current.find((x: any) => x.purpose === purpose);
        return <tr key={purpose} className="border-b border-neutral-300 align-top">
          <td className="py-2 pe-3"><p className="font-semibold">{t(`consent_${purpose}`)}</p><p className="text-neutral-600">{t(`consentDesc_${purpose}`)}</p>
            {(purpose === 'family_proxy' || purpose === 'diaspora_payer') && <p className="mt-1">{t(purpose === 'diaspora_payer' ? 'payerName' : 'proxyName')}: {c?.granted && c.detail ? c.detail : '______________________________'}</p>}</td>
          <td className="w-20 whitespace-nowrap py-2">{box(c?.granted === true)} {t('granted')}</td>
          <td className="w-24 whitespace-nowrap py-2">{box(c?.granted === false)} {t('notGranted')}</td>
        </tr>;
      })}</tbody>
    </table>
    <div className="mt-10 grid grid-cols-2 gap-10">
      <div><p className="text-neutral-500">{t('patientOrGuardian')}</p><div className="mt-10 border-t border-black pt-1">{t('fullName')} · {t('signatureLabel')} · {t('date')}</div></div>
      <div><p className="text-neutral-500">{t('clinicWitness')}</p><div className="mt-10 border-t border-black pt-1">{t('fullName')} · {t('signatureLabel')} · {t('date')}</div></div>
    </div>
    <p className="mt-8 text-[10px] text-neutral-500">{new Date().toLocaleString(lang === 'ar' ? 'ar-LB' : lang)} · MEDORA</p>
  </div>;
}
