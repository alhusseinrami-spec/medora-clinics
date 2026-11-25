import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { canTransition, validateData, type AppointmentStatus, type TemplateSchema } from '@medora/shared';
import { Db, Tx } from '../db/db.service.js';
import { Ctx, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { SpecialtyService } from '../specialty/specialty.service.js';

export const uid = (x: string) => parse({ id: v.uuid() }, { id: x }).id;

const VITALS = v.object({
  bp_systolic: v.int(40, 300).optional(), bp_diastolic: v.int(20, 200).optional(), pulse: v.int(20, 250).optional(),
  temperature_c: v.num(30, 44).optional(), spo2: v.int(50, 100).optional(), resp_rate: v.int(4, 80).optional(),
  weight_kg: v.num(0.3, 400).optional(), height_cm: v.num(20, 250).optional(),
});
const EDITABLE = {
  chiefComplaint: v.str(1, 2000).nullable(), clinicalNotes: v.str(1, 20000).nullable(), examination: v.str(1, 20000).nullable(),
  vitalSigns: VITALS.nullable(), treatmentPlan: v.str(1, 10000).nullable(), followUpInstructions: v.str(1, 5000).nullable(),
  followUpDate: v.date().nullable(), specialtyData: v.any().optional(),
};
const COLS: Record<string, string> = {
  chiefComplaint: 'chief_complaint', clinicalNotes: 'clinical_notes', examination: 'examination', vitalSigns: 'vital_signs',
  treatmentPlan: 'treatment_plan', followUpInstructions: 'follow_up_instructions', followUpDate: 'follow_up_date', specialtyData: 'specialty_data',
};
const DIAGNOSIS = v.object({ code: v.str(1, 20).nullable(), description: v.str(1, 500), isPrimary: v.bool().optional() });

/** The caller's own doctor membership in this workspace. Only doctors author consultations. */
export function ownDoctor(c: TenantInfo): string {
  if (!c.doctorMembershipId) throw new ForbiddenException('Only a doctor can write consultations and prescriptions');
  return c.doctorMembershipId;
}

@Controller()
export class ConsultationsController {
  constructor(private db: Db, private spec: SpecialtyService) {}

  /**
   * Opens a draft consultation for a patient, optionally from an appointment. Starting from an appointment
   * moves it to "in consultation" and is idempotent: the same appointment always returns its one consultation.
   */
  @RequirePerm('clinical_notes.read') @Post('consultations')
  start(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ patientId: v.uuid().optional(), appointmentId: v.uuid().optional() }, body);
    const mid = ownDoctor(c);
    return this.db.tx(c, async (t) => {
      let patientId = b.patientId;
      if (b.appointmentId) {
        const a = await t.one(`SELECT id, patient_id, doctor_membership_id, status FROM appointments WHERE id=$1 AND organization_id=$2`, [b.appointmentId, c.orgId]);
        if (!a) throw new NotFoundException('Appointment not found');
        if (a.doctor_membership_id !== mid) throw new ForbiddenException('This appointment is with another doctor');
        if (patientId && patientId !== a.patient_id) throw new BadRequestException('The appointment is for another patient');
        patientId = a.patient_id;
        const existing = await t.one(`SELECT id FROM consultations WHERE appointment_id=$1`, [a.id]);
        if (existing) return this.load(t, existing.id);
        if (['cancelled', 'no_show'].includes(a.status)) throw new ConflictException('This appointment was cancelled or missed');
        if (a.status !== 'in_consultation' && a.status !== 'completed') {
          if (!canTransition(a.status as AppointmentStatus, 'in_consultation')) {
            // Scheduled or confirmed patients are marked arrived first, as the front desk would.
            if (canTransition(a.status as AppointmentStatus, 'arrived')) await t.q(`UPDATE appointments SET status='arrived' WHERE id=$1`, [a.id]);
          }
          await t.q(`UPDATE appointments SET status='in_consultation' WHERE id=$1`, [a.id]);
        }
      }
      if (!patientId) throw new BadRequestException('Choose a patient');
      const p = await t.one(`SELECT id FROM patients WHERE id=$1 AND organization_id=$2`, [patientId, c.orgId]);
      if (!p) throw new NotFoundException('Patient not found');
      const d = await this.spec.resolveDoctor(t, c, mid);
      const tpl = await this.spec.effective(t, mid, d.specialty, 'examination');
      const r = await t.one(`INSERT INTO consultations(organization_id, patient_id, doctor_membership_id, appointment_id, specialty_code, template_version_id)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [c.orgId, patientId, mid, b.appointmentId ?? null, d.specialty, tpl.versionId]);
      await audit(t, c.userId, c.orgId, 'consultation.start', 'consultation', r.id, { patient: patientId, appointment: b.appointmentId ?? null });
      return this.load(t, r.id);
    });
  }

  @RequirePerm('clinical_notes.read') @Get('consultations/:id')
  get(@Param('id') cid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await this.load(t, uid(cid));
      await audit(t, c.userId, c.orgId, 'consultation.view', 'consultation', cid);
      return r;
    });
  }

  /** Saves the draft. Specialty examination data is validated against the template version the consultation was opened with. */
  @RequirePerm('clinical_notes.read') @Patch('consultations/:id')
  update(@Param('id') cid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse(EDITABLE, body) as Record<string, unknown>;
    const fields = Object.keys(b).filter((k) => b[k] !== undefined);
    if (!fields.length) throw new BadRequestException('Nothing to update');
    return this.db.tx(c, async (t) => {
      const cur = await this.editable(t, c, uid(cid));
      if (b.specialtyData !== undefined) {
        const v = await t.one(`SELECT schema FROM template_versions WHERE id=$1`, [cur.template_version_id]);
        const res = validateData(v.schema as TemplateSchema, b.specialtyData ?? {});
        if (!res.ok) throw new BadRequestException({ message: 'Some examination fields are not valid', errors: res.errors.map((e) => `${e.path}: ${e.message}`), fieldErrors: res.errors });
        b.specialtyData = res.value;
      }
      const vals = fields.map((k) => (k === 'vitalSigns' || k === 'specialtyData') && b[k] != null ? JSON.stringify(b[k]) : b[k]);
      await t.q(`UPDATE consultations SET ${fields.map((k, i) => `${COLS[k]}=$${i + 2}`).join(', ')} WHERE id=$1`, [cid, ...vals]);
      await audit(t, c.userId, c.orgId, 'consultation.update', 'consultation', cid, { fields });
      return this.load(t, cid);
    });
  }

  /** Replaces the diagnosis list of a draft. */
  @RequirePerm('clinical_notes.read') @Put('consultations/:id/diagnoses')
  diagnoses(@Param('id') cid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ diagnoses: v.array(DIAGNOSIS, 30) }, body);
    if (b.diagnoses.filter((d) => d.isPrimary).length > 1) throw new BadRequestException('Only one diagnosis can be the primary one');
    return this.db.tx(c, async (t) => {
      await this.editable(t, c, uid(cid));
      await t.q(`DELETE FROM diagnoses WHERE consultation_id=$1`, [cid]);
      for (const [i, d] of b.diagnoses.entries()) {
        await t.q(`INSERT INTO diagnoses(consultation_id, code, description, is_primary, position) VALUES ($1,$2,$3,$4,$5)`,
          [cid, d.code ?? null, d.description, d.isPrimary ?? false, i]);
      }
      await audit(t, c.userId, c.orgId, 'consultation.diagnoses', 'consultation', cid, { count: b.diagnoses.length });
      return this.load(t, cid);
    });
  }

  /** Signs the consultation. After this it can never change; corrections are added as addenda. Completes the appointment. */
  @RequirePerm('clinical_notes.read') @Post('consultations/:id/sign')
  sign(@Param('id') cid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const cur = await this.editable(t, c, uid(cid));
      const hasContent = cur.chief_complaint || cur.clinical_notes || cur.examination || cur.treatment_plan
        || Object.keys(cur.specialty_data ?? {}).length || (await t.one(`SELECT 1 AS x FROM diagnoses WHERE consultation_id=$1 LIMIT 1`, [cid]));
      if (!hasContent) throw new BadRequestException('Write something before signing: a complaint, notes, an examination or a diagnosis');
      const drafts = await t.one(`SELECT count(*)::int AS n FROM prescriptions WHERE consultation_id=$1 AND status='draft'`, [cid]);
      if (drafts.n) throw new ConflictException('Issue or delete the draft prescription before signing');
      await t.q(`UPDATE consultations SET status='signed', signed_at=now(), signed_by=$2 WHERE id=$1`, [cid, c.userId]);
      if (cur.appointment_id) await t.q(`UPDATE appointments SET status='completed' WHERE id=$1 AND status='in_consultation'`, [cur.appointment_id]);
      await audit(t, c.userId, c.orgId, 'consultation.sign', 'consultation', cid);
      return this.load(t, cid);
    });
  }

  @RequirePerm('clinical_notes.read') @Post('consultations/:id/addenda')
  addendum(@Param('id') cid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ body: v.str(1, 10000) }, body);
    const mid = ownDoctor(c);
    return this.db.tx(c, async (t) => {
      const cur = await t.one(`SELECT id, status FROM consultations WHERE id=$1`, [uid(cid)]);
      if (!cur) throw new NotFoundException('Consultation not found');
      if (cur.status !== 'signed') throw new ConflictException('Addenda are for signed consultations; edit the draft instead');
      await t.q(`INSERT INTO consultation_addenda(organization_id, consultation_id, author_membership_id, body) VALUES ($1,$2,$3,$4)`, [c.orgId, cid, mid, b.body]);
      await audit(t, c.userId, c.orgId, 'consultation.addendum', 'consultation', cid);
      return this.load(t, cid);
    });
  }

  /** Discards an unsigned draft (and its draft prescriptions). Signed consultations are permanent. */
  @RequirePerm('clinical_notes.read') @Delete('consultations/:id')
  discard(@Param('id') cid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const cur = await this.editable(t, c, uid(cid));
      const issued = await t.one(`SELECT count(*)::int AS n FROM prescriptions WHERE consultation_id=$1 AND status<>'draft'`, [cid]);
      if (issued.n) throw new ConflictException('This consultation has an issued prescription; sign it instead');
      await t.q(`DELETE FROM prescriptions WHERE consultation_id=$1 AND status='draft'`, [cid]);
      await t.q(`UPDATE medical_documents SET consultation_id=NULL WHERE consultation_id=$1`, [cid]);
      await t.q(`DELETE FROM consultations WHERE id=$1`, [cid]);
      if (cur.appointment_id) await t.q(`UPDATE appointments SET status='waiting' WHERE id=$1 AND status='in_consultation'`, [cur.appointment_id]);
      await audit(t, c.userId, c.orgId, 'consultation.discard', 'consultation', cid);
      return { ok: true };
    });
  }

  @RequirePerm('clinical_notes.read') @Get('patients/:id/consultations')
  list(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT c.id, c.status, c.created_at, c.signed_at, c.chief_complaint, c.specialty_code, c.follow_up_date,
        u.full_name AS doctor_name, c.doctor_membership_id,
        (SELECT coalesce(json_agg(d.description ORDER BY d.position), '[]') FROM diagnoses d WHERE d.consultation_id=c.id) AS diagnoses,
        (SELECT count(*)::int FROM consultation_addenda a WHERE a.consultation_id=c.id) AS addenda
      FROM consultations c JOIN memberships m ON m.id=c.doctor_membership_id JOIN users u ON u.id=m.user_id
      WHERE c.patient_id=$1 ORDER BY c.created_at DESC`, [uid(pid)]));
  }

  private async editable(t: Tx, c: TenantInfo, cid: string) {
    const cur = await t.one(`SELECT * FROM consultations WHERE id=$1`, [cid]);
    if (!cur) throw new NotFoundException('Consultation not found');
    if (cur.doctor_membership_id !== c.doctorMembershipId) throw new ForbiddenException('Only the treating doctor can change this consultation');
    if (cur.status === 'signed') throw new ConflictException({ message: 'This consultation is signed and cannot be changed. Add an addendum instead.', code: 'record_locked' });
    return cur;
  }

  async load(t: Tx, cid: string) {
    const r = await t.one(`SELECT c.*, u.full_name AS doctor_name, su.full_name AS signed_by_name,
        p.full_name AS patient_name, p.patient_number, p.date_of_birth, p.sex, p.allergies
      FROM consultations c JOIN memberships m ON m.id=c.doctor_membership_id JOIN users u ON u.id=m.user_id
      JOIN patients p ON p.id=c.patient_id LEFT JOIN users su ON su.id=c.signed_by WHERE c.id=$1`, [cid]);
    if (!r) throw new NotFoundException('Consultation not found');
    const tv = r.template_version_id ? await t.one(`SELECT id, version, schema FROM template_versions WHERE id=$1`, [r.template_version_id]) : null;
    const [diagnoses, addenda, prescriptions, documents] = await Promise.all([
      t.q(`SELECT id, code, description, is_primary FROM diagnoses WHERE consultation_id=$1 ORDER BY position`, [cid]),
      t.q(`SELECT a.id, a.body, a.created_at, u.full_name AS author FROM consultation_addenda a JOIN memberships m ON m.id=a.author_membership_id
           JOIN users u ON u.id=m.user_id WHERE a.consultation_id=$1 ORDER BY a.created_at`, [cid]),
      t.q(`SELECT id, status, issued_at, created_at FROM prescriptions WHERE consultation_id=$1 ORDER BY created_at`, [cid]),
      t.q(`SELECT id, title, kind, mime_type, created_at FROM medical_documents WHERE consultation_id=$1 AND deleted_at IS NULL ORDER BY created_at`, [cid]),
    ]);
    return { ...r, template: tv ? { versionId: tv.id, version: tv.version, schema: tv.schema } : null, diagnoses, addenda, prescriptions, documents };
  }
}
