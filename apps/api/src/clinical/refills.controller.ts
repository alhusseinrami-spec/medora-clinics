import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Query } from '@nestjs/common';
import { Db, Tx } from '../db/db.service.js';
import { Ctx, RequireAnyPerm, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { ownDoctor, uid } from './consultations.controller.js';

/**
 * Prescription refill requests. They arrive from the patient's WhatsApp message (recognised automatically) or are
 * written by the team. The prescribing doctor approves (a new issued prescription with the same medications) or
 * denies, and the patient gets a short WhatsApp message either way (with consent, inside message hours).
 */
@Controller('refills')
export class RefillsController {
  constructor(private db: Db) {}

  @RequireAnyPerm('prescription.view', 'whatsapp.send', 'appointment.manage') @Get()
  list(@Ctx() c: TenantInfo, @Query() query: Record<string, string>) {
    const f = parse({ status: v.enum('pending', 'approved', 'denied').optional(), patient: v.uuid().optional() }, query);
    return this.db.tx(c, (t) => t.q(`${SELECT} WHERE rr.organization_id=$1 AND ($2::text IS NULL OR rr.status=$2) AND ($3::uuid IS NULL OR rr.patient_id=$3)
      ORDER BY (rr.status='pending') DESC, rr.created_at DESC LIMIT 200`, [c.orgId, f.status ?? null, f.patient ?? null]));
  }

  /** A request written by the team, for the patient's latest prescription or the one given. */
  @RequireAnyPerm('whatsapp.send', 'prescription.create', 'appointment.manage') @Post()
  create(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ patientId: v.uuid(), prescriptionId: v.uuid().optional(), conversationId: v.uuid().optional(), note: v.str(1, 500).nullable() }, body);
    return this.db.tx(c, async (t) => {
      // Security-definer lookup: the front desk may not read prescriptions, but may ask for a renewal of the latest one.
      const rx = await t.one(`SELECT * FROM refill_source($1, $2)`, [b.patientId, b.prescriptionId ?? null]);
      if (!rx?.id) throw new NotFoundException('This patient has no issued prescription to renew');
      const dup = await t.one(`SELECT id FROM refill_requests WHERE prescription_id=$1 AND status='pending'`, [rx.id]);
      if (dup) throw new ConflictException({ message: 'A renewal of this prescription is already waiting for the doctor', code: 'duplicate' });
      const r = await t.one(`INSERT INTO refill_requests (organization_id, patient_id, prescription_id, doctor_membership_id, conversation_id, source, note, created_by)
        VALUES ($1,$2,$3,$4,$5,'staff',$6,$7) RETURNING id`, [c.orgId, b.patientId, rx.id, rx.prescribed_by, b.conversationId ?? null, b.note ?? null, c.userId]);
      await t.q(`SELECT refill_notify_doctor($1)`, [r.id]);
      await audit(t, c.userId, c.orgId, 'refill.create', 'refill_request', r.id);
      return this.one(t, r.id);
    });
  }

  /** The prescribing doctor renews: a new issued prescription with the same medications. */
  @RequirePerm('prescription.create') @Post(':id/approve') @HttpCode(200)
  approve(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ note: v.str(1, 500).nullable() }, body ?? {});
    const mid = ownDoctor(c);
    return this.db.tx(c, async (t) => {
      const rr = await this.pending(t, c, uid(id), mid);
      const src = await t.one(`SELECT id, consultation_id FROM prescriptions WHERE id=$1 AND status='issued'`, [rr.prescription_id]);
      if (!src) throw new ConflictException('The original prescription was cancelled. Write a new one instead.');
      const rx = await t.one(`INSERT INTO prescriptions(organization_id, patient_id, prescribed_by, notes, status) VALUES ($1,$2,$3,$4,'draft') RETURNING id`,
        [c.orgId, rr.patient_id, mid, b.note ?? null]);
      await t.q(`INSERT INTO prescription_items(prescription_id, medication_id, medication_name, dosage, frequency, duration, instructions, notes, position)
        SELECT $1, medication_id, medication_name, dosage, frequency, duration, instructions, notes, position FROM prescription_items WHERE prescription_id=$2`, [rx.id, src.id]);
      await t.q(`UPDATE prescriptions SET status='issued', issued_at=now(),
        items=(SELECT jsonb_agg(to_jsonb(i) - 'prescription_id' ORDER BY i.position) FROM prescription_items i WHERE i.prescription_id=$1) WHERE id=$1`, [rx.id]);
      await t.q(`UPDATE refill_requests SET status='approved', decided_by=$2, decided_at=now(), decision_note=$3, new_prescription_id=$4 WHERE id=$1`,
        [rr.id, c.userId, b.note ?? null, rx.id]);
      const queued = await t.one(`SELECT refill_queue_message($1, 'approved') AS id`, [rr.id]);
      await audit(t, c.userId, c.orgId, 'refill.approve', 'refill_request', rr.id, { prescription: rx.id });
      await audit(t, c.userId, c.orgId, 'prescription.issue', 'prescription', rx.id, { refillOf: src.id });
      return { ...(await this.one(t, rr.id)), patientNotified: Boolean(queued.id) };
    });
  }

  @RequirePerm('prescription.create') @Post(':id/deny') @HttpCode(200)
  deny(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ reason: v.str(3, 500) }, body);
    const mid = ownDoctor(c);
    return this.db.tx(c, async (t) => {
      const rr = await this.pending(t, c, uid(id), mid);
      await t.q(`UPDATE refill_requests SET status='denied', decided_by=$2, decided_at=now(), decision_note=$3 WHERE id=$1`, [rr.id, c.userId, b.reason]);
      const queued = await t.one(`SELECT refill_queue_message($1, 'denied') AS id`, [rr.id]);
      await audit(t, c.userId, c.orgId, 'refill.deny', 'refill_request', rr.id);
      return { ...(await this.one(t, rr.id)), patientNotified: Boolean(queued.id) };
    });
  }

  private async pending(t: Tx, c: TenantInfo, id: string, mid: string) {
    const rr = await t.one(`SELECT * FROM refill_requests WHERE id=$1 AND organization_id=$2`, [id, c.orgId]);
    if (!rr) throw new NotFoundException('Refill request not found');
    if (rr.doctor_membership_id !== mid) throw new ForbiddenException('Only the prescribing doctor decides on this renewal');
    if (rr.status !== 'pending') throw new ConflictException(`This request was already ${rr.status}`);
    return rr;
  }

  private one(t: Tx, id: string) { return t.one(`${SELECT} WHERE rr.id=$1`, [id]); }
}

// Medications come from the prescriptions table under the caller's own row-level security: the front desk sees none.
const SELECT = `SELECT rr.id, rr.status, rr.source, rr.note, rr.decision_note, rr.created_at, rr.decided_at, rr.conversation_id,
    rr.patient_id, p.full_name AS patient_name, p.patient_number, rr.prescription_id, rr.new_prescription_id,
    rr.doctor_membership_id, du.full_name AS doctor_name, cu.full_name AS created_by_name, xu.full_name AS decided_by_name,
    src.issued_at AS prescription_issued_at,
    (SELECT coalesce(json_agg(json_build_object('name', i.medication_name, 'dosage', i.dosage, 'frequency', i.frequency) ORDER BY i.position), '[]')
       FROM prescription_items i WHERE i.prescription_id = src.id) AS items
  FROM refill_requests rr JOIN patients p ON p.id=rr.patient_id
  JOIN memberships dm ON dm.id=rr.doctor_membership_id JOIN users du ON du.id=dm.user_id
  LEFT JOIN users cu ON cu.id=rr.created_by LEFT JOIN users xu ON xu.id=rr.decided_by
  LEFT JOIN prescriptions src ON src.id=rr.prescription_id`;
