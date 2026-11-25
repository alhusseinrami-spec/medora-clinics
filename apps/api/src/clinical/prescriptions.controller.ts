import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Db, Tx } from '../db/db.service.js';
import { Ctx, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { ownDoctor, uid } from './consultations.controller.js';

const ITEM = v.object({
  medicationId: v.uuid().nullable(), medicationName: v.str(1, 200), dosage: v.str(1, 120).nullable(), frequency: v.str(1, 120).nullable(),
  duration: v.str(1, 120).nullable(), instructions: v.str(1, 500).nullable(), notes: v.str(1, 500).nullable(),
});
type Item = ReturnType<typeof ITEM.parse> & {};

@Controller()
export class PrescriptionsController {
  constructor(private db: Db) {}

  /** Searches the shared generic catalog and the workspace's own medications. */
  @RequirePerm('prescription.view') @Get('medications')
  medications(@Ctx() c: TenantInfo, @Query('q') q = '') {
    const term = String(q).trim().slice(0, 80);
    return this.db.tx(c, (t) => t.q(`SELECT id, name, strength, form, route, organization_id IS NOT NULL AS custom FROM medications
      WHERE $1 = '' OR lower(name) LIKE '%' || lower($1) || '%' OR similarity(lower(name), lower($1)) > 0.3
      ORDER BY CASE WHEN lower(name) LIKE lower($1) || '%' THEN 0 ELSE 1 END, similarity(lower(name), lower($1)) DESC, name, strength LIMIT 25`, [term]));
  }

  @RequirePerm('prescription.create') @Post('medications')
  addMedication(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 200), strength: v.str(1, 60).nullable(), form: v.str(1, 60).nullable(), route: v.str(1, 60).nullable() }, body);
    ownDoctor(c);
    return this.db.tx(c, async (t) => {
      const r = await t.one(`INSERT INTO medications(organization_id, name, strength, form, route, created_by) VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, name, strength, form, route, true AS custom`, [c.orgId, b.name, b.strength ?? null, b.form ?? null, b.route ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'medication.create', 'medication', r.id);
      return r;
    });
  }

  /** Writes a draft prescription, standalone or inside a consultation. */
  @RequirePerm('prescription.create') @Post('prescriptions')
  create(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ patientId: v.uuid(), consultationId: v.uuid().optional(), notes: v.str(1, 2000).nullable(), items: v.array(ITEM, 30), templateId: v.uuid().optional() }, body);
    const mid = ownDoctor(c);
    return this.db.tx(c, async (t) => {
      if (b.consultationId) {
        const con = await t.one(`SELECT patient_id, doctor_membership_id, status FROM consultations WHERE id=$1`, [b.consultationId]);
        if (!con) throw new NotFoundException('Consultation not found');
        if (con.patient_id !== b.patientId) throw new BadRequestException('The consultation is for another patient');
        if (con.doctor_membership_id !== mid) throw new ForbiddenException('This consultation belongs to another doctor');
        if (con.status === 'signed') throw new ConflictException({ message: 'This consultation is signed. Write a standalone prescription instead.', code: 'record_locked' });
      }
      let items = b.items as Item[];
      if (b.templateId) {
        const tpl = await t.one(`SELECT items FROM prescription_templates WHERE id=$1`, [b.templateId]);
        if (!tpl) throw new NotFoundException('Prescription template not found');
        items = [...(tpl.items as Item[]), ...items];
      }
      const r = await t.one(`INSERT INTO prescriptions(organization_id, patient_id, prescribed_by, consultation_id, notes, status)
        VALUES ($1,$2,$3,$4,$5,'draft') RETURNING id`, [c.orgId, b.patientId, mid, b.consultationId ?? null, b.notes ?? null]);
      await this.writeItems(t, r.id, items);
      await audit(t, c.userId, c.orgId, 'prescription.create', 'prescription', r.id, { patient: b.patientId });
      return this.load(t, r.id);
    });
  }

  @RequirePerm('prescription.view') @Get('prescriptions/:id')
  get(@Param('id') rid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await this.load(t, uid(rid));
      await audit(t, c.userId, c.orgId, 'prescription.view', 'prescription', rid);
      return r;
    });
  }

  @RequirePerm('prescription.create') @Patch('prescriptions/:id')
  update(@Param('id') rid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ notes: v.str(1, 2000).nullable(), items: v.array(ITEM, 30).optional() }, body);
    return this.db.tx(c, async (t) => {
      const cur = await this.mine(t, c, uid(rid));
      if (cur.status !== 'draft') throw new ConflictException({ message: 'An issued prescription cannot be changed. Cancel it and write a new one.', code: 'record_locked' });
      if (b.notes !== undefined) await t.q(`UPDATE prescriptions SET notes=$2 WHERE id=$1`, [rid, b.notes]);
      if (b.items) { await t.q(`DELETE FROM prescription_items WHERE prescription_id=$1`, [rid]); await this.writeItems(t, rid, b.items as Item[]); }
      await audit(t, c.userId, c.orgId, 'prescription.update', 'prescription', rid);
      return this.load(t, rid);
    });
  }

  /** Issues the prescription. From here it is a fixed document: printable, shareable, cancellable, never editable. */
  @RequirePerm('prescription.create') @Post('prescriptions/:id/issue')
  issue(@Param('id') rid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const cur = await this.mine(t, c, uid(rid));
      if (cur.status !== 'draft') throw new ConflictException('This prescription was already issued');
      const n = await t.one(`SELECT count(*)::int AS n FROM prescription_items WHERE prescription_id=$1`, [rid]);
      if (!n.n) throw new BadRequestException('Add at least one medication');
      await t.q(`UPDATE prescriptions SET status='issued', issued_at=now(),
        items=(SELECT jsonb_agg(to_jsonb(i) - 'prescription_id' ORDER BY i.position) FROM prescription_items i WHERE i.prescription_id=$1) WHERE id=$1`, [rid]);
      await audit(t, c.userId, c.orgId, 'prescription.issue', 'prescription', rid);
      return this.load(t, rid);
    });
  }

  @RequirePerm('prescription.create') @Post('prescriptions/:id/cancel')
  cancel(@Param('id') rid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ reason: v.str(3, 500) }, body);
    return this.db.tx(c, async (t) => {
      const cur = await this.mine(t, c, uid(rid));
      if (cur.status !== 'issued') throw new ConflictException(cur.status === 'draft' ? 'Delete the draft instead' : 'Already cancelled');
      await t.q(`UPDATE prescriptions SET status='cancelled', cancelled_at=now(), cancel_reason=$2 WHERE id=$1`, [rid, b.reason]);
      await audit(t, c.userId, c.orgId, 'prescription.cancel', 'prescription', rid, { reason: b.reason });
      return this.load(t, rid);
    });
  }

  /**
   * Marks an issued prescription as shared with the patient. Sending it by WhatsApp or email needs those
   * providers connected (Release 4 / awaiting credentials), so the answer says how it can be delivered today.
   */
  @RequirePerm('prescription.create') @Post('prescriptions/:id/share')
  share(@Param('id') rid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ shared: v.bool() }, body);
    return this.db.tx(c, async (t) => {
      const cur = await this.mine(t, c, uid(rid));
      if (cur.status !== 'issued') throw new ConflictException('Only an issued prescription can be shared');
      await t.q(`UPDATE prescriptions SET shared_with_patient=$2, shared_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1`, [rid, b.shared]);
      await audit(t, c.userId, c.orgId, b.shared ? 'prescription.share' : 'prescription.unshare', 'prescription', rid);
      return { ...(await this.load(t, rid)), delivery: { whatsapp: 'planned', email: 'awaiting_credentials', print: 'available' } };
    });
  }

  @RequirePerm('prescription.create') @Delete('prescriptions/:id')
  remove(@Param('id') rid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const cur = await this.mine(t, c, uid(rid));
      if (cur.status !== 'draft') throw new ConflictException({ message: 'An issued prescription cannot be deleted. Cancel it instead.', code: 'record_locked' });
      await t.q(`DELETE FROM prescriptions WHERE id=$1`, [rid]);
      await audit(t, c.userId, c.orgId, 'prescription.delete_draft', 'prescription', rid);
      return { ok: true };
    });
  }

  @RequirePerm('prescription.view') @Get('patients/:id/prescriptions')
  list(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT r.id, r.status, r.created_at, r.issued_at, r.cancelled_at, r.consultation_id, r.shared_with_patient,
        u.full_name AS doctor_name,
        (SELECT coalesce(json_agg(i.medication_name ORDER BY i.position), '[]') FROM prescription_items i WHERE i.prescription_id=r.id) AS medications
      FROM prescriptions r JOIN memberships m ON m.id=r.prescribed_by JOIN users u ON u.id=m.user_id
      WHERE r.patient_id=$1 ORDER BY r.created_at DESC`, [uid(pid)]));
  }

  // ---- Prescription templates (the doctor's own reusable prescriptions) ----
  @RequirePerm('prescription.create') @Get('prescription-templates')
  templates(@Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT id, name, items, notes, updated_at FROM prescription_templates WHERE owner_membership_id=$1 ORDER BY name`, [ownDoctor(c)]));
  }

  @RequirePerm('prescription.create') @Post('prescription-templates')
  createTemplate(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(1, 120), notes: v.str(1, 2000).nullable(), items: v.array(ITEM, 30) }, body);
    if (!b.items.length) throw new BadRequestException('Add at least one medication');
    const mid = ownDoctor(c);
    return this.db.tx(c, async (t) => {
      const r = await t.one(`INSERT INTO prescription_templates(organization_id, owner_membership_id, name, notes, items) VALUES ($1,$2,$3,$4,$5)
        RETURNING id, name, items, notes, updated_at`, [c.orgId, mid, b.name, b.notes ?? null, JSON.stringify(b.items)]);
      await audit(t, c.userId, c.orgId, 'prescription_template.create', 'prescription_template', r.id);
      return r;
    });
  }

  @RequirePerm('prescription.create') @Put('prescription-templates/:id')
  updateTemplate(@Param('id') tid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(1, 120), notes: v.str(1, 2000).nullable(), items: v.array(ITEM, 30) }, body);
    return this.db.tx(c, async (t) => {
      const r = await t.one(`UPDATE prescription_templates SET name=$2, notes=$3, items=$4, updated_at=now() WHERE id=$1 AND owner_membership_id=$5
        RETURNING id, name, items, notes, updated_at`, [uid(tid), b.name, b.notes ?? null, JSON.stringify(b.items), ownDoctor(c)]);
      if (!r) throw new NotFoundException('Template not found');
      return r;
    });
  }

  @RequirePerm('prescription.create') @Delete('prescription-templates/:id')
  deleteTemplate(@Param('id') tid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.q(`DELETE FROM prescription_templates WHERE id=$1 AND owner_membership_id=$2 RETURNING id`, [uid(tid), ownDoctor(c)]);
      if (!r.length) throw new NotFoundException('Template not found');
      return { ok: true };
    });
  }

  private async writeItems(t: Tx, rid: string, items: Item[]) {
    for (const [i, it] of items.entries()) {
      await t.q(`INSERT INTO prescription_items(prescription_id, medication_id, medication_name, dosage, frequency, duration, instructions, notes, position)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [rid, it.medicationId ?? null, it.medicationName, it.dosage ?? null, it.frequency ?? null, it.duration ?? null, it.instructions ?? null, it.notes ?? null, i]);
    }
  }

  private async mine(t: Tx, c: TenantInfo, rid: string) {
    const r = await t.one(`SELECT id, status, prescribed_by FROM prescriptions WHERE id=$1`, [rid]);
    if (!r) throw new NotFoundException('Prescription not found');
    if (r.prescribed_by !== c.doctorMembershipId) throw new ForbiddenException('Only the prescribing doctor can change this prescription');
    return r;
  }

  /** Everything the printed prescription needs: doctor, workspace letterhead, patient and items. */
  async load(t: Tx, rid: string) {
    const r = await t.one(`SELECT r.id, r.status, r.notes, r.created_at, r.issued_at, r.cancelled_at, r.cancel_reason, r.shared_with_patient, r.shared_at,
        r.consultation_id, r.patient_id, r.prescribed_by,
        u.full_name AS doctor_name, m.specialty_code, m.license_number, o.name AS organization_name, o.kind AS organization_kind,
        o.phone AS organization_phone, o.address AS organization_address,
        p.full_name AS patient_name, p.patient_number, p.date_of_birth, p.sex, p.allergies
      FROM prescriptions r JOIN memberships m ON m.id=r.prescribed_by JOIN users u ON u.id=m.user_id
      JOIN organizations o ON o.id=r.organization_id JOIN patients p ON p.id=r.patient_id WHERE r.id=$1`, [rid]);
    if (!r) throw new NotFoundException('Prescription not found');
    r.items = await t.q(`SELECT id, medication_id, medication_name, dosage, frequency, duration, instructions, notes FROM prescription_items
      WHERE prescription_id=$1 ORDER BY position`, [rid]);
    return r;
  }
}
