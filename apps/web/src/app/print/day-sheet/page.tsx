'use client';
import { use, useEffect, useState } from 'react';
import { get, setActiveOrg } from '@/lib/api';
import { useI18n } from '@/lib/i18n';

/**
 * The printed day sheet: one day's appointments per doctor, for the front desk to work from during an outage.
 * Phone numbers appear only when the clinic owner switched that on.
 */
export default function PrintDaySheet({ searchParams }: { searchParams: Promise<{ org?: string; date?: string; doctor?: string }> }) {
  const { org, date, doctor } = use(searchParams);
  const { t, lang, dir, status } = useI18n();
  const [s, setS] = useState<any>(null); const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setActiveOrg(org ?? null);
    get(`/day-sheet?date=${date}${doctor ? `&doctor=${doctor}` : ''}`).then(setS).catch((e) => setErr(e.message));
  }, [org, date, doctor]);
  if (err) return <p className="p-8 text-danger">{err}</p>;
  if (!s) return <p className="p-8 text-muted">{t('loading')}</p>;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(lang === 'ar' ? 'ar-LB' : lang, { hour: '2-digit', minute: '2-digit', timeZone: s.timezone });
  const day = new Date(`${s.date}T12:00:00Z`).toLocaleDateString(lang === 'ar' ? 'ar-LB' : lang, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const byDoctor = s.appointments.reduce((m: Record<string, any[]>, a: any) => ((m[a.doctor_name] ??= []).push(a), m), {});
  return <div dir={dir} className="mx-auto min-h-screen max-w-[210mm] bg-white p-8 text-[12px] text-black print:p-0">
    <style>{`@page { size: A4; margin: 12mm } @media print { .no-print { display: none } body { background: white } }`}</style>
    <div className="no-print mb-6 flex justify-end"><button onClick={() => window.print()} className="rounded-[10px] bg-[#115D62] px-4 py-2 text-sm font-medium text-white">{t('print')}</button></div>
    <header className="flex items-end justify-between border-b-2 border-[#115D62] pb-3">
      <div><p className="text-lg font-semibold">{s.organization.name}</p>{s.organization.phone && <p>{s.organization.phone}</p>}</div>
      <div className="text-end"><p className="text-xl font-semibold text-[#115D62]">{t('daySheet')}</p><p>{day}</p></div>
    </header>
    {s.appointments.length === 0 ? <p className="mt-6">—</p> : Object.entries(byDoctor).map(([doc, rows]) => <section key={doc} className="mt-5 break-inside-avoid">
      <h2 className="mb-1 text-sm font-semibold">{doc} <span className="font-normal text-neutral-500">· {(rows as any[]).length}</span></h2>
      <table className="w-full border-collapse">
        <thead><tr className="border-b border-neutral-400 text-start text-[11px] text-neutral-600">
          <th className="py-1 text-start">{t('time')}</th><th className="text-start">{t('patient')}</th><th className="text-start">№</th>
          {s.phones && <th className="text-start">{t('phone')}</th>}<th className="text-start">{t('service')}</th><th className="text-start">{t('status')}</th><th className="w-[28%] text-start">{t('signature')}</th></tr></thead>
        <tbody>{(rows as any[]).map((a) => <tr key={a.id} className="border-b border-neutral-200 align-top">
          <td className="py-1.5 tabular">{time(a.starts_at)}{a.overbook_reason ? ' ⚠' : ''}</td><td className="font-medium">{a.patient_name}</td><td className="tabular">{a.patient_number}</td>
          {s.phones && <td className="tabular">{a.patient_phone ?? ''}</td>}<td>{a.service_name ?? (a.is_walk_in ? t('walkIn') : '')}</td><td>{status(a.status)}</td><td /></tr>)}</tbody>
      </table>
    </section>)}
    <p className="mt-8 text-[10px] text-neutral-500">{new Date().toLocaleString(lang === 'ar' ? 'ar-LB' : lang)} · MEDORA</p>
  </div>;
}
