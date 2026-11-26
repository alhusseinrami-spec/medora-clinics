import { BadRequestException, Controller, Get, Module, Query } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { Ctx, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';

/**
 * Activity report for a period: appointments and their outcomes, new patients, visits, busiest services and most
 * frequent diagnoses, per doctor and per day. Days follow the clinic's time zone. Row-level security decides what
 * each caller counts: a doctor in a center sees their own figures, and diagnoses need clinical access.
 */
@Controller('reports')
export class ReportsController {
  constructor(private db: Db) {}

  @RequirePerm('report.view') @Get('activity')
  activity(@Ctx() c: TenantInfo, @Query() query: Record<string, string>) {
    const q = parse({ from: v.date(), to: v.date(), doctor: v.uuid().optional() }, query);
    if (q.to < q.from) throw new BadRequestException('The end date is before the start date');
    if ((Date.parse(q.to) - Date.parse(q.from)) / 86400e3 > 366) throw new BadRequestException('A report covers at most one year');
    return this.db.tx(c, async (t) => {
      const tz = (await t.one(`SELECT coalesce(timezone, 'Asia/Beirut') AS tz FROM organizations WHERE id=$1`, [c.orgId])).tz;
      const P = [c.orgId, q.from, q.to, tz, q.doctor ?? null];
      // Appointments in the period, by local day.
      const A = `FROM appointments a WHERE a.organization_id=$1 AND (a.starts_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
                 AND ($5::uuid IS NULL OR a.doctor_membership_id=$5)`;
      const counts = `count(*)::int AS booked,
          count(*) FILTER (WHERE a.status='completed')::int AS completed,
          count(*) FILTER (WHERE a.status='no_show')::int AS no_show,
          count(*) FILTER (WHERE a.status='cancelled')::int AS cancelled,
          count(*) FILTER (WHERE a.is_walk_in)::int AS walk_in,
          count(*) FILTER (WHERE a.overbook_reason IS NOT NULL)::int AS overbooked`;
      const totals = await t.one(`SELECT ${counts}, count(DISTINCT a.patient_id)::int AS patients_seen ${A}`, P);
      const newPatients = await t.one(`SELECT count(*)::int AS n FROM patients p WHERE p.organization_id=$1
          AND (p.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
          AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM appointments a WHERE a.patient_id=p.id AND a.doctor_membership_id=$5))`, P);
      const visits = await t.one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE c.status='signed')::int AS signed
        FROM consultations c WHERE c.organization_id=$1 AND (c.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date
          AND ($5::uuid IS NULL OR c.doctor_membership_id=$5)`, P);
      const byDoctor = await t.q(`SELECT a.doctor_membership_id AS membership_id, u.full_name AS doctor_name, ${counts}
        ${A.replace('FROM appointments a', 'FROM appointments a JOIN memberships m ON m.id=a.doctor_membership_id JOIN users u ON u.id=m.user_id')}
        GROUP BY 1, 2 ORDER BY booked DESC, doctor_name`, P);
      const byService = await t.q(`SELECT coalesce(s.name, CASE WHEN a.is_walk_in THEN 'walk_in' ELSE '—' END) AS service, count(*)::int AS booked,
          count(*) FILTER (WHERE a.status='completed')::int AS completed
        ${A.replace('FROM appointments a', 'FROM appointments a LEFT JOIN services s ON s.id=a.service_id')} AND a.status <> 'cancelled'
        GROUP BY 1 ORDER BY booked DESC LIMIT 15`, P);
      const byDay = await t.q(`SELECT to_char((a.starts_at AT TIME ZONE $4)::date, 'YYYY-MM-DD') AS day, ${counts} ${A} GROUP BY 1 ORDER BY 1`, P);
      const diagnoses = await t.q(`SELECT d.description, max(d.code) AS code, count(*)::int AS n FROM diagnoses d JOIN consultations c ON c.id=d.consultation_id
        WHERE c.organization_id=$1 AND (c.created_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date AND ($5::uuid IS NULL OR c.doctor_membership_id=$5)
        GROUP BY lower(d.description), d.description ORDER BY n DESC, d.description LIMIT 15`, P);
      const pct = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : 0);
      const attended = totals.booked - totals.cancelled;
      await audit(t, c.userId, c.orgId, 'report.view', 'organization', c.orgId);
      return {
        period: { from: q.from, to: q.to }, timezone: tz, scope: c.orgWide ? 'workspace' : 'own',
        totals: { ...totals, new_patients: newPatients.n, visits: visits.total, visits_signed: visits.signed,
          no_show_rate: pct(totals.no_show, attended), completion_rate: pct(totals.completed, attended) },
        byDoctor, byService, byDay, diagnoses,
      };
    });
  }
}

@Module({ controllers: [ReportsController] })
export class ReportsModule {}
