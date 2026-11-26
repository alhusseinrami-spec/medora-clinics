'use client';
import { use, useEffect, useState } from 'react';
import { Logo } from '@/components/ui';
import { get, setActiveOrg } from '@/lib/api';
import { translator, useI18n, type Lang } from '@/lib/i18n';

/**
 * Printable prescription (A5-friendly). "Save as PDF" in the browser's print dialog produces the PDF.
 * Draft and cancelled prescriptions are watermarked so they cannot be passed off as valid.
 */
export default function PrintPrescription({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ org?: string; lang?: string }> }) {
  const { id } = use(params); const { org, lang: forced } = use(searchParams);
  // ?lang=fr prints the prescription in another language than the user's own (EN, FR or AR).
  const own = useI18n(); const { t, lang, dir } = forced && ['en', 'fr', 'ar'].includes(forced) ? translator(forced as Lang) : own;
  const [rx, setRx] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => { setActiveOrg(org ?? null); get(`/prescriptions/${id}`).then(setRx).catch((e) => setErr(e.message)); }, [id, org]);
  useEffect(() => { if (rx?.status === 'issued') setTimeout(() => window.print(), 300); }, [rx]);
  if (err) return <p className="p-8 text-danger">{err}</p>;
  if (!rx) return <p className="p-8 text-muted">{t('loading')}</p>;
  const d = (iso: string) => new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-LB' : lang, { day: 'numeric', month: 'long', year: 'numeric' });
  const age = rx.date_of_birth ? Math.floor((Date.now() - Date.parse(rx.date_of_birth)) / (365.25 * 86400e3)) : null;
  const invalid = rx.status !== 'issued';
  return <div dir={dir} className="mx-auto min-h-screen max-w-[148mm] bg-white p-8 text-[13px] text-black print:p-0">
    <style>{`@page { size: A5; margin: 12mm } @media print { .no-print { display: none } body { background: white } }`}</style>
    <div className="no-print mb-6 flex justify-end gap-2">
      <button onClick={() => window.print()} className="rounded-[10px] bg-[#115D62] px-4 py-2 text-sm font-medium text-white">{t('print')}</button>
    </div>
    <header className="flex items-start justify-between border-b-2 border-[#115D62] pb-3">
      <div><p className="text-lg font-semibold">{rx.doctor_name}</p><p className="capitalize">{rx.specialty_code?.replace(/_/g, ' ')}</p>
        {rx.license_number && <p>{t('orderRegNo')}: {rx.license_number}</p>}{rx.nssf_provider_number && <p>{t('nssfProviderNo')}: {rx.nssf_provider_number}</p>}</div>
      <div className="text-end"><p className="font-semibold">{rx.organization_name}</p>{rx.organization_address && <p>{rx.organization_address}</p>}{rx.organization_phone && <p>{rx.organization_phone}</p>}</div>
    </header>
    <section className="mt-4 flex justify-between">
      <p><span className="text-neutral-500">{t('patient')}:</span> <b>{rx.patient_name}</b>{age !== null && <> · {age} y</>}{rx.sex && <> · {t(rx.sex)}</>} · {rx.patient_number}</p>
      <p>{d(rx.issued_at ?? rx.created_at)}</p>
    </section>
    {rx.allergies && <p className="mt-2"><span className="text-neutral-500">{t('allergyWarning')}:</span> {rx.allergies}</p>}
    <p className="mt-6 text-2xl font-semibold text-[#115D62]">℞</p>
    <ol className="mt-2 space-y-3">{rx.items.map((i: any, n: number) => <li key={i.id} className="flex gap-3"><span className="font-semibold">{n + 1}.</span><div>
      <p className="font-semibold">{i.medication_name}</p>
      <p>{[i.dosage, i.frequency, i.duration].filter(Boolean).join(' · ')}</p>
      {i.instructions && <p className="text-neutral-600">{i.instructions}</p>}</div></li>)}</ol>
    {rx.notes && <p className="mt-6 whitespace-pre-wrap">{rx.notes}</p>}
    {invalid && <p className="mt-8 rotate-[-8deg] text-center text-4xl font-bold uppercase text-red-600/40">{rx.status === 'draft' ? t('draft') : t('cancelledRx')}</p>}
    <footer className="mt-16 flex items-end justify-between border-t border-neutral-300 pt-3 text-[11px] text-neutral-500">
      <div><Logo size={18} /><p className="mt-1">{t('rxLegal')}</p><p className="font-mono">{rx.id.slice(0, 8).toUpperCase()}</p></div>
      <div className="w-40 border-t border-neutral-400 pt-1 text-center">{rx.doctor_name}</div>
    </footer>
  </div>;
}
