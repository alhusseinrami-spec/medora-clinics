import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Module, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { validateData, type TemplateSchema } from '@medora/shared';
import { Db, Tx } from '../db/db.service.js';
import { Ctx, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { SpecialtyModule, } from '../specialty/specialty.controller.js';
import { SpecialtyService } from '../specialty/specialty.service.js';

const id = (x: string) => parse({ id: v.uuid() }, { id: x }).id;

const PROFILE = {
  fullName: v.str(2, 160), dateOfBirth: v.date().nullable(), sex: v.enum('female', 'male', 'other', 'unknown').nullable(),
  phone: v.str(5, 30).nullable(), whatsappNumber: v.str(5, 30).nullable(), email: v.email().nullable(), address: v.str(2, 300).nullable(),
  emergencyContact: v.object({ name: v.str(1, 120), phone: v.str(5, 30), relation: v.str(1, 60).optional() }).nullable(),
  bloodType: v.enum('A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-').nullable(), allergies: v.str(1, 2000).nullable(),
  chronicDiseases: v.str(1, 2000).nullable(), currentMedications: v.str(1, 2000).nullable(), medicalHistory: v.str(1, 5000).nullable(),
  nationalId: v.str(2, 60).nullable(), preferredLanguage: v.enum('en', 'ar', 'fr').optional(),
};
const COLS: Record<string, string> = {
  fullName: 'full_name', dateOfBirth: 'date_of_birth', sex: 'sex', phone: 'phone', whatsappNumber: 'whatsapp_number', email: 'email',
  address: 'address', emergencyContact: 'emergency_contact', bloodType: 'blood_type', allergies: 'allergies', chronicDiseases: 'chronic_diseases',
  currentMedications: 'current_medications', medicalHistory: 'medical_history', nationalId: 'national_id', preferredLanguage: 'preferred_language',
};
const HISTORY_COLS = ['allergies', 'chronic_diseases', 'current_medications', 'medical_history', 'blood_type'];

@Controller('patients')
export class PatientsController {
  constructor(private db: Db, private spec: SpecialtyService) {}

  /** Search by name (fuzzy), phone digits or patient number. Row-level security limits results to patients the caller may see. */
  @RequirePerm('patient.file.read') @Get()
  search(@Ctx() c: TenantInfo, @Query('q') q = '', @Query('limit') limit = '30') {
    const term = String(q).trim().slice(0, 100);
    const lim = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const digits = term.replace(/\D/g, '');
    return this.db.tx(c, (t) => t.q(`SELECT p.id, p.patient_number, p.full_name, p.date_of_birth, p.sex, p.phone, p.created_at,
        (SELECT min(a.starts_at) FROM appointments a WHERE a.patient_id=p.id AND a.starts_at > now() AND a.status NOT IN ('cancelled','no_show')) AS next_appointment
      FROM patients p
      WHERE p.organization_id=$1 AND p.archived_at IS NULL AND (
        $2 = '' OR lower(p.full_name) LIKE '%' || lower($2) || '%' OR similarity(lower(p.full_name), lower($2)) > 0.3
        OR upper(p.patient_number) = upper($2)
        OR (length($3) >= 4 AND regexp_replace(coalesce(p.phone,'') || ' ' || coalesce(p.whatsapp_number,''), '\\D', '', 'g') LIKE '%' || $3 || '%'))
      ORDER BY CASE WHEN $2 = '' THEN 0 ELSE similarity(lower(p.full_name), lower($2)) END DESC, p.full_name LIMIT $4`, [c.orgId, term, digits, lim]));
  }

  @RequirePerm('patient.register') @Post('duplicates')
  duplicates(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ fullName: v.str(2, 160), phone: v.str(5, 30).optional(), dateOfBirth: v.date().optional() }, body);
    return this.db.tx(c, (t) => t.q(`SELECT * FROM app_find_duplicate_patients($1,$2,$3)`, [b.fullName, b.phone ?? null, b.dateOfBirth ?? null]));
  }

  /**
   * Emergency access: a doctor covering for a colleague opens a file that is private to another doctor, for
   * 12 hours, by naming the patient exactly (patient number or phone) and giving a reason. Recorded and
   * shown to the clinic's owners and admins.
   */
  @RequirePerm('clinical_notes.read') @Post('emergency-access')
  emergency(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ query: v.str(3, 40), reason: v.str(5, 500) }, body);
    if (!c.doctorMembershipId) throw new ForbiddenException('Only doctors can open a file in an emergency');
    return this.db.tx(c, async (t) => {
      const r = await t.one(`SELECT app_emergency_open($1, $2) AS id`, [b.query, b.reason]);
      if (!r?.id) throw new NotFoundException('No single patient matches that patient number or phone');
      const p = await t.one(`SELECT id, full_name, patient_number FROM patients WHERE id=$1`, [r.id]);
      return { ...p, expiresInHours: 12 };
    });
  }

  /** Registers a patient and links them to the treating doctor. Possible duplicates must be confirmed first. */
  @RequirePerm('patient.register') @Post()
  create(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ ...PROFILE, doctorMembershipId: v.uuid().optional(), confirmNotDuplicate: v.bool().optional() }, body);
    return this.db.tx(c, async (t) => {
      if (!b.confirmNotDuplicate) {
        const dups = await t.q(`SELECT * FROM app_find_duplicate_patients($1,$2,$3)`, [b.fullName, b.phone ?? null, b.dateOfBirth ?? null]);
        if (dups.length) throw new ConflictException({ message: 'Possible duplicate patient', code: 'possible_duplicate', duplicates: dups });
      }
      let doctor = b.doctorMembershipId ?? null;
      if (!doctor) doctor = c.doctorMembershipId ?? (c.actingDoctors.length === 1 ? c.actingDoctors[0] : null);
      if (!doctor && !c.orgWide) throw new BadRequestException('Choose the doctor this patient is registered with');
      const pid = randomUUID();
      const fields = Object.keys(COLS).filter((k) => (b as any)[k] !== undefined);
      const vals = fields.map((k) => (k === 'emergencyContact' && (b as any)[k] ? JSON.stringify((b as any)[k]) : (b as any)[k]));
      await t.q(`INSERT INTO patients(id, organization_id, created_by, ${fields.map((k) => COLS[k]).join(',')})
        VALUES ($1,$2,$3,${fields.map((_, i) => `$${i + 4}`).join(',')})`, [pid, c.orgId, c.userId, ...vals]);
      if (doctor) await t.q(`INSERT INTO patient_memberships(patient_id,membership_id,linked_by) VALUES ($1,$2,$3)`, [pid, doctor, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.create', 'patient', pid, { doctor });
      return this.load(t, c, pid);
    });
  }

  private async load(t: Tx, c: TenantInfo, pid: string) {
    const p = await t.one(`SELECT * FROM patients WHERE id=$1`, [pid]);
    if (!p) throw new NotFoundException('Patient not found');
    if (!c.permissions.has('patient.history.read')) for (const k of HISTORY_COLS) delete p[k];
    p.doctors = await t.q(`SELECT m.id AS membership_id, u.full_name, m.specialty_code FROM patient_memberships pm
      JOIN memberships m ON m.id=pm.membership_id JOIN users u ON u.id=m.user_id WHERE pm.patient_id=$1`, [pid]);
    return p;
  }

  @RequirePerm('patient.file.read') @Get(':id')
  get(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const p = await this.load(t, c, id(pid));
      await audit(t, c.userId, c.orgId, 'patient.view', 'patient', pid);
      return p;
    });
  }

  @RequirePerm('patient.register') @Patch(':id')
  update(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const shape = Object.fromEntries(Object.entries(PROFILE).map(([k, r]) => [k, (r as any).isOptional ? r : (r as any).optional()]));
    const b = parse(shape as typeof PROFILE, body) as Record<string, unknown>;
    const fields = Object.keys(b).filter((k) => b[k] !== undefined);
    if (fields.some((k) => HISTORY_COLS.includes(COLS[k])) && !c.permissions.has('patient.history.read')) throw new ForbiddenException('Changing medical history needs the medical history permission');
    if (!fields.length) throw new BadRequestException('Nothing to update');
    return this.db.tx(c, async (t) => {
      const vals = fields.map((k) => (k === 'emergencyContact' && b[k] ? JSON.stringify(b[k]) : b[k]));
      const r = await t.q(`UPDATE patients SET ${fields.map((k, i) => `${COLS[k]}=$${i + 2}`).join(', ')}, updated_at=now() WHERE id=$1 RETURNING id`, [id(pid), ...vals]);
      if (!r.length) throw new NotFoundException('Patient not found');
      await audit(t, c.userId, c.orgId, 'patient.update', 'patient', pid, { fields });
      return this.load(t, c, pid);
    });
  }

  /** Controlled record linking inside a center (audited). */
  @RequirePerm('patient.register') @Post(':id/links')
  link(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ doctorMembershipId: v.uuid() }, body);
    return this.db.tx(c, async (t) => {
      await t.q(`INSERT INTO patient_memberships(patient_id,membership_id,linked_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [id(pid), b.doctorMembershipId, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.link', 'patient', pid, { doctor: b.doctorMembershipId });
      return this.load(t, c, pid);
    });
  }

  /** Specialty section of the patient file, rendered with the template version it was saved under. */
  @RequirePerm('patient.history.read') @Get(':id/specialty')
  specialty(@Param('id') pid: string, @Ctx() c: TenantInfo, @Query('doctor') doctor?: string) {
    return this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT id, date_of_birth FROM patients WHERE id=$1`, [id(pid)]);
      if (!p) throw new NotFoundException('Patient not found');
      const d = await this.spec.resolveDoctor(t, c, doctor || undefined);
      const current = await this.spec.effective(t, d.id, d.specialty, 'patient_profile');
      const saved = await t.one(`SELECT sp.data, sp.template_version_id, sp.updated_at, u.full_name AS updated_by, v.schema, v.version
        FROM patient_specialty_profiles sp JOIN template_versions v ON v.id=sp.template_version_id LEFT JOIN users u ON u.id=sp.updated_by
        WHERE sp.patient_id=$1 AND sp.specialty_code=$2`, [pid, d.specialty]);
      return {
        specialty: d.specialty, dateOfBirth: p.date_of_birth, current,
        saved: saved ? { data: saved.data, versionId: saved.template_version_id, version: saved.version, schema: saved.schema, updatedAt: saved.updated_at, updatedBy: saved.updated_by } : null,
      };
    });
  }

  @RequirePerm('patient.history.read') @Put(':id/specialty')
  saveSpecialty(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ data: v.any(), doctorMembershipId: v.uuid().optional() }, body);
    return this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT id FROM patients WHERE id=$1`, [id(pid)]);
      if (!p) throw new NotFoundException('Patient not found');
      const d = await this.spec.resolveDoctor(t, c, b.doctorMembershipId);
      const tpl = await this.spec.effective(t, d.id, d.specialty, 'patient_profile');
      const res = validateData(tpl.schema as TemplateSchema, b.data);
      if (!res.ok) throw new BadRequestException({ message: 'Some fields are not valid', errors: res.errors.map((e) => `${e.path}: ${e.message}`), fieldErrors: res.errors });
      await t.q(`INSERT INTO patient_specialty_profiles(organization_id,patient_id,specialty_code,template_version_id,data,updated_by)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (patient_id,specialty_code)
        DO UPDATE SET template_version_id=EXCLUDED.template_version_id, data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [c.orgId, pid, d.specialty, tpl.versionId, JSON.stringify(res.value), c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.specialty_update', 'patient', pid, { specialty: d.specialty, version: tpl.version });
      return { data: res.value, versionId: tpl.versionId, version: tpl.version };
    });
  }

  /** Chronological timeline. Clinical rows appear only when row-level security lets the caller read them. */
  @RequirePerm('patient.file.read') @Get(':id/timeline')
  timeline(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT id, created_at FROM patients WHERE id=$1`, [id(pid)]);
      if (!p) throw new NotFoundException('Patient not found');
      return t.q(`SELECT * FROM (
          SELECT 'registered' AS kind, created_at AS at, NULL::uuid AS ref, NULL AS status, NULL AS doctor FROM patients WHERE id=$1
          UNION ALL
          SELECT 'appointment', a.starts_at, a.id, a.status, u.full_name FROM appointments a
            JOIN memberships m ON m.id=a.doctor_membership_id JOIN users u ON u.id=m.user_id WHERE a.patient_id=$1
          UNION ALL
          SELECT 'specialty_profile', sp.updated_at, sp.id, sp.specialty_code, u.full_name FROM patient_specialty_profiles sp
            LEFT JOIN users u ON u.id=sp.updated_by WHERE sp.patient_id=$1
          UNION ALL
          SELECT 'consultation', coalesce(cn.signed_at, cn.created_at), cn.id, cn.status, u.full_name FROM consultations cn
            JOIN memberships m ON m.id=cn.doctor_membership_id JOIN users u ON u.id=m.user_id WHERE cn.patient_id=$1
          UNION ALL
          SELECT 'prescription', coalesce(r.issued_at, r.created_at), r.id, r.status, u.full_name FROM prescriptions r
            JOIN memberships m ON m.id=r.prescribed_by JOIN users u ON u.id=m.user_id WHERE r.patient_id=$1
          UNION ALL
          SELECT 'document', d.created_at, d.id, d.kind, u.full_name FROM medical_documents d
            LEFT JOIN users u ON u.id=d.uploaded_by WHERE d.patient_id=$1 AND d.deleted_at IS NULL
        ) x ORDER BY at DESC`, [pid]);
    });
  }
}

@Module({ imports: [SpecialtyModule], controllers: [PatientsController] })
export class PatientsModule {}
