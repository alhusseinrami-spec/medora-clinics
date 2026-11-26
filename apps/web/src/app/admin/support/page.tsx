'use client';
import { useCallback, useEffect, useState } from 'react';
import { Badge, Card, Empty, ErrorNote, Tabs, cx, fmtDate } from '@/components/ui';
import { SupportThread } from '@/components/Support';
import { get } from '@/lib/api';

export default function AdminSupport() {
  const [status, setStatus] = useState('open'); const [rows, setRows] = useState<any[] | null>(null); const [sel, setSel] = useState<string | null>(null); const [err, setErr] = useState<unknown>(null);
  const load = useCallback(() => get<any[]>(`/admin/support${status === 'all' ? '' : `?status=${status}`}`, null).then(setRows).catch(setErr), [status]);
  useEffect(() => { load(); }, [load]);
  return (
    <>
      <h1 className="mb-4 font-[family-name:var(--font-display)] text-2xl font-semibold">Support requests</h1>
      <ErrorNote error={err} />
      <div className="grid gap-6 lg:grid-cols-[1fr_1.4fr]">
        <Card>
          <Tabs tabs={[{ key: 'open', label: 'Open' }, { key: 'answered', label: 'Answered' }, { key: 'closed', label: 'Closed' }, { key: 'all', label: 'All' }]} value={status} onChange={setStatus} />
          {!rows ? null : rows.length === 0 ? <div className="mt-4"><Empty>Nothing here.</Empty></div> : <ul className="mt-2 divide-y divide-line">{rows.map((r) => (
            <li key={r.id}><button onClick={() => setSel(r.id)} className={cx('w-full py-2.5 text-start text-sm', sel === r.id && 'text-brand')}>
              <span className="flex justify-between gap-2"><span className="font-medium">{r.subject}</span><Badge status={r.status}>{r.status}</Badge></span>
              <span className="block text-xs text-muted">{r.user_name} · {r.organization_name ?? 'no workspace'} · {r.category} · {fmtDate(r.updated_at)}</span></button></li>))}</ul>}
        </Card>
        <div>{sel ? <SupportThread id={sel} staff onChange={load} /> : <p className="text-sm text-muted">Choose a request.</p>}</div>
      </div>
    </>
  );
}
