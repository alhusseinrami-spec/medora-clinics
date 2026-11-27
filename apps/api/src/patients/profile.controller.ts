import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { CLINICAL_ITEM_KINDS, CLINICAL_ITEM_STATUSES, CONSENT_NEEDS_DETAIL, CONSENT_PURPOSES, MEASUREMENTS, MEASUREMENT_CODES, RECALL_LABS,
  TOOTH_CONDITIONS, TARGET_RANGES, isTooth, outOfRange } from '@medora/shared';
import { Db, Tx } from '../db/db.service.js';
import { Ctx, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';

const id = (x: string) => parse({ id: v.uuid() }, { id: x }).id;
const today = () => new Date().toISOString().slice(0, 10);

/**
 * The richer patient file: clinical summary, measurements and trends, factual reminders, body map, odontogram,
 * before/after photos, session packages and data-handling consents. Row-level security decides what each caller
 * sees; the permission on each route is the first gate.
 */
@Controller()
export class ProfileController {
  constructor(private db: Db) {}

  private async patient(t: Tx, pid: string) {
    const p = await t.one(`SELECT id, organization_id FROM patients WHERE id=$1`, [pid]);
    if (!p) throw new NotFoundException('Patient not found');
    return p;
  }

  /** Everything the top of the patient file shows, in one call. Clinical parts are left out without the history permission. */
  @RequirePerm('patient.file.read') @Get('patients/:id/summary')
  summary(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      await this.patient(t, id(pid));
      const next = await t.one(`SELECT a.starts_at, u.full_name AS doctor_name FROM appointments a JOIN memberships m ON m.id=a.doctor_membership_id
        JOIN users u ON u.id=m.user_id WHERE a.patient_id=$1 AND a.starts_at > now() AND a.status IN ('scheduled','confirmed') ORDER BY a.starts_at LIMIT 1`, [pid]);
      const packages = await t.q(`SELECT p.id, p.name, p.total_sessions,
          (SELECT count(*)::int FROM package_sessions s WHERE s.package_id=p.id AND s.voided_at IS NULL) AS used
        FROM patient_packages p WHERE p.patient_id=$1 AND p.closed_at IS NULL`, [pid]);
      const base = { nextAppointment: next ?? null, openPackages: packages };
      if (!c.permissions.has('patient.history.read')) return { ...base, restricted: true };

      const items = await t.q(`SELECT id, kind, label, detail, status, severity, code, started_on, ended_on, recorded_at
        FROM patient_clinical_items WHERE patient_id=$1 ORDER BY (status IN ('resolved','stopped')), recorded_at DESC`, [pid]);
      const latest = await t.q(`SELECT DISTINCT ON (code) code, value::float AS value, measured_on FROM patient_measurements
        WHERE patient_id=$1 AND removed_at IS NULL ORDER BY code, measured_on DESC, recorded_at DESC`, [pid]);
      const encounters = c.permissions.has('clinical_notes.read') ? await t.q(`SELECT cn.id, coalesce(cn.signed_at, cn.created_at) AS at, cn.chief_complaint, cn.status,
          u.full_name AS doctor_name FROM consultations cn JOIN memberships m ON m.id=cn.doctor_membership_id JOIN users u ON u.id=m.user_id
        WHERE cn.patient_id=$1 ORDER BY cn.created_at DESC LIMIT 4`, [pid]) : [];
      const current = (k: string) => items.filter((i: any) => i.kind === k && !['resolved', 'stopped'].includes(i.status));

      // Factual reminders, never advice: what is on file and how old the last value is.
      const reminders: { tone: 'danger' | 'warning' | 'info'; kind: string; text: string; params: Record<string, unknown> }[] = [];
      for (const a of current('allergy')) reminders.push({ tone: 'danger', kind: 'allergy', text: `${a.label}${a.detail ? ` — ${a.detail}` : ''}`, params: { severity: a.severity } });
      for (const m of latest) {
        const flag = outOfRange(m.code, m.value, TARGET_RANGES[m.code]);
        if (flag) reminders.push({ tone: 'warning', kind: flag === 'high' ? 'above_target' : 'below_target', text: m.code,
          params: { value: m.value, unit: MEASUREMENTS[m.code]?.unit ?? '', on: m.measured_on, target: TARGET_RANGES[m.code] } });
      }
      for (const m of latest.filter((x: any) => RECALL_LABS.includes(x.code))) {
        const months = Math.floor((Date.now() - Date.parse(m.measured_on)) / (30.44 * 86400e3));
        reminders.push({ tone: 'info', kind: 'last_recorded', text: m.code, params: { months, value: m.value, unit: MEASUREMENTS[m.code]?.unit ?? '' } });
      }
      for (const p of packages) if (p.total_sessions - p.used <= 2) reminders.push({ tone: 'info', kind: 'package_low', text: p.name, params: { left: p.total_sessions - p.used } });

      return {
        ...base, restricted: false,
        counts: { medications: current('medication').length, problems: current('problem').length, allergies: current('allergy').length },
        items, latest, encounters, reminders,
      };
    });
  }

  // ---------- Clinical items ----------
  @RequirePerm('patient.history.read') @Post('patients/:id/clinical-items')
  addItem(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ kind: v.enum(...CLINICAL_ITEM_KINDS), label: v.str(1, 200), detail: v.str(1, 1000).nullable(),
      status: v.enum('active', 'chronic', 'resolved', 'stopped').optional(), severity: v.enum('mild', 'moderate', 'severe').nullable(),
      code: v.str(1, 20).nullable(), startedOn: v.date().nullable() }, body);
    const status = b.status ?? 'active';
    if (!CLINICAL_ITEM_STATUSES[b.kind].includes(status)) throw new BadRequestException(`A ${b.kind} cannot be ${status}`);
    if (b.severity && b.kind !== 'allergy') throw new BadRequestException('Severity is for allergies');
    return this.db.tx(c, async (t) => {
      const p = await this.patient(t, id(pid));
      const r = await t.one(`INSERT INTO patient_clinical_items(organization_id,patient_id,kind,label,detail,status,severity,code,started_on,recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [p.organization_id, pid, b.kind, b.label.trim(), b.detail ?? null, status, b.severity ?? null, b.code ?? null, b.startedOn ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.clinical_item.add', 'patient', pid, { kind: b.kind, item: r.id });
      return r;
    });
  }

  @RequirePerm('patient.history.read') @Patch('clinical-items/:id')
  updateItem(@Param('id') iid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ status: v.enum('active', 'chronic', 'resolved', 'stopped').optional(), detail: v.str(1, 1000).nullable(),
      severity: v.enum('mild', 'moderate', 'severe').nullable(), label: v.str(1, 200).optional() }, body);
    return this.db.tx(c, async (t) => {
      const it = await t.one(`SELECT * FROM patient_clinical_items WHERE id=$1`, [id(iid)]);
      if (!it) throw new NotFoundException('Item not found');
      const status = b.status ?? it.status;
      if (!CLINICAL_ITEM_STATUSES[it.kind as keyof typeof CLINICAL_ITEM_STATUSES].includes(status)) throw new BadRequestException(`A ${it.kind} cannot be ${status}`);
      const ended = ['resolved', 'stopped'].includes(status) ? (it.ended_on ?? today()) : null;
      const r = await t.one(`UPDATE patient_clinical_items SET status=$2, detail=$3, severity=$4, label=$5, ended_on=$6, updated_by=$7, updated_at=now()
        WHERE id=$1 RETURNING *`, [it.id, status, b.detail === undefined ? it.detail : b.detail, b.severity === undefined ? it.severity : b.severity,
        b.label ?? it.label, ended, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.clinical_item.update', 'patient', it.patient_id, { item: it.id, status });
      return r;
    });
  }

  // ---------- Measurements ----------
  @RequirePerm('patient.history.read') @Get('patients/:id/measurements')
  measurements(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT m.id, m.code, m.value::float AS value, m.measured_on, m.note, u.full_name AS recorded_by
      FROM patient_measurements m JOIN users u ON u.id=m.recorded_by WHERE m.patient_id=$1 AND m.removed_at IS NULL
      ORDER BY m.code, m.measured_on, m.recorded_at`, [id(pid)]));
  }

  @RequirePerm('patient.history.read') @Post('patients/:id/measurements')
  addMeasurement(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ code: v.enum(...MEASUREMENT_CODES), value: v.num(-1e6, 1e6), measuredOn: v.date().optional(), note: v.str(1, 300).nullable() }, body);
    const def = MEASUREMENTS[b.code];
    if (b.value < def.min || b.value > def.max) throw new BadRequestException(`${def.label.en} must be between ${def.min} and ${def.max} ${def.unit}`);
    const on = b.measuredOn ?? today();
    if (on > today()) throw new BadRequestException('A measurement cannot be in the future');
    return this.db.tx(c, async (t) => {
      const p = await this.patient(t, id(pid));
      const r = await t.one(`INSERT INTO patient_measurements(organization_id,patient_id,code,value,measured_on,note,recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, code, value::float AS value, measured_on, note`, [p.organization_id, pid, b.code, b.value, on, b.note ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.measurement.add', 'patient', pid, { code: b.code });
      return r;
    });
  }

  @RequirePerm('patient.history.read') @Delete('measurements/:id')
  removeMeasurement(@Param('id') mid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.one(`UPDATE patient_measurements SET removed_at=now() WHERE id=$1 AND removed_at IS NULL RETURNING patient_id`, [id(mid)]);
      if (!r) throw new NotFoundException('Measurement not found');
      await audit(t, c.userId, c.orgId, 'patient.measurement.remove', 'patient', r.patient_id, { measurement: mid });
      return { ok: true };
    });
  }

  // ---------- Body map ----------
  @RequirePerm('patient.history.read') @Get('patients/:id/body-marks')
  bodyMarks(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT b.id, b.side, b.x::float AS x, b.y::float AS y, b.region, b.note, b.photo_document_id, b.recorded_at, u.full_name AS recorded_by
      FROM patient_body_marks b JOIN users u ON u.id=b.recorded_by WHERE b.patient_id=$1 AND b.removed_at IS NULL ORDER BY b.recorded_at`, [id(pid)]));
  }

  @RequirePerm('patient.history.read') @Post('patients/:id/body-marks')
  addBodyMark(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ side: v.enum('front', 'back'), x: v.num(0, 100), y: v.num(0, 100), region: v.str(1, 120), note: v.str(1, 2000).nullable(),
      photoDocumentId: v.uuid().nullable() }, body);
    return this.db.tx(c, async (t) => {
      const p = await this.patient(t, id(pid));
      if (b.photoDocumentId) await this.ownPhoto(t, b.photoDocumentId, pid);
      const r = await t.one(`INSERT INTO patient_body_marks(organization_id,patient_id,side,x,y,region,note,photo_document_id,recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [p.organization_id, pid, b.side, b.x, b.y, b.region.trim(), b.note ?? null, b.photoDocumentId ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.body_mark.add', 'patient', pid, { mark: r.id });
      return r;
    });
  }

  @RequirePerm('patient.history.read') @Delete('body-marks/:id')
  removeBodyMark(@Param('id') bid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.one(`UPDATE patient_body_marks SET removed_at=now(), removed_by=$2 WHERE id=$1 AND removed_at IS NULL RETURNING patient_id`, [id(bid), c.userId]);
      if (!r) throw new NotFoundException('Marker not found');
      await audit(t, c.userId, c.orgId, 'patient.body_mark.remove', 'patient', r.patient_id, { mark: bid });
      return { ok: true };
    });
  }

  private async ownPhoto(t: Tx, did: string, pid: string) {
    const d = await t.one(`SELECT patient_id, mime_type FROM medical_documents WHERE id=$1 AND deleted_at IS NULL`, [did]);
    if (!d || d.patient_id !== pid) throw new BadRequestException('That photo is not in this patient file');
    if (!String(d.mime_type).startsWith('image/')) throw new BadRequestException('Choose a photo (JPEG, PNG, WebP or HEIC)');
  }

  // ---------- Odontogram ----------
  @RequirePerm('patient.history.read') @Get('patients/:id/teeth')
  teeth(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT r.id, r.tooth, r.condition, r.surfaces, r.note, r.recorded_at, u.full_name AS recorded_by
      FROM patient_tooth_records r JOIN users u ON u.id=r.recorded_by WHERE r.patient_id=$1 ORDER BY r.tooth, r.recorded_at DESC`, [id(pid)]));
  }

  @RequirePerm('patient.history.read') @Post('patients/:id/teeth')
  addTooth(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ tooth: v.int(11, 85), condition: v.enum(...TOOTH_CONDITIONS), surfaces: v.str(1, 5).nullable(), note: v.str(1, 500).nullable() }, body);
    if (!isTooth(b.tooth)) throw new BadRequestException('Use FDI tooth numbers (11–48, or 51–85 for baby teeth)');
    const surfaces = b.surfaces ? b.surfaces.toUpperCase().replace(/[^MODBLIP]/g, '') || null : null;
    return this.db.tx(c, async (t) => {
      const p = await this.patient(t, id(pid));
      const r = await t.one(`INSERT INTO patient_tooth_records(organization_id,patient_id,tooth,condition,surfaces,note,recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, tooth, condition, surfaces, note, recorded_at`, [p.organization_id, pid, b.tooth, b.condition, surfaces, b.note ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.tooth.record', 'patient', pid, { tooth: b.tooth, condition: b.condition });
      return r;
    });
  }

  // ---------- Before / after photos ----------
  @RequirePerm('patient.history.read') @Get('patients/:id/photo-pairs')
  photoPairs(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT pp.id, pp.title, pp.note, pp.created_at, pp.before_document_id, pp.after_document_id,
        bd.created_at AS before_at, ad.created_at AS after_at, u.full_name AS created_by
      FROM patient_photo_pairs pp JOIN medical_documents bd ON bd.id=pp.before_document_id LEFT JOIN medical_documents ad ON ad.id=pp.after_document_id
      JOIN users u ON u.id=pp.created_by WHERE pp.patient_id=$1 AND pp.removed_at IS NULL ORDER BY pp.created_at DESC`, [id(pid)]));
  }

  @RequirePerm('patient.history.read') @Post('patients/:id/photo-pairs')
  addPhotoPair(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ title: v.str(1, 160), beforeDocumentId: v.uuid(), afterDocumentId: v.uuid().nullable(), note: v.str(1, 1000).nullable() }, body);
    if (b.afterDocumentId === b.beforeDocumentId) throw new BadRequestException('Choose two different photos');
    return this.db.tx(c, async (t) => {
      const p = await this.patient(t, id(pid));
      await this.ownPhoto(t, b.beforeDocumentId, pid);
      if (b.afterDocumentId) await this.ownPhoto(t, b.afterDocumentId, pid);
      const r = await t.one(`INSERT INTO patient_photo_pairs(organization_id,patient_id,title,before_document_id,after_document_id,note,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [p.organization_id, pid, b.title.trim(), b.beforeDocumentId, b.afterDocumentId ?? null, b.note ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.photo_pair.add', 'patient', pid, { pair: r.id });
      return r;
    });
  }

  @RequirePerm('patient.history.read') @Patch('photo-pairs/:id')
  updatePhotoPair(@Param('id') ppid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ afterDocumentId: v.uuid().optional(), note: v.str(1, 1000).nullable() }, body);
    return this.db.tx(c, async (t) => {
      const pp = await t.one(`SELECT * FROM patient_photo_pairs WHERE id=$1 AND removed_at IS NULL`, [id(ppid)]);
      if (!pp) throw new NotFoundException('Comparison not found');
      if (b.afterDocumentId) {
        if (b.afterDocumentId === pp.before_document_id) throw new BadRequestException('Choose a different photo for "after"');
        await this.ownPhoto(t, b.afterDocumentId, pp.patient_id);
      }
      await t.q(`UPDATE patient_photo_pairs SET after_document_id=$2, note=$3 WHERE id=$1`, [pp.id, b.afterDocumentId ?? pp.after_document_id, b.note === undefined ? pp.note : b.note]);
      await audit(t, c.userId, c.orgId, 'patient.photo_pair.update', 'patient', pp.patient_id, { pair: pp.id });
      return { ok: true };
    });
  }

  @RequirePerm('patient.history.read') @Delete('photo-pairs/:id')
  removePhotoPair(@Param('id') ppid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.one(`UPDATE patient_photo_pairs SET removed_at=now() WHERE id=$1 AND removed_at IS NULL RETURNING patient_id`, [id(ppid)]);
      if (!r) throw new NotFoundException('Comparison not found');
      await audit(t, c.userId, c.orgId, 'patient.photo_pair.remove', 'patient', r.patient_id, { pair: ppid });
      return { ok: true };
    });
  }

  // ---------- Session packages ----------
  @RequirePerm('patient.file.read') @Get('patients/:id/packages')
  packages(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const list = await t.q(`SELECT p.id, p.name, p.total_sessions, p.price::float AS price, p.currency, p.expires_on, p.note, p.created_at, p.closed_at,
          u.full_name AS created_by FROM patient_packages p JOIN users u ON u.id=p.created_by WHERE p.patient_id=$1 ORDER BY p.closed_at NULLS FIRST, p.created_at DESC`, [id(pid)]);
      const sessions = list.length ? await t.q(`SELECT s.id, s.package_id, s.used_at, s.note, s.voided_at, u.full_name AS recorded_by
        FROM package_sessions s JOIN users u ON u.id=s.recorded_by WHERE s.package_id = ANY($1::uuid[]) ORDER BY s.used_at`, [list.map((p: any) => p.id)]) : [];
      return list.map((p: any) => {
        const own = sessions.filter((s: any) => s.package_id === p.id);
        return { ...p, sessions: own, used: own.filter((s: any) => !s.voided_at).length };
      });
    });
  }

  @RequirePerm('patient.file.read') @Post('patients/:id/packages')
  addPackage(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(1, 120), totalSessions: v.int(1, 200), price: v.num(0, 1e9).nullable(), currency: v.enum('USD', 'LBP').optional(),
      expiresOn: v.date().nullable(), note: v.str(1, 500).nullable() }, body);
    return this.db.tx(c, async (t) => {
      const p = await this.patient(t, id(pid));
      const r = await t.one(`INSERT INTO patient_packages(organization_id,patient_id,name,total_sessions,price,currency,expires_on,note,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`, [p.organization_id, pid, b.name.trim(), b.totalSessions, b.price ?? null, b.currency ?? 'USD', b.expiresOn ?? null, b.note ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.package.add', 'patient', pid, { package: r.id, sessions: b.totalSessions });
      return r;
    });
  }

  @RequirePerm('appointment.manage') @Post('packages/:id/sessions') @HttpCode(200)
  useSession(@Param('id') pkid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ note: v.str(1, 300).nullable() }, body ?? {});
    return this.db.tx(c, async (t) => {
      const pk = await t.one(`SELECT id, patient_id, organization_id FROM patient_packages WHERE id=$1`, [id(pkid)]);
      if (!pk) throw new NotFoundException('Package not found');
      try {
        await t.q(`INSERT INTO package_sessions(organization_id,package_id,note,recorded_by) VALUES ($1,$2,$3,$4)`, [pk.organization_id, pk.id, b.note ?? null, c.userId]);
      } catch (e: any) {
        if (e.code === '23514') throw new ConflictException(e.message);
        throw e;
      }
      await audit(t, c.userId, c.orgId, 'patient.package.session', 'patient', pk.patient_id, { package: pk.id });
      return { ok: true };
    });
  }

  @RequirePerm('appointment.manage') @Post('package-sessions/:id/void') @HttpCode(200)
  voidSession(@Param('id') sid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.one(`UPDATE package_sessions SET voided_at=now(), voided_by=$2 WHERE id=$1 AND voided_at IS NULL RETURNING package_id`, [id(sid), c.userId]);
      if (!r) throw new NotFoundException('Session not found');
      await audit(t, c.userId, c.orgId, 'patient.package.session_void', 'package', r.package_id, { session: sid });
      return { ok: true };
    });
  }

  @RequirePerm('appointment.manage') @Post('packages/:id/close') @HttpCode(200)
  closePackage(@Param('id') pkid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.one(`UPDATE patient_packages SET closed_at=now() WHERE id=$1 AND closed_at IS NULL RETURNING patient_id`, [id(pkid)]);
      if (!r) throw new NotFoundException('Package not found or already closed');
      await audit(t, c.userId, c.orgId, 'patient.package.close', 'patient', r.patient_id, { package: pkid });
      return { ok: true };
    });
  }

  // ---------- Data-handling consents ----------
  /** Current answer per purpose (the latest record), plus the full history. */
  @RequirePerm('patient.file.read') @Get('patients/:id/data-consents')
  consents(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      await this.patient(t, id(pid));
      const history = await t.q(`SELECT dc.id, dc.purpose, dc.granted, dc.detail, dc.given_by, dc.recorded_at, u.full_name AS recorded_by
        FROM patient_data_consents dc JOIN users u ON u.id=dc.recorded_by WHERE dc.patient_id=$1 ORDER BY dc.recorded_at DESC`, [pid]);
      const current = CONSENT_PURPOSES.map((purpose) => history.find((h: any) => h.purpose === purpose) ?? { purpose, granted: null });
      return { current, history };
    });
  }

  @RequirePerm('patient.register') @Post('patients/:id/data-consents')
  recordConsent(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ purpose: v.enum(...CONSENT_PURPOSES), granted: v.bool(), detail: v.str(1, 300).nullable(), givenBy: v.str(2, 160) }, body);
    if (b.granted && CONSENT_NEEDS_DETAIL.includes(b.purpose) && !b.detail) throw new BadRequestException('Name the person this consent is for');
    return this.db.tx(c, async (t) => {
      const p = await this.patient(t, id(pid));
      const r = await t.one(`INSERT INTO patient_data_consents(organization_id,patient_id,purpose,granted,detail,given_by,recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [p.organization_id, pid, b.purpose, b.granted, b.detail ?? null, b.givenBy.trim(), c.userId]);
      await audit(t, c.userId, c.orgId, 'patient.data_consent', 'patient', pid, { purpose: b.purpose, granted: b.granted });
      return r;
    });
  }
}
