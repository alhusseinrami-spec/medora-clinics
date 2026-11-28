import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Module, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { APPOINTMENT_STATUSES, RESCHEDULABLE, canTransition, expandRecurrence, type AppointmentStatus } from '@medora/shared';
import { Db, Tx } from '../db/db.service.js';
import { Auth, Ctx, RequireAnyPerm, RequirePerm, Tenant } from '../common/decorators.js';
import type { AuthInfo, TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { queueAppointmentEvent } from '../comm/events.js';
import { specialtyFollowups } from '../specialty/followups.js';

const id = (x: string) => parse({ id: v.uuid() }, { id: x }).id;
const DAY = 86400000;

function assertActsFor(c: TenantInfo, doctor: string) {
  if (!c.orgWide && !c.actingDoctors.includes(doctor)) throw new ForbiddenException('You do not manage this doctor\'s calendar');
}

const APPT_SELECT = `SELECT a.id, a.patient_id, p.full_name AS patient_name, p.patient_number, p.phone AS patient_phone,
    a.doctor_membership_id, du.full_name AS doctor_name, a.starts_at, a.ends_at, a.status, a.is_walk_in, a.notes,
    a.service_id, s.name AS service_name, a.room_id, r.name AS room_name, a.location_id, a.department_id,
    a.recurrence_rule, a.arrived_at, a.called_at, a.completed_at, a.cancelled_reason, a.created_at, a.overbook_reason,
    a.fee_amount, a.fee_currency, a.fee_note, a.fee_set_at,
    coalesce(s.price, dm.consultation_fee) AS fee_suggested, CASE WHEN s.id IS NOT NULL THEN s.currency ELSE 'USD' END AS fee_suggested_currency
  FROM appointments a JOIN patients p ON p.id=a.patient_id
  JOIN memberships dm ON dm.id=a.doctor_membership_id JOIN users du ON du.id=dm.user_id
  LEFT JOIN services s ON s.id=a.service_id LEFT JOIN rooms r ON r.id=a.room_id`;

@Controller()
export class SchedulingController {
  constructor(private db: Db) {}

  // ---------- Services ----------
  @Tenant() @Get('services')
  services(@Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT id, membership_id, name, default_minutes, price, currency FROM services WHERE organization_id=$1 ORDER BY name`, [c.orgId]));
  }

  @RequirePerm('appointment.manage') @Post('services')
  addService(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 120), defaultMinutes: v.int(5, 480), price: v.num(0, 1e9), currency: v.enum('USD', 'LBP').optional(), doctorMembershipId: v.uuid().nullable() }, body);
    return this.db.tx(c, async (t) => {
      const r = await t.one(`INSERT INTO services(organization_id,membership_id,name,default_minutes,price,currency) VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, membership_id, name, default_minutes, price, currency`, [c.orgId, b.doctorMembershipId ?? null, b.name, b.defaultMinutes, b.price, b.currency ?? 'USD']);
      await audit(t, c.userId, c.orgId, 'service.create', 'service', r.id);
      return r;
    });
  }

  @RequirePerm('appointment.manage') @Patch('services/:id')
  async updateService(@Param('id') sid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 120).optional(), defaultMinutes: v.int(5, 480).optional(), price: v.num(0, 1e9).optional(), currency: v.enum('USD', 'LBP').optional() }, body);
    const r = await this.db.tx(c, (t) => t.one(`UPDATE services SET name=COALESCE($2,name), default_minutes=COALESCE($3,default_minutes), price=COALESCE($4,price), currency=COALESCE($5,currency)
      WHERE id=$1 RETURNING id, membership_id, name, default_minutes, price, currency`, [id(sid), b.name ?? null, b.defaultMinutes ?? null, b.price ?? null, b.currency ?? null]));
    if (!r) throw new NotFoundException('Service not found or not yours to change');
    return r;
  }

  // ---------- Availability ----------
  @Tenant() @Get('availability')
  availability(@Ctx() c: TenantInfo, @Query('doctor') doctor: string) {
    const d = id(doctor);
    return this.db.tx(c, async (t) => ({
      workingHours: await t.q(`SELECT id, weekday, to_char(starts,'HH24:MI') AS starts, to_char(ends,'HH24:MI') AS ends, location_id FROM working_hours WHERE membership_id=$1 ORDER BY weekday, starts`, [d]),
      exceptions: await t.q(`SELECT id, kind, lower(during) AS starts_at, upper(during) AS ends_at FROM availability_exceptions WHERE membership_id=$1 AND upper(during) > now() ORDER BY lower(during)`, [d]),
    }));
  }

  @RequirePerm('appointment.manage') @Put('availability/working-hours')
  setHours(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ doctorMembershipId: v.uuid(), hours: v.array(v.object({ weekday: v.int(0, 6), starts: v.time(), ends: v.time(), locationId: v.uuid().optional() }), 50) }, body);
    assertActsFor(c, b.doctorMembershipId);
    for (const h of b.hours) if (h.ends <= h.starts) throw new BadRequestException('Each working period must end after it starts');
    return this.db.tx(c, async (t) => {
      await t.q(`DELETE FROM working_hours WHERE membership_id=$1`, [b.doctorMembershipId]);
      for (const h of b.hours) await t.q(`INSERT INTO working_hours(membership_id,weekday,starts,ends,location_id) VALUES ($1,$2,$3,$4,$5)`, [b.doctorMembershipId, h.weekday, h.starts, h.ends, h.locationId ?? null]);
      await audit(t, c.userId, c.orgId, 'availability.hours', 'membership', b.doctorMembershipId, { periods: b.hours.length });
      return { ok: true, periods: b.hours.length };
    });
  }

  @RequireAnyPerm('appointment.manage', 'org.manage') @Post('availability/exceptions')
  addException(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ doctorMembershipId: v.uuid(), kind: v.enum('break', 'holiday', 'leave'), startsAt: v.datetime(), endsAt: v.datetime() }, body);
    assertActsFor(c, b.doctorMembershipId);
    if (b.endsAt <= b.startsAt) throw new BadRequestException('End must be after start');
    return this.db.tx(c, async (t) => { await this.assertMayEditAbsences(t, c); return t.one(`INSERT INTO availability_exceptions(membership_id,kind,during) VALUES ($1,$2,tstzrange($3,$4)) RETURNING id, kind, lower(during) AS starts_at, upper(during) AS ends_at`,
      [b.doctorMembershipId, b.kind, b.startsAt, b.endsAt]); });
  }

  /** With "doctors manage their own absences" off, only owners and admins (org.manage) add or remove absences. */
  private async assertMayEditAbsences(t: Tx, c: TenantInfo) {
    if (c.permissions.has('org.manage')) return;
    const o = await t.one(`SELECT doctors_manage_absences FROM organizations WHERE id=$1`, [c.orgId]);
    if (!o?.doctors_manage_absences) throw new ForbiddenException('Only the clinic owner or an admin can change absences in this workspace');
  }

  @RequireAnyPerm('appointment.manage', 'org.manage') @Delete('availability/exceptions/:id')
  async deleteException(@Param('id') eid: string, @Ctx() c: TenantInfo) {
    const r = await this.db.tx(c, async (t) => { await this.assertMayEditAbsences(t, c); return t.q(`DELETE FROM availability_exceptions WHERE id=$1 RETURNING id`, [id(eid)]); });
    if (!r.length) throw new NotFoundException();
    return { ok: true };
  }

  /** Free slots on a day: inside working hours (org time zone), outside breaks/holidays, not overlapping appointments, not in the past. */
  @RequirePerm('appointment.manage') @Get('availability/slots')
  slots(@Ctx() c: TenantInfo, @Query('doctor') doctor: string, @Query('date') date: string, @Query('minutes') minutes = '20') {
    const q = parse({ doctor: v.uuid(), date: v.date(), minutes: v.int(5, 480) }, { doctor, date, minutes });
    assertActsFor(c, q.doctor);
    return this.db.tx(c, (t) => t.q(`
      WITH o AS (SELECT timezone tz FROM organizations WHERE id=$4),
      wh AS (SELECT (($2::date + w.starts) AT TIME ZONE o.tz) s, (($2::date + w.ends) AT TIME ZONE o.tz) e
             FROM working_hours w, o WHERE w.membership_id=$1 AND w.weekday = extract(dow FROM $2::date)),
      sl AS (SELECT g AS s, g + make_interval(mins => $3) AS e FROM wh, generate_series(wh.s, wh.e - make_interval(mins => $3), make_interval(mins => $3)) g)
      SELECT sl.s AS starts_at, sl.e AS ends_at FROM sl
      WHERE sl.s > now()
        AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.doctor_membership_id=$1 AND a.status NOT IN ('cancelled','no_show') AND NOT a.is_walk_in
                        AND tstzrange(a.starts_at,a.ends_at) && tstzrange(sl.s, sl.e))
        AND NOT EXISTS (SELECT 1 FROM availability_exceptions x WHERE x.membership_id=$1 AND x.during && tstzrange(sl.s, sl.e))
      ORDER BY sl.s`, [q.doctor, q.date, q.minutes, c.orgId]));
  }

  // ---------- Appointments ----------
  @RequirePerm('appointment.manage') @Get('appointments')
  list(@Ctx() c: TenantInfo, @Query('from') from: string, @Query('to') to: string, @Query('doctor') doctor?: string, @Query('status') status?: string, @Query('patient') patient?: string) {
    const q = parse({ from: v.datetime(), to: v.datetime(), doctor: v.uuid().optional(), status: v.enum(...APPOINTMENT_STATUSES).optional(), patient: v.uuid().optional() }, { from, to, doctor, status, patient });
    if (Date.parse(q.to) - Date.parse(q.from) > 62 * DAY) throw new BadRequestException('Range is limited to 62 days');
    return this.db.tx(c, (t) => t.q(`${APPT_SELECT} WHERE a.organization_id=$1 AND a.starts_at < $3 AND a.ends_at > $2
      AND ($4::uuid IS NULL OR a.doctor_membership_id=$4) AND ($5::text IS NULL OR a.status=$5) AND ($6::uuid IS NULL OR a.patient_id=$6)
      ORDER BY a.starts_at`, [c.orgId, q.from, q.to, q.doctor ?? null, q.status ?? null, q.patient ?? null]));
  }

  private async getAppt(t: Tx, aid: string) {
    const a = await t.one(`${APPT_SELECT} WHERE a.id=$1`, [aid]);
    if (!a) throw new NotFoundException('Appointment not found');
    return a;
  }

  /** Make sure the doctor can see the patient: org-wide front desk links them on first booking (audited). */
  private async ensureLinked(t: Tx, c: TenantInfo, patientId: string, doctor: string) {
    const linked = await t.one(`SELECT 1 FROM patient_memberships WHERE patient_id=$1 AND membership_id=$2`, [patientId, doctor]);
    if (!linked) {
      await t.q(`INSERT INTO patient_memberships(patient_id,membership_id,linked_by) VALUES ($1,$2,$3)`, [patientId, doctor, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.link', 'patient', patientId, { doctor, reason: 'booking' });
    }
  }

  @RequirePerm('appointment.manage') @Post('appointments')
  create(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({
      patientId: v.uuid(), doctorMembershipId: v.uuid(), startsAt: v.datetime(), durationMinutes: v.int(5, 480).optional(),
      serviceId: v.uuid().optional(), roomId: v.uuid().optional(), locationId: v.uuid().optional(), departmentId: v.uuid().optional(),
      notes: v.str(1, 2000).optional(), recurrence: v.str(5, 100).optional(), status: v.enum('scheduled', 'confirmed').optional(),
      overbookReason: v.str(3, 300).optional(),
    }, body);
    if (b.overbookReason && b.recurrence) throw new BadRequestException('A recurring series cannot be overbooked');
    assertActsFor(c, b.doctorMembershipId);
    let offsets = [0];
    if (b.recurrence) { try { offsets = expandRecurrence(b.recurrence); } catch (e: any) { throw new BadRequestException(e.message); } }
    return this.db.tx(c, async (t) => {
      const doc = await t.one(`SELECT role_code, department_id FROM memberships WHERE id=$1 AND organization_id=$2 AND status='active'`, [b.doctorMembershipId, c.orgId]);
      if (doc?.role_code !== 'doctor') throw new BadRequestException('Choose a doctor of this workspace');
      let minutes = b.durationMinutes;
      if (b.serviceId) {
        const s = await t.one(`SELECT default_minutes FROM services WHERE id=$1 AND organization_id=$2`, [b.serviceId, c.orgId]);
        if (!s) throw new BadRequestException('Service not found');
        minutes ??= s.default_minutes;
      }
      minutes ??= 20;
      await this.ensureLinked(t, c, b.patientId, b.doctorMembershipId);
      const ids: string[] = [];
      for (const off of offsets) {
        const aid = randomUUID();
        const start = new Date(Date.parse(b.startsAt) + off * DAY);
        await t.q(`INSERT INTO appointments(id,organization_id,doctor_membership_id,patient_id,starts_at,ends_at,service_id,room_id,location_id,department_id,notes,recurrence_rule,status,created_by,overbook_reason)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [aid, c.orgId, b.doctorMembershipId, b.patientId, start.toISOString(), new Date(start.getTime() + minutes * 60000).toISOString(),
            b.serviceId ?? null, b.roomId ?? null, b.locationId ?? null, b.departmentId ?? doc.department_id ?? null, b.notes ?? null, b.recurrence ?? null, b.status ?? 'scheduled', c.userId, b.overbookReason ?? null]);
        ids.push(aid);
      }
      await audit(t, c.userId, c.orgId, 'appointment.create', 'appointment', ids[0], { count: ids.length, patient: b.patientId });
      if (b.overbookReason) await audit(t, c.userId, c.orgId, 'appointment.overbook', 'appointment', ids[0], { reason: b.overbookReason });
      await queueAppointmentEvent(t, 'confirmation', ids[0]);   // one message for a recurring series: the first visit
      const rows = await t.q(`${APPT_SELECT} WHERE a.id = ANY($1) ORDER BY a.starts_at`, [ids]);
      return ids.length === 1 ? rows[0] : { appointments: rows };
    });
  }

  /** Walk-in: starts now and goes straight into the waiting room (the doctor is notified). */
  @RequirePerm('appointment.manage') @Post('appointments/walk-in')
  walkIn(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ patientId: v.uuid(), doctorMembershipId: v.uuid(), serviceId: v.uuid().optional(), notes: v.str(1, 2000).optional() }, body);
    assertActsFor(c, b.doctorMembershipId);
    return this.db.tx(c, async (t) => {
      const doc = await t.one(`SELECT role_code, department_id FROM memberships WHERE id=$1 AND organization_id=$2 AND status='active'`, [b.doctorMembershipId, c.orgId]);
      if (doc?.role_code !== 'doctor') throw new BadRequestException('Choose a doctor of this workspace');
      const minutes = b.serviceId ? (await t.one(`SELECT default_minutes FROM services WHERE id=$1`, [b.serviceId]))?.default_minutes ?? 20 : 20;
      await this.ensureLinked(t, c, b.patientId, b.doctorMembershipId);
      const aid = randomUUID();
      await t.q(`INSERT INTO appointments(id,organization_id,doctor_membership_id,patient_id,starts_at,ends_at,service_id,department_id,notes,is_walk_in,created_by)
        VALUES ($1,$2,$3,$4,now(),now() + make_interval(mins => $5),$6,$7,$8,true,$9)`, [aid, c.orgId, b.doctorMembershipId, b.patientId, minutes, b.serviceId ?? null, doc.department_id, b.notes ?? null, c.userId]);
      await t.q(`UPDATE appointments SET status='arrived' WHERE id=$1`, [aid]);
      await audit(t, c.userId, c.orgId, 'appointment.walk_in', 'appointment', aid, { patient: b.patientId });
      return this.getAppt(t, aid);
    });
  }

  @RequirePerm('appointment.manage') @Get('appointments/:id')
  get(@Param('id') aid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => this.getAppt(t, id(aid)));
  }

  /** Edit or reschedule. Time changes are only possible before the patient arrives. */
  @RequirePerm('appointment.manage') @Patch('appointments/:id')
  update(@Param('id') aid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ startsAt: v.datetime().optional(), durationMinutes: v.int(5, 480).optional(), roomId: v.uuid().nullable(), serviceId: v.uuid().nullable(),
      notes: v.str(1, 2000).nullable(), doctorMembershipId: v.uuid().optional(), overbookReason: v.str(3, 300).optional() }, body);
    return this.db.tx(c, async (t) => {
      const a = await this.getAppt(t, id(aid));
      const timeChange = b.startsAt !== undefined || b.durationMinutes !== undefined || b.doctorMembershipId !== undefined;
      if (timeChange && !RESCHEDULABLE.includes(a.status)) throw new BadRequestException(`A ${a.status.replace('_', ' ')} appointment cannot be rescheduled`);
      if (b.doctorMembershipId) { assertActsFor(c, b.doctorMembershipId); await this.ensureLinked(t, c, a.patient_id, b.doctorMembershipId); }
      const start = b.startsAt ?? new Date(a.starts_at).toISOString();
      const mins = b.durationMinutes ?? Math.round((Date.parse(a.ends_at) - Date.parse(a.starts_at)) / 60000);
      const end = new Date(Date.parse(start) + mins * 60000).toISOString();
      const pick = <T>(x: T | undefined, cur: T) => (x === undefined ? cur : x);
      // A reschedule clears an earlier overbooking mark unless a new reason is given.
      const overbook = b.overbookReason ?? (timeChange ? null : a.overbook_reason);
      const r = await t.q(`UPDATE appointments SET starts_at=$2, ends_at=$3, room_id=$4, service_id=$5, notes=$6, doctor_membership_id=$7, overbook_reason=$8 WHERE id=$1 RETURNING id`,
        [a.id, start, end, pick(b.roomId, a.room_id), pick(b.serviceId, a.service_id), pick(b.notes, a.notes), b.doctorMembershipId ?? a.doctor_membership_id, overbook]);
      if (b.overbookReason) await audit(t, c.userId, c.orgId, 'appointment.overbook', 'appointment', a.id, { reason: b.overbookReason });
      if (!r.length) throw new ForbiddenException('Not allowed to change this appointment');
      await audit(t, c.userId, c.orgId, timeChange ? 'appointment.reschedule' : 'appointment.update', 'appointment', a.id,
        timeChange ? { from: a.starts_at, to: start } : { fields: Object.keys(b) });
      if (timeChange && Date.parse(start) !== Date.parse(a.starts_at)) await queueAppointmentEvent(t, 'reschedule', a.id);
      return this.getAppt(t, a.id);
    });
  }

  /** Status changes follow the appointment state machine (see packages/shared). Arrival notifies the doctor. */
  @RequirePerm('appointment.manage') @Post('appointments/:id/status') @HttpCode(200)
  setStatus(@Param('id') aid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ status: v.enum(...APPOINTMENT_STATUSES), reason: v.str(1, 500).optional() }, body);
    return this.db.tx(c, async (t) => {
      const a = await this.getAppt(t, id(aid));
      if (!canTransition(a.status as AppointmentStatus, b.status)) throw new ConflictException({ message: `Cannot change from ${a.status} to ${b.status}`, code: 'invalid_transition' });
      if (b.status === 'in_consultation' && c.doctorMembershipId !== a.doctor_membership_id && !c.actingDoctors.includes(a.doctor_membership_id)) {
        throw new ForbiddenException('Only the doctor or their assistant can call the patient in');
      }
      await t.q(`UPDATE appointments SET status=$2, cancelled_reason=CASE WHEN $2='cancelled' THEN $3 ELSE cancelled_reason END WHERE id=$1`, [a.id, b.status, b.reason ?? null]);
      await audit(t, c.userId, c.orgId, 'appointment.status', 'appointment', a.id, { from: a.status, to: b.status });
      if (b.status === 'cancelled') await queueAppointmentEvent(t, 'cancellation', a.id);
      return this.getAppt(t, a.id);
    });
  }

  /**
   * The fee for this visit, set by the doctor (or by staff who take payments) so the front desk knows what to collect.
   * It becomes the invoice line when the visit is invoiced; once an invoice exists, change the invoice instead.
   */
  @RequireAnyPerm('appointment.manage', 'payment.register') @Put('appointments/:id/fee')
  setFee(@Param('id') aid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ amount: v.num(0, 1e11).nullable(), currency: v.enum('USD', 'LBP').optional(), note: v.str(1, 200).nullable() }, body);
    return this.db.tx(c, async (t) => {
      const a = await this.getAppt(t, id(aid));
      if (c.doctorMembershipId !== a.doctor_membership_id && !c.permissions.has('payment.register')) {
        throw new ForbiddenException('Only the treating doctor or staff who take payments can set the visit fee');
      }
      if (['cancelled', 'no_show'].includes(a.status)) throw new ConflictException('This visit did not take place');
      const inv = await t.one(`SELECT id FROM invoices WHERE appointment_id=$1 AND kind='invoice' AND status<>'void'`, [a.id]);
      if (inv) throw new ConflictException({ message: 'This visit is already invoiced: change the invoice instead', code: 'already_invoiced', invoiceId: inv.id });
      const amount = b.amount ?? null;
      await t.q(`UPDATE appointments SET fee_amount=$2, fee_currency=$3, fee_note=$4, fee_set_at=CASE WHEN $2::numeric IS NULL THEN NULL ELSE now() END, fee_set_by=$5 WHERE id=$1`,
        [a.id, amount, amount === null ? null : (b.currency ?? a.fee_currency ?? a.fee_suggested_currency ?? 'USD'), amount === null ? null : (b.note ?? null), c.userId]);
      await audit(t, c.userId, c.orgId, 'appointment.fee', 'appointment', a.id, { amount, currency: b.currency });
      return this.getAppt(t, a.id);
    });
  }

  /**
   * The front desk's checkout list for today (workspace time zone): visits that ended or have a fee set, with what to
   * collect, the invoice and what is still due (for staff who see invoices), and prescriptions to print (for staff who
   * may view prescriptions). Row-level security decides which visits, invoices and prescriptions each caller sees.
   */
  @RequirePerm('appointment.manage') @Get('front-desk/checkout')
  checkout(@Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const tz = await t.one(`SELECT date_trunc('day', now() AT TIME ZONE timezone) AT TIME ZONE timezone AS day_start FROM organizations WHERE id=$1`, [c.orgId]);
      const rows = await t.q(`${APPT_SELECT} WHERE a.organization_id=$1 AND a.starts_at >= $2::timestamptz - interval '12 hours' AND a.starts_at < $2::timestamptz + interval '1 day'
          AND a.status NOT IN ('cancelled','no_show') AND (a.status IN ('in_consultation','completed') OR a.fee_amount IS NOT NULL)
        ORDER BY coalesce(a.completed_at, a.called_at, a.starts_at) DESC LIMIT 100`, [c.orgId, tz.day_start]);
      if (!rows.length) return [];
      const ids = rows.map((r) => r.id);
      const canInv = c.permissions.has('payment.register') || c.permissions.has('finance.view');
      const invoices = canInv ? await t.q(`SELECT i.appointment_id, i.id, i.status, i.invoice_number AS number, b.total, b.paid, b.credited, b.currency
          FROM invoices i JOIN invoice_balances b ON b.invoice_id=i.id WHERE i.appointment_id = ANY($1::uuid[]) AND i.kind='invoice' AND i.status<>'void'`, [ids]) : [];
      const rxs = c.permissions.has('prescription.view') ? await t.q(`SELECT r.id, r.patient_id, r.prescribed_by, r.status, r.issued_at FROM prescriptions r
          WHERE r.organization_id=$1 AND r.status='issued' AND r.issued_at >= $2::timestamptz - interval '12 hours'
            AND r.patient_id = ANY($3::uuid[]) ORDER BY r.issued_at`, [c.orgId, tz.day_start, rows.map((r) => r.patient_id)]) : [];
      return rows.map((r) => {
        const inv = invoices.find((i) => i.appointment_id === r.id);
        return {
          appointment_id: r.id, patient_id: r.patient_id, patient_name: r.patient_name, patient_number: r.patient_number,
          doctor_membership_id: r.doctor_membership_id, doctor_name: r.doctor_name, status: r.status, service_name: r.service_name,
          called_at: r.called_at, completed_at: r.completed_at,
          fee_amount: r.fee_amount === null ? null : Number(r.fee_amount), fee_currency: r.fee_currency, fee_note: r.fee_note, fee_set_at: r.fee_set_at,
          invoice: inv ? { id: inv.id, status: inv.status, number: inv.number, currency: inv.currency, total: Number(inv.total),
            due: Math.max(0, Math.round((Number(inv.total) - Number(inv.paid) - Number(inv.credited)) * 100) / 100) } : null,
          prescriptions: rxs.filter((x) => x.patient_id === r.patient_id && x.prescribed_by === r.doctor_membership_id).map((x) => ({ id: x.id, issued_at: x.issued_at })),
        };
      });
    });
  }

  /**
   * Live sync for hosts that cannot keep a WebSocket open (the public demo on Vercel), and the alert feed for all hosts.
   * `sig` changes whenever something the caller's screens show changes (today's visits, fees, prescriptions, invoices,
   * unread notifications), so a screen refetches only then. `events` are what happened after `since`: a patient called
   * in, a fee set, a visit finished, a prescription issued. The next `since` is `cursor`, which overlaps a little so an
   * event committed during the previous poll is never missed (the client drops repeats by key).
   */
  @Tenant() @Get('live')
  live(@Ctx() c: TenantInfo, @Query('since') since?: string) {
    const q = parse({ since: v.datetime().optional() }, { since });
    return this.db.tx(c, async (t) => {
      const base = await t.one(`SELECT now() - interval '15 seconds' AS cursor,
          date_trunc('day', now() AT TIME ZONE timezone) AT TIME ZONE timezone AS day_start FROM organizations WHERE id=$1`, [c.orgId]);
      const day = `$2::timestamptz - interval '1 day'`; 
      const sig = await t.one(`SELECT md5(
          coalesce((SELECT string_agg(a.id::text || a.status || a.starts_at::text || coalesce(a.fee_amount::text, '') || coalesce(a.fee_currency, '') || coalesce(a.room_id::text, ''), ',' ORDER BY a.id)
            FROM appointments a WHERE a.organization_id=$1 AND ((a.starts_at >= ${day} AND a.starts_at < $2::timestamptz + interval '15 days')
              OR a.status IN ('arrived','waiting','in_consultation'))), '')
          || '|' || coalesce((SELECT count(*)::text || coalesce(max(r.issued_at)::text, '') FROM prescriptions r WHERE r.organization_id=$1 AND r.issued_at >= ${day}), '')
          || '|' || coalesce((SELECT count(*)::text || coalesce(sum(b.paid)::text, '') || coalesce(string_agg(i.status, '' ORDER BY i.id), '') FROM invoices i JOIN invoice_balances b ON b.invoice_id=i.id
              WHERE i.organization_id=$1 AND i.created_at >= ${day}), '')
          || '|' || coalesce((SELECT count(*)::text || coalesce(string_agg(r.status, '' ORDER BY r.id), '') FROM appointment_requests r WHERE r.organization_id=$1 AND (r.status='pending' OR r.created_at >= ${day})), '')
          || '|' || (SELECT count(*)::text FROM notifications n WHERE n.user_id=$3 AND n.read_at IS NULL)) AS sig`, [c.orgId, base.day_start, c.userId]);
      let events: any[] = [];
      // Never look back more than ten minutes, so an old tab coming back does not replay the whole day.
      if (q.since) events = await this.events(t, c.orgId, new Date(Math.max(Date.parse(q.since), Date.now() - 10 * 60000)).toISOString(), 50, 'ASC');
      return { cursor: base.cursor, sig: sig.sig, events };
    });
  }

  /**
   * What happened in the workspace, newest first: today's operations (workspace time zone) for the live activity feed
   * on the owner's dashboard. Each kind only appears for callers whose row-level security lets them read it.
   */
  @RequireAnyPerm('report.view', 'appointment.manage') @Get('live/activity')
  activity(@Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const day = await t.one(`SELECT date_trunc('day', now() AT TIME ZONE timezone) AT TIME ZONE timezone AS day_start FROM organizations WHERE id=$1`, [c.orgId]);
      return this.events(t, c.orgId, new Date(day.day_start).toISOString(), 100, 'DESC');
    });
  }

  /**
   * Operations after `from`: visit booked, appointment requested from the patient app, patient arrived, called in,
   * fee set, visit finished, cancelled or missed, prescription issued, payment received. Row-level security decides
   * which rows each caller sees (no prescriptions without prescription.view, no payments without finance access...).
   */
  private async events(t: Tx, orgId: string, from: string, limit: number, order: 'ASC' | 'DESC') {
    const who = `JOIN patients p ON p.id=a.patient_id JOIN memberships dm ON dm.id=a.doctor_membership_id JOIN users du ON du.id=dm.user_id LEFT JOIN rooms rm ON rm.id=a.room_id`;
    const cols = (type: string, at: string, fee = 'NULL::numeric, NULL::text', ref = 'NULL::uuid') =>
      `'${type}'::text AS type, a.id AS appointment_id, ${ref} AS ref_id, a.doctor_membership_id, du.full_name AS doctor_name, p.full_name AS patient_name,
       rm.name AS room_name, ${at} AS at, ${fee.split(',')[0]} AS fee_amount, ${fee.split(',')[1]} AS fee_currency, a.starts_at`;
    const rows = await t.q(`
      SELECT ${cols('booked', 'a.created_at')} FROM appointments a ${who} WHERE a.organization_id=$1 AND a.created_at > $2
      UNION ALL SELECT ${cols('arrived', 'a.arrived_at')} FROM appointments a ${who} WHERE a.organization_id=$1 AND a.arrived_at > $2
      UNION ALL SELECT ${cols('called', 'a.called_at')} FROM appointments a ${who} WHERE a.organization_id=$1 AND a.called_at > $2
      UNION ALL SELECT ${cols('fee', 'a.fee_set_at', 'a.fee_amount, a.fee_currency')} FROM appointments a ${who}
        WHERE a.organization_id=$1 AND a.fee_set_at > $2 AND a.fee_amount IS NOT NULL AND a.status NOT IN ('cancelled','no_show')
      UNION ALL SELECT ${cols('completed', 'a.completed_at', 'a.fee_amount, a.fee_currency')} FROM appointments a ${who} WHERE a.organization_id=$1 AND a.completed_at > $2 AND a.status='completed'
      UNION ALL SELECT ${cols('cancelled', 'coalesce(a.cancelled_at, a.starts_at)')} FROM appointments a ${who}
        WHERE a.organization_id=$1 AND a.status IN ('cancelled','no_show') AND coalesce(a.cancelled_at, a.starts_at) > $2 AND coalesce(a.cancelled_at, a.starts_at) <= now()
      UNION ALL SELECT 'prescription', NULL, r.id, r.prescribed_by, du.full_name, p.full_name, NULL, r.issued_at, NULL, NULL, NULL
        FROM prescriptions r JOIN patients p ON p.id=r.patient_id JOIN memberships dm ON dm.id=r.prescribed_by JOIN users du ON du.id=dm.user_id
        WHERE r.organization_id=$1 AND r.issued_at > $2 AND r.status='issued'
      UNION ALL SELECT 'request', NULL, q.id, q.doctor_membership_id, du.full_name, p.full_name, NULL, q.created_at, NULL, NULL, q.preferred_date::timestamptz
        FROM appointment_requests q JOIN patients p ON p.id=q.patient_id LEFT JOIN memberships dm ON dm.id=q.doctor_membership_id LEFT JOIN users du ON du.id=dm.user_id
        WHERE q.organization_id=$1 AND q.created_at > $2 AND q.status='pending'
      UNION ALL SELECT 'payment', i.appointment_id, y.id, i.doctor_membership_id, du.full_name, p.full_name, NULL, y.received_at, y.amount, y.currency, NULL
        FROM payments y JOIN invoices i ON i.id=y.invoice_id JOIN patients p ON p.id=i.patient_id LEFT JOIN memberships dm ON dm.id=i.doctor_membership_id LEFT JOIN users du ON du.id=dm.user_id
        WHERE y.organization_id=$1 AND y.received_at > $2
      ORDER BY at ${order === 'DESC' ? 'DESC' : 'ASC'} LIMIT ${Math.min(Math.max(1, limit), 200)}`, [orgId, from]);
    return rows.map((e) => ({ ...e, prescription_id: e.type === 'prescription' ? e.ref_id : null, fee_amount: e.fee_amount === null ? null : Number(e.fee_amount),
      key: `${e.type}:${e.appointment_id ?? e.ref_id}:${new Date(e.at).getTime()}` }));
  }

  /**
   * The printed day sheet: one day's appointments for the front desk, in the workspace time zone. Phone numbers
   * are left out unless the owner switched "print phone numbers on the day sheet" on (a sheet can be lost).
   */
  @RequirePerm('appointment.manage') @Get('day-sheet')
  daySheet(@Ctx() c: TenantInfo, @Query('date') date: string, @Query('doctor') doctor?: string) {
    const q = parse({ date: v.date(), doctor: v.uuid().optional() }, { date, doctor });
    return this.db.tx(c, async (t) => {
      const org = await t.one(`SELECT name, phone, address, timezone, day_sheet_phones FROM organizations WHERE id=$1`, [c.orgId]);
      const rows = await t.q(`${APPT_SELECT} WHERE a.organization_id=$1 AND a.status NOT IN ('cancelled')
          AND (a.starts_at AT TIME ZONE $3)::date = $2::date AND ($4::uuid IS NULL OR a.doctor_membership_id=$4)
        ORDER BY du.full_name, a.starts_at`, [c.orgId, q.date, org.timezone, q.doctor ?? null]);
      await audit(t, c.userId, c.orgId, 'appointment.day_sheet', 'organization', c.orgId, { date: q.date, phones: org.day_sheet_phones });
      return {
        date: q.date, timezone: org.timezone, organization: { name: org.name, phone: org.phone, address: org.address }, phones: org.day_sheet_phones,
        appointments: rows.map((r) => ({ ...r, patient_phone: org.day_sheet_phones ? r.patient_phone : undefined, notes: undefined })),
      };
    });
  }

  // ---------- Dashboard ----------
  /** Today's numbers for the doctors the caller works for (or the whole org for front desk). Day boundaries use the org time zone. */
  @Tenant() @Get('dashboard/summary')
  summary(@Ctx() c: TenantInfo, @Query('doctor') doctor?: string) {
    const d = doctor ? id(doctor) : null;
    if (d) assertActsFor(c, d);
    return this.db.tx(c, async (t) => {
      const scope = `a.organization_id=$1 AND ($2::uuid IS NULL OR a.doctor_membership_id=$2)`;
      // Sargable day window in the org time zone (lets the (organization_id, starts_at) index work).
      const tz = await t.one(`SELECT date_trunc('day', now() AT TIME ZONE timezone) AT TIME ZONE timezone AS day_start, to_char(now() AT TIME ZONE timezone, 'YYYY-MM-DD') AS local_date FROM organizations WHERE id=$1`, [c.orgId]);
      const day = `a.starts_at >= $3::timestamptz AND a.starts_at < $3::timestamptz + interval '1 day'`;
      const r = await t.one(`SELECT
          (SELECT count(*)::int FROM appointments a WHERE ${scope} AND ${day} AND a.status NOT IN ('cancelled')) AS patients_today,
          (SELECT count(*)::int FROM appointments a WHERE ${scope} AND a.status IN ('arrived','waiting')) AS waiting,
          (SELECT count(*)::int FROM appointments a WHERE ${scope} AND ${day} AND a.status = 'completed') AS completed_today,
          (SELECT count(*)::int FROM appointments a WHERE ${scope} AND a.status='scheduled' AND a.starts_at BETWEEN now() AND now() + interval '2 days') AS pending_confirmations,
          (SELECT count(*)::int FROM patients p WHERE p.organization_id=$1 AND p.created_at > now() - interval '30 days'
             AND ($2::uuid IS NULL OR EXISTS (SELECT 1 FROM patient_memberships pm WHERE pm.patient_id=p.id AND pm.membership_id=$2))) AS new_patients`, [c.orgId, d, tz.day_start]);
      const next = await t.one(`${APPT_SELECT} WHERE a.organization_id=$1 AND ($2::uuid IS NULL OR a.doctor_membership_id=$2) AND a.starts_at > now() AND a.status IN ('scheduled','confirmed') ORDER BY a.starts_at LIMIT 1`, [c.orgId, d]);
      // Specialty widgets backed by specialty profile data (RLS: only rows the caller may read).
      const vaccinationsDue = c.permissions.has('patient.history.read') ? await t.q(`SELECT p.id AS patient_id, p.full_name, dose->>'vaccine' AS vaccine, (dose->>'next_due')::date AS due
          FROM patient_specialty_profiles sp JOIN patients p ON p.id=sp.patient_id, jsonb_array_elements(COALESCE(sp.data->'vaccinations'->'doses','[]')) dose
          WHERE sp.organization_id=$1 AND sp.specialty_code='pediatrics' AND dose ? 'next_due' AND (dose->>'next_due')::date BETWEEN current_date - 7 AND current_date + 30
          ORDER BY due LIMIT 20`, [c.orgId]) : [];
      const pregnanciesDue = c.permissions.has('patient.history.read') ? await t.q(`SELECT p.id AS patient_id, p.full_name, ((sp.data->'pregnancy'->>'lmp')::date + 280) AS edd
          FROM patient_specialty_profiles sp JOIN patients p ON p.id=sp.patient_id
          WHERE sp.organization_id=$1 AND sp.specialty_code='obgyn' AND (sp.data->'pregnancy'->>'pregnant')::boolean IS TRUE AND sp.data->'pregnancy' ? 'lmp'
            AND ((sp.data->'pregnancy'->>'lmp')::date + 280) BETWEEN current_date AND current_date + 60 ORDER BY edd LIMIT 20`, [c.orgId]) : [];
      const followups = c.permissions.has('patient.history.read') ? await specialtyFollowups(t, c.orgId, tz.local_date)
        : { bp_followups: [], inr_due: [], device_checks: [], diabetes_recalls: [], prenatal_followups: [], pap_recalls: [] };
      return { ...r, next_appointment: next ?? null, vaccinations_due: vaccinationsDue, pregnancies_due: pregnanciesDue, ...followups };
    });
  }

  // ---------- Waiting room ----------
  /**
   * The queue: patients who arrived and wait to be called in. With include=today the page also gets who is in with
   * the doctor right now and today's cancellations and no-shows (workspace time zone), so the front desk sees the whole day.
   */
  @RequirePerm('appointment.manage') @Get('waiting-room')
  waitingRoom(@Ctx() c: TenantInfo, @Query('doctor') doctor?: string, @Query('department') department?: string, @Query('include') include?: string) {
    const q = parse({ doctor: v.uuid().optional(), department: v.uuid().optional(), include: v.enum('today').optional() }, { doctor, department, include });
    const queue = `SELECT w.appointment_id, w.doctor_membership_id, du.full_name AS doctor_name, w.department_id, d.name AS department_name,
        w.patient_name, w.appointment_time, w.arrived_at, extract(epoch FROM w.waiting_duration)::int AS waiting_seconds, a.status, a.is_walk_in, a.patient_id,
        a.called_at, a.cancelled_reason
      FROM waiting_room w JOIN appointments a ON a.id=w.appointment_id
      JOIN memberships dm ON dm.id=w.doctor_membership_id JOIN users du ON du.id=dm.user_id LEFT JOIN departments d ON d.id=w.department_id
      WHERE w.organization_id=$1 AND ($2::uuid IS NULL OR w.doctor_membership_id=$2) AND ($3::uuid IS NULL OR w.department_id=$3)`;
    const rest = `SELECT a.id, a.doctor_membership_id, du.full_name, a.department_id, d.name, p.full_name, a.starts_at, a.arrived_at,
        extract(epoch FROM now() - a.arrived_at)::int, a.status, a.is_walk_in, a.patient_id, a.called_at, a.cancelled_reason
      FROM appointments a JOIN patients p ON p.id=a.patient_id JOIN organizations o ON o.id=a.organization_id
      JOIN memberships dm ON dm.id=a.doctor_membership_id JOIN users du ON du.id=dm.user_id LEFT JOIN departments d ON d.id=a.department_id
      WHERE a.organization_id=$1 AND ($2::uuid IS NULL OR a.doctor_membership_id=$2) AND ($3::uuid IS NULL OR a.department_id=$3)
        AND (a.status='in_consultation' OR (a.status IN ('cancelled','no_show')
          AND (a.starts_at AT TIME ZONE o.timezone)::date = (now() AT TIME ZONE o.timezone)::date))`;
    const sql = q.include === 'today' ? `${queue} UNION ALL ${rest} ORDER BY 8 NULLS LAST, 7` : `${queue} ORDER BY w.arrived_at`;
    return this.db.tx(c, (t) => t.q(sql, [c.orgId, q.doctor ?? null, q.department ?? null]));
  }

}

/** Notifications belong to the user, across all their workspaces. */
@Controller('notifications')
export class NotificationsController {
  constructor(private db: Db) {}

  @Get()
  list(@Auth() a: AuthInfo, @Query('unread') unread?: string) {
    // Payloads carry ids only (no patient names), so a notification never leaks data outside the workspace it came from.
    return this.db.tx({ userId: a.userId }, (t) => t.q(`SELECT n.id, n.kind, n.payload, n.read_at, n.created_at, o.name AS organization_name
      FROM notifications n LEFT JOIN organizations o ON o.id = (n.payload->>'organization_id')::uuid
      WHERE n.user_id=$1 AND ($2::boolean IS NOT TRUE OR n.read_at IS NULL) ORDER BY n.created_at DESC LIMIT 100`, [a.userId, unread === '1' || unread === 'true']));
  }

  @Post(':id/read') @HttpCode(200)
  async read(@Param('id') nid: string, @Auth() a: AuthInfo) {
    await this.db.tx({ userId: a.userId }, (t) => t.q(`UPDATE notifications SET read_at=now() WHERE id=$1 AND read_at IS NULL`, [id(nid)]));
    return { ok: true };
  }

  @Post('read-all') @HttpCode(200)
  async readAll(@Auth() a: AuthInfo) {
    await this.db.tx({ userId: a.userId }, (t) => t.q(`UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL`, [a.userId]));
    return { ok: true };
  }
}

@Module({ controllers: [SchedulingController, NotificationsController] })
export class SchedulingModule {}
