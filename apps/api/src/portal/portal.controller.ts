import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Module, NotFoundException, Param, Post, Query, Res, StreamableFile } from '@nestjs/common';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import { Db } from '../db/db.service.js';
import { config } from '../config.js';
import { Auth, Ctx, Public, RequirePerm } from '../common/decorators.js';
import type { AuthInfo, TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { newToken, sha256 } from '../common/crypto.js';
import { readDecrypted } from '../clinical/storage.js';
import { queueAppointmentEvent } from '../comm/events.js';
import { PushService, vapidKeys } from './push.js';

const uid = (x: string) => parse({ id: v.uuid() }, { id: x }).id;

/** The patient's own app. Every read and write goes through portal_* database functions that check the account link. */
@Controller('portal')
export class PortalController {
  constructor(private db: Db) {}
  private tx<T>(a: AuthInfo, sql: string, params: unknown[] = []) { return this.db.tx({ userId: a.userId }, (t) => t.q<T>(sql, params)); }

  @Get('me')
  async me(@Auth() a: AuthInfo) {
    const records = await this.tx(a, `SELECT * FROM portal_records()`);
    return { records };
  }

  @Get('appointments')
  appointments(@Auth() a: AuthInfo) { return this.tx(a, `SELECT * FROM portal_appointments()`); }

  @Post('appointments/:id/cancel') @HttpCode(200)
  async cancel(@Param('id') id: string, @Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ reason: v.str(1, 300).nullable() }, body);
    const r = await this.db.tx({ userId: a.userId }, (t) => t.one(`SELECT portal_cancel_appointment($1,$2) AS ok`, [uid(id), b.reason ?? null]));
    if (!r?.ok) throw new NotFoundException('Appointment not found');
    return { ok: true };
  }

  @Get('requests')
  requests(@Auth() a: AuthInfo) { return this.tx(a, `SELECT * FROM portal_requests()`); }

  @Get('doctors')
  doctors(@Query('patient') patient: string, @Auth() a: AuthInfo) { return this.tx(a, `SELECT * FROM portal_doctors($1)`, [uid(patient)]); }

  @Post('requests')
  async request(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ patientId: v.uuid(), doctorMembershipId: v.uuid().nullable(), preferredDate: v.date(), preferredTime: v.enum('morning', 'afternoon', 'evening', 'any'), note: v.str(1, 500).nullable() }, body);
    const r = await this.db.tx({ userId: a.userId }, (t) => t.one(`SELECT portal_request_appointment($1,$2,$3,$4,$5) AS id`,
      [b.patientId, b.doctorMembershipId ?? null, b.preferredDate, b.preferredTime, b.note ?? null]));
    return { id: r.id };
  }

  @Post('requests/:id/cancel') @HttpCode(200)
  async cancelRequest(@Param('id') id: string, @Auth() a: AuthInfo) {
    const r = await this.db.tx({ userId: a.userId }, (t) => t.one(`SELECT portal_cancel_request($1) AS ok`, [uid(id)]));
    if (!r?.ok) throw new ConflictException('This request was already answered');
    return { ok: true };
  }

  @Get('prescriptions')
  prescriptions(@Auth() a: AuthInfo) { return this.tx(a, `SELECT * FROM portal_prescriptions()`); }

  @Get('documents')
  documents(@Auth() a: AuthInfo) { return this.tx(a, `SELECT * FROM portal_documents()`); }

  @Get('documents/:id/content')
  async content(@Param('id') id: string, @Query('download') download: string, @Auth() a: AuthInfo, @Res({ passthrough: true }) res: Response) {
    const d = await this.db.tx({ userId: a.userId }, (t) => t.one(`SELECT * FROM portal_document_file($1,$2)`, [uid(id), !!download]));
    if (!d) throw new NotFoundException('Document not found');
    const bytes = await readDecrypted(d.storage_key);
    res.set({ 'Content-Type': d.mime_type ?? 'application/octet-stream', 'Cache-Control': 'private, no-store',
      'Content-Disposition': `${download ? 'attachment' : 'inline'}; filename="${String(d.filename).replace(/[^\w.\- ]/g, '_')}"` });
    return new StreamableFile(bytes);
  }

  @Post('profile') @HttpCode(200)
  async profile(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ patientId: v.uuid(), phone: v.str(5, 30).nullable(), whatsappNumber: v.str(5, 30).nullable(), email: v.email().nullable(),
      address: v.str(2, 300).nullable(), preferredLanguage: v.enum('en', 'fr', 'ar').optional(), whatsappConsent: v.bool().optional() }, body);
    const r = await this.db.tx({ userId: a.userId }, (t) => t.one(`SELECT portal_update_profile($1,$2,$3,$4,$5,$6,$7) AS ok`,
      [b.patientId, b.phone ?? null, b.whatsappNumber ?? null, b.email ?? null, b.address ?? null, b.preferredLanguage ?? null, b.whatsappConsent ?? null]));
    if (!r?.ok) throw new NotFoundException('Patient record not found');
    return this.me(a);
  }

  // ---------- Invitations (the patient side) ----------
  @Public() @Get('invitations/:token')
  async preview(@Param('token') token: string) {
    const r = await this.db.tx({}, (t) => t.one(`SELECT * FROM portal_invitation_preview($1)`, [sha256(token)]));
    if (!r) throw new NotFoundException('Invitation not found');
    return r;
  }

  @Post('invitations/:token/accept') @HttpCode(200)
  async accept(@Param('token') token: string, @Auth() a: AuthInfo) {
    const r = await this.db.tx({ userId: a.userId }, (t) => t.one(`SELECT portal_accept_invitation($1) AS patient_id`, [sha256(token)]));
    return { patientId: r.patient_id };
  }
}

/** Staff side: portal access for a patient, and answering appointment requests. */
@Controller()
export class PortalStaffController {
  constructor(private db: Db) {}

  @RequirePerm('patient.file.read') @Get('patients/:id/portal')
  status(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => ({
      account: (await t.one(`SELECT pa.id, pa.created_at, i.email FROM patient_accounts pa
        LEFT JOIN patient_portal_invitations i ON i.patient_id=pa.patient_id AND i.accepted_by=pa.user_id
        WHERE pa.patient_id=$1 AND pa.revoked_at IS NULL ORDER BY i.accepted_at DESC NULLS LAST LIMIT 1`, [uid(pid)])) ?? null,
      invitations: await t.q(`SELECT id, email, expires_at, accepted_at, created_at FROM patient_portal_invitations WHERE patient_id=$1 ORDER BY created_at DESC LIMIT 5`, [pid]),
    }));
  }

  /** Creates a portal invitation. Email delivery is not connected, so the link is returned for staff to share (e.g. on WhatsApp). */
  @RequirePerm('patient.register') @Post('patients/:id/portal/invitations')
  invite(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ email: v.email() }, body);
    return this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT id FROM patients WHERE id=$1 AND organization_id=$2`, [uid(pid), c.orgId]);
      if (!p) throw new NotFoundException('Patient not found');
      const token = newToken();
      const r = await t.one(`INSERT INTO patient_portal_invitations(organization_id, patient_id, email, token_hash, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, expires_at`,
        [c.orgId, pid, b.email, sha256(token), c.userId]);
      await audit(t, c.userId, c.orgId, 'portal.invite', 'patient', pid, { email: b.email });
      return { ...r, inviteUrl: `${config.webBaseUrl}/portal/invite/${token}`, emailDelivery: config.emailProviderConfigured ? 'queued' : 'awaiting_credentials' };
    });
  }

  @RequirePerm('patient.register') @Delete('patients/:id/portal')
  revoke(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.q(`UPDATE patient_accounts SET revoked_at=now(), revoked_by=$2 WHERE patient_id=$1 AND revoked_at IS NULL RETURNING id`, [uid(pid), c.userId]);
      if (!r.length) throw new NotFoundException('No active portal access');
      await audit(t, c.userId, c.orgId, 'portal.revoke', 'patient', pid);
      return { ok: true };
    });
  }

  @RequirePerm('appointment.manage') @Get('appointment-requests')
  list(@Ctx() c: TenantInfo, @Query('status') status?: string) {
    const q = parse({ status: v.enum('pending', 'accepted', 'declined', 'cancelled').optional() }, { status });
    return this.db.tx(c, (t) => t.q(`SELECT r.id, r.status, r.preferred_date, r.preferred_time, r.note, r.answer_note, r.created_at, r.doctor_membership_id,
        p.id AS patient_id, p.full_name AS patient_name, p.patient_number, p.phone, u.full_name AS doctor_name, a.starts_at AS appointment_starts_at
      FROM appointment_requests r JOIN patients p ON p.id=r.patient_id LEFT JOIN memberships m ON m.id=r.doctor_membership_id LEFT JOIN users u ON u.id=m.user_id
      LEFT JOIN appointments a ON a.id=r.appointment_id
      WHERE r.organization_id=$1 AND r.status=$2 ORDER BY r.preferred_date, r.created_at LIMIT 200`, [c.orgId, q.status ?? 'pending']));
  }

  /** Accepting books the visit at the time staff choose (double booking is refused by the database) and tells the patient. */
  @RequirePerm('appointment.manage') @Post('appointment-requests/:id/accept') @HttpCode(200)
  accept(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ startsAt: v.datetime(), durationMinutes: v.int(5, 480).optional(), doctorMembershipId: v.uuid(), note: v.str(1, 300).nullable() }, body);
    if (!c.actingDoctors.includes(b.doctorMembershipId) && !c.orgWide) throw new BadRequestException('You cannot book for this doctor');
    return this.db.tx(c, async (t) => {
      const r = await t.one(`SELECT * FROM appointment_requests WHERE id=$1 AND organization_id=$2 AND status='pending'`, [uid(id), c.orgId]);
      if (!r) throw new ConflictException('This request was already answered or withdrawn');
      const doc = await t.one(`SELECT department_id FROM memberships WHERE id=$1 AND organization_id=$2 AND role_code='doctor' AND status='active'`, [b.doctorMembershipId, c.orgId]);
      if (!doc) throw new BadRequestException('Choose a doctor of this workspace');
      await t.q(`INSERT INTO patient_memberships(patient_id, membership_id, linked_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [r.patient_id, b.doctorMembershipId, c.userId]);
      const aid = randomUUID(); const start = new Date(b.startsAt); const end = new Date(start.getTime() + (b.durationMinutes ?? 20) * 60000);
      await t.q(`INSERT INTO appointments(id, organization_id, doctor_membership_id, patient_id, starts_at, ends_at, department_id, notes, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confirmed',$9)`, [aid, c.orgId, b.doctorMembershipId, r.patient_id, start.toISOString(), end.toISOString(), doc.department_id, r.note, c.userId]);
      await t.q(`UPDATE appointment_requests SET status='accepted', appointment_id=$2, answer_note=$3, answered_by=$4, answered_at=now() WHERE id=$1`, [id, aid, b.note ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'appointment_request.accept', 'appointment_request', id, { appointment: aid });
      await queueAppointmentEvent(t, 'confirmation', aid);
      return { ok: true, appointmentId: aid };
    });
  }

  @RequirePerm('appointment.manage') @Post('appointment-requests/:id/decline') @HttpCode(200)
  decline(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ note: v.str(2, 300) }, body);
    return this.db.tx(c, async (t) => {
      const r = await t.q(`UPDATE appointment_requests SET status='declined', answer_note=$2, answered_by=$3, answered_at=now() WHERE id=$1 AND organization_id=$4 AND status='pending' RETURNING id`,
        [uid(id), b.note, c.userId, c.orgId]);
      if (!r.length) throw new ConflictException('This request was already answered or withdrawn');
      await audit(t, c.userId, c.orgId, 'appointment_request.decline', 'appointment_request', id);
      return { ok: true };
    });
  }
}

/** Push subscriptions for the signed-in user (staff or patient). */
@Controller('push')
export class PushController {
  constructor(private db: Db) {}

  @Public() @Get('key')
  key() { const k = vapidKeys(); return { publicKey: k?.publicKey ?? null, enabled: !!k }; }

  @Post('subscriptions')
  async subscribe(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ endpoint: v.str(10, 1000), keys: v.object({ p256dh: v.str(20, 200), auth: v.str(8, 100) }), userAgent: v.str(1, 300).nullable() }, body);
    if (!/^https:\/\//.test(b.endpoint) && config.isProd) throw new BadRequestException('Push endpoints must use https');
    await this.db.tx({ userId: a.userId }, async (t) => {
      await t.q(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [b.endpoint]);
      await t.q(`INSERT INTO push_subscriptions(user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5)`, [a.userId, b.endpoint, b.keys.p256dh, b.keys.auth, b.userAgent ?? null]);
    });
    return { ok: true };
  }

  @Post('subscriptions/remove') @HttpCode(200)
  async unsubscribe(@Body() body: unknown, @Auth() a: AuthInfo) {
    const b = parse({ endpoint: v.str(10, 1000) }, body);
    await this.db.tx({ userId: a.userId }, (t) => t.q(`DELETE FROM push_subscriptions WHERE endpoint=$1`, [b.endpoint]));
    return { ok: true };
  }
}

@Module({ controllers: [PortalController, PortalStaffController, PushController], providers: [PushService], exports: [PushService] })
export class PortalModule {}
