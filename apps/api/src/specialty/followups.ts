// Dashboard follow-up lists for the specialty packs, computed from patient specialty profiles with the shared clinical logic.
import { addDays, diabetesRecalls, latestRow, nextPapSmear, pregnancyTimeline } from '@medora/shared';
import type { Tx } from '../db/db.service.js';

type Row = { patient_id: string; full_name: string; specialty_code: string; data: Record<string, any> };
const LIMIT = 20;
const byDue = (a: { due: string }, b: { due: string }) => a.due.localeCompare(b.due);

/** Runs inside the caller's transaction, so RLS limits it to profiles the caller may read. `today` is the org's local date. */
export async function specialtyFollowups(t: Tx, orgId: string, today: string) {
  const rows: Row[] = await t.q(`SELECT sp.patient_id, p.full_name, sp.specialty_code, sp.data FROM patient_specialty_profiles sp JOIN patients p ON p.id=sp.patient_id
    WHERE sp.organization_id=$1 AND sp.specialty_code IN ('cardiology','endocrinology','obgyn') ORDER BY sp.updated_at DESC LIMIT 2000`, [orgId]);
  const now = new Date(`${today}T12:00:00Z`);
  const within = (d: string | null | undefined, from: number, to: number) => !!d && d >= addDays(today, from) && d <= addDays(today, to);
  const bp: any[] = [], inr: any[] = [], devices: any[] = [], diabetes: any[] = [], prenatal: any[] = [], pap: any[] = [];
  for (const r of rows) {
    const who = { patient_id: r.patient_id, full_name: r.full_name };
    const d = r.data ?? {};
    if (r.specialty_code === 'cardiology') {
      const reading = latestRow<any>(d.bp_log?.readings, 'systolic');
      if (reading && (reading.systolic >= 140 || (reading.diastolic ?? 0) >= 90)) bp.push({ ...who, systolic: reading.systolic, diastolic: reading.diastolic ?? null, due: reading.date });
      const check = latestRow<any>(d.anticoagulation?.inr_log, 'inr');
      if (check?.next_test && within(check.next_test, -30, 7)) inr.push({ ...who, inr: check.inr, due: check.next_test, overdue: check.next_test < today });
      for (const dev of Array.isArray(d.devices?.items) ? d.devices.items : []) {
        if (within(dev?.next_check, -30, 30)) devices.push({ ...who, type: dev.type, due: dev.next_check, overdue: dev.next_check < today });
      }
    } else if (r.specialty_code === 'endocrinology') {
      const items = diabetesRecalls(d, now).filter((x) => x.status !== 'ok');
      if (items.length) diabetes.push({ ...who, items: items.map((x) => x.label), due: items.map((x) => x.due).sort()[0], overdue: items.some((x) => x.status === 'overdue') });
    } else if (r.specialty_code === 'obgyn') {
      const tl = pregnancyTimeline(d.pregnancy, now);
      if (tl) {
        const open = tl.items.filter((i) => i.status === 'due' || i.status === 'overdue');
        if (open.length || tl.nextVisit <= addDays(today, 7)) {
          prenatal.push({ ...who, week: tl.week, items: open.map((i) => i.label), next_visit: tl.nextVisit, due: [tl.nextVisit, ...open.map((i) => i.dueTo)].sort()[0], overdue: open.some((i) => i.status === 'overdue') });
        }
      }
      const next = nextPapSmear(d.gynecology?.last_pap_smear);
      if (next && next <= addDays(today, 30)) pap.push({ ...who, due: next, overdue: next < today });
    }
  }
  return {
    bp_followups: bp.sort((a, b) => b.due.localeCompare(a.due)).slice(0, LIMIT),
    inr_due: inr.sort(byDue).slice(0, LIMIT),
    device_checks: devices.sort(byDue).slice(0, LIMIT),
    diabetes_recalls: diabetes.sort(byDue).slice(0, LIMIT),
    prenatal_followups: prenatal.sort(byDue).slice(0, LIMIT),
    pap_recalls: pap.sort(byDue).slice(0, LIMIT),
  };
}
