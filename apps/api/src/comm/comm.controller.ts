import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Module, NotFoundException, Param, Patch, Post, Put, Query } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { Ctx, RequireAnyPerm, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { decryptSecret, encryptSecret } from '../common/crypto.js';
import { AUTOMATED, PURPOSES, TEMPLATE_PARAMS, WaError, checkNumber, sendText, toWaNumber } from './whatsapp.js';
import { CommWorker } from './worker.js';
import { WebhookController } from './webhook.controller.js';

const uid = (x: string) => parse({ id: v.uuid() }, { id: x }).id;
const DEFAULT_OFFSETS: Record<string, number | null> = { reminder_24h: -1440, reminder_2h: -120 };
const ACCOUNT_COLS = `a.id, a.membership_id, a.phone_number_id, a.display_number, a.waba_id, a.status, a.last_error, a.connected_at, a.created_at, a.is_active,
  u.full_name AS doctor_name`;

@Controller()
export class CommController {
  constructor(private db: Db, private worker: CommWorker) {}

  // ---------- Numbers ----------
  @RequirePerm('whatsapp.send') @Get('whatsapp/accounts')
  accounts(@Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT ${ACCOUNT_COLS} FROM whatsapp_accounts a LEFT JOIN memberships m ON m.id=a.membership_id LEFT JOIN users u ON u.id=m.user_id
      WHERE a.organization_id=$1 ORDER BY a.is_active DESC, a.membership_id NULLS FIRST, a.created_at`, [c.orgId]));
  }

  /** Saves a number's Meta ids and token (encrypted). It stays "awaiting credentials" until the connection test passes. */
  @RequirePerm('whatsapp.send') @Post('whatsapp/accounts')
  async addAccount(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ phoneNumberId: v.str(5, 40), displayNumber: v.str(5, 40), wabaId: v.str(5, 40).nullable(), accessToken: v.str(20, 1000), membershipId: v.uuid().nullable() }, body);
    if (!/^\d+$/.test(b.phoneNumberId)) throw new BadRequestException('The phone number id is the numeric id shown in Meta\'s WhatsApp Manager');
    // In an independent practice the number belongs to the doctor.
    let member = b.membershipId ?? null;
    if (c.orgKind === 'independent_practice') member = c.memberships.find((m) => m.role_code === 'doctor')?.id ?? member;
    if (member === null && !c.permissions.has('org.manage')) throw new ForbiddenException('Connecting the workspace number needs the workspace management permission');
    if (member && !c.permissions.has('org.manage') && !c.memberships.some((m) => m.id === member)) throw new ForbiddenException('You can connect your own number only');
    const r = await this.db.tx(c, async (t) => {
      const doc = member ? await t.one(`SELECT id FROM memberships WHERE id=$1 AND organization_id=$2 AND role_code='doctor' AND status='active'`, [member, c.orgId]) : true;
      if (!doc) throw new BadRequestException('Choose a doctor of this workspace');
      const clash = await t.one(`SELECT 1 AS x FROM whatsapp_accounts WHERE organization_id=$1 AND is_active AND membership_id IS NOT DISTINCT FROM $2`, [c.orgId, member]);
      if (clash) throw new ConflictException('A number is already connected here. Deactivate it first.');
      const row = await t.one(`INSERT INTO whatsapp_accounts(organization_id, membership_id, phone_number_id, display_number, waba_id, access_token_enc, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [c.orgId, member, b.phoneNumberId, b.displayNumber, b.wabaId ?? null, encryptSecret(b.accessToken), c.userId])
        .catch((e) => { if (e.code === '23505') throw new ConflictException('This Meta phone number id is already connected to a workspace'); throw e; });
      await audit(t, c.userId, c.orgId, 'whatsapp.account_add', 'whatsapp_account', row.id, { membership: member, phoneNumberId: b.phoneNumberId });
      return row.id as string;
    });
    return this.testAccount(r, c);
  }

  @RequirePerm('whatsapp.send') @Patch('whatsapp/accounts/:id')
  async updateAccount(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ displayNumber: v.str(5, 40).optional(), wabaId: v.str(5, 40).nullable(), accessToken: v.str(20, 1000).optional(), isActive: v.bool().optional() }, body);
    await this.db.tx(c, async (t) => {
      const cur = await t.one(`SELECT id FROM whatsapp_accounts WHERE id=$1 AND organization_id=$2`, [uid(id), c.orgId]);
      if (!cur) throw new NotFoundException('Number not found');
      const sets: string[] = []; const vals: unknown[] = [id];
      const add = (col: string, val: unknown) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
      if (b.displayNumber !== undefined) add('display_number', b.displayNumber);
      if (b.wabaId !== undefined) add('waba_id', b.wabaId);
      if (b.accessToken !== undefined) { add('access_token_enc', encryptSecret(b.accessToken)); add('status', 'awaiting_credentials'); }
      if (b.isActive === false) { add('is_active', false); add('status', 'disconnected'); }
      if (!sets.length) throw new BadRequestException('Nothing to update');
      const n = await t.q(`UPDATE whatsapp_accounts SET ${sets.join(', ')} WHERE id=$1 RETURNING id`, vals);
      if (!n.length) throw new ForbiddenException('You cannot change this number');
      await audit(t, c.userId, c.orgId, 'whatsapp.account_update', 'whatsapp_account', id, { fields: Object.keys(b), tokenChanged: b.accessToken !== undefined });
    });
    return b.accessToken !== undefined ? this.testAccount(id, c) : this.account(id, c);
  }

  /** Asks Meta whether the id and token are valid. Only a successful answer marks the number connected. */
  @RequirePerm('whatsapp.send') @Post('whatsapp/accounts/:id/test') @HttpCode(200)
  async testAccount(@Param('id') id: string, @Ctx() c: TenantInfo) {
    const acc = await this.db.tx(c, async (t) => {
      const a = await t.one(`SELECT id, phone_number_id, is_active FROM whatsapp_accounts WHERE id=$1 AND organization_id=$2`, [uid(id), c.orgId]);
      if (!a) throw new NotFoundException('Number not found');
      return { ...a, token: (await t.one(`SELECT comm_account_token($1) AS t`, [id])).t };
    });
    if (!acc.is_active) throw new ConflictException('This number is deactivated');
    let status = 'connected', error: string | null = null;
    try { await checkNumber(acc.phone_number_id, decryptSecret(acc.token)); } catch (e) { status = 'awaiting_credentials'; error = e instanceof WaError ? e.message.slice(0, 300) : 'Connection test failed'; }
    await this.db.tx(c, async (t) => {
      await t.q(`UPDATE whatsapp_accounts SET status=$2, last_error=$3, connected_at=CASE WHEN $2='connected' THEN now() ELSE connected_at END WHERE id=$1`, [id, status, error]);
      await audit(t, c.userId, c.orgId, 'whatsapp.account_test', 'whatsapp_account', id, { status });
    });
    return this.account(id, c);
  }

  private account(id: string, c: TenantInfo) {
    return this.db.tx(c, (t) => t.one(`SELECT ${ACCOUNT_COLS} FROM whatsapp_accounts a LEFT JOIN memberships m ON m.id=a.membership_id LEFT JOIN users u ON u.id=m.user_id WHERE a.id=$1`, [id]));
  }

  // ---------- Templates ----------
  @RequirePerm('whatsapp.send') @Get('whatsapp/templates')
  templates(@Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const rows = await t.q(`SELECT p.purpose, p.language, p.body AS default_body, o.body AS custom_body, o.meta_template_name, o.updated_at
        FROM message_templates p LEFT JOIN message_templates o ON o.organization_id=$1 AND o.purpose=p.purpose AND o.language=p.language
        WHERE p.organization_id IS NULL ORDER BY p.purpose, p.language`, [c.orgId]);
      return rows.map((r) => ({ ...r, params: TEMPLATE_PARAMS[r.purpose as keyof typeof TEMPLATE_PARAMS] }));
    });
  }

  @RequirePerm('whatsapp.send', 'template.manage') @Put('whatsapp/templates/:purpose/:language')
  saveTemplate(@Param('purpose') purpose: string, @Param('language') language: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const p = parse({ purpose: v.enum(...PURPOSES), language: v.enum('en', 'fr', 'ar') }, { purpose, language });
    const b = parse({ body: v.str(5, 1000), metaTemplateName: v.str(1, 512).nullable() }, body);
    if (b.metaTemplateName && !/^[a-z0-9_]+$/.test(b.metaTemplateName)) throw new BadRequestException('Meta template names use lowercase letters, digits and underscores');
    return this.db.tx(c, async (t) => {
      await t.q(`INSERT INTO message_templates(organization_id, purpose, language, body, meta_template_name, updated_by) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (coalesce(organization_id, '00000000-0000-0000-0000-000000000000'::uuid), purpose, language)
        DO UPDATE SET body=EXCLUDED.body, meta_template_name=EXCLUDED.meta_template_name, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [c.orgId, p.purpose, p.language, b.body, b.metaTemplateName ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'whatsapp.template_save', 'message_template', null, { purpose: p.purpose, language: p.language });
      return { ok: true };
    });
  }

  @RequirePerm('whatsapp.send', 'template.manage') @Delete('whatsapp/templates/:purpose/:language')
  resetTemplate(@Param('purpose') purpose: string, @Param('language') language: string, @Ctx() c: TenantInfo) {
    const p = parse({ purpose: v.enum(...PURPOSES), language: v.enum('en', 'fr', 'ar') }, { purpose, language });
    return this.db.tx(c, async (t) => {
      await t.q(`DELETE FROM message_templates WHERE organization_id=$1 AND purpose=$2 AND language=$3`, [c.orgId, p.purpose, p.language]);
      return { ok: true };
    });
  }

  // ---------- Automation ----------
  @RequirePerm('whatsapp.send') @Get('whatsapp/automation')
  automation(@Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const rows = await t.q(`SELECT purpose, enabled, offset_minutes, follow_up_days, send_hour, updated_at FROM automation_settings WHERE organization_id=$1`, [c.orgId]);
      return AUTOMATED.map((p) => rows.find((r) => r.purpose === p) ?? { purpose: p, enabled: false, offset_minutes: DEFAULT_OFFSETS[p] ?? null,
        follow_up_days: p === 'follow_up' ? 2 : null, send_hour: p === 'follow_up' ? 10 : null, updated_at: null });
    });
  }

  @RequirePerm('whatsapp.send', 'org.manage') @Put('whatsapp/automation/:purpose')
  setAutomation(@Param('purpose') purpose: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const p = parse({ purpose: v.enum(...AUTOMATED) }, { purpose }).purpose;
    const b = parse({ enabled: v.bool(), offsetMinutes: v.int(-10080, -30).nullable(), followUpDays: v.int(0, 30).nullable(), sendHour: v.int(0, 23).nullable() }, body);
    const offset = p.startsWith('reminder') ? (b.offsetMinutes ?? DEFAULT_OFFSETS[p]) : null;
    return this.db.tx(c, async (t) => {
      await t.q(`INSERT INTO automation_settings(organization_id, purpose, enabled, offset_minutes, follow_up_days, send_hour, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (organization_id, purpose) DO UPDATE SET enabled=EXCLUDED.enabled, offset_minutes=EXCLUDED.offset_minutes, follow_up_days=EXCLUDED.follow_up_days,
        send_hour=EXCLUDED.send_hour, updated_by=EXCLUDED.updated_by, updated_at=now()`,
        [c.orgId, p, b.enabled, offset, p === 'follow_up' ? (b.followUpDays ?? 2) : null, p === 'follow_up' ? (b.sendHour ?? 10) : null, c.userId]);
      await audit(t, c.userId, c.orgId, 'whatsapp.automation', 'automation_settings', null, { purpose: p, enabled: b.enabled });
      return (await t.one(`SELECT purpose, enabled, offset_minutes, follow_up_days, send_hour, updated_at FROM automation_settings WHERE organization_id=$1 AND purpose=$2`, [c.orgId, p]));
    });
  }

  // ---------- Consent ----------
  @RequirePerm('patient.file.read') @Get('patients/:id/consent')
  consent(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT id, phone, whatsapp_number, preferred_language FROM patients WHERE id=$1 AND organization_id=$2`, [uid(pid), c.orgId]);
      if (!p) throw new NotFoundException('Patient not found');
      const cur = await t.one(`SELECT opted_in, source, recorded_at FROM patient_consents WHERE patient_id=$1 AND channel='whatsapp'`, [pid]);
      const history = await t.q(`SELECT e.opted_in, e.source, e.created_at, u.full_name AS recorded_by_name FROM consent_events e LEFT JOIN users u ON u.id=e.recorded_by
        WHERE e.patient_id=$1 AND e.channel='whatsapp' ORDER BY e.created_at DESC LIMIT 20`, [pid]);
      return { whatsapp: cur ?? null, number: toWaNumber(p.whatsapp_number || p.phone), language: p.preferred_language, history };
    });
  }

  @RequireAnyPerm('patient.register', 'whatsapp.send') @Put('patients/:id/consent')
  async setConsent(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ optedIn: v.bool() }, body);
    await this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT id FROM patients WHERE id=$1 AND organization_id=$2`, [uid(pid), c.orgId]);
      if (!p) throw new NotFoundException('Patient not found');
      await t.q(`INSERT INTO patient_consents(patient_id, organization_id, channel, opted_in, source, recorded_by) VALUES ($1,$2,'whatsapp',$3,'staff',$4)
        ON CONFLICT (patient_id, channel) DO UPDATE SET opted_in=EXCLUDED.opted_in, source='staff', recorded_by=EXCLUDED.recorded_by, recorded_at=now()`, [pid, c.orgId, b.optedIn, c.userId]);
      if (!b.optedIn && c.permissions.has('whatsapp.send')) await t.q(`UPDATE scheduled_messages SET status='cancelled', reason='opted_out' WHERE patient_id=$1 AND status='pending'`, [pid]);
      await audit(t, c.userId, c.orgId, b.optedIn ? 'consent.whatsapp_in' : 'consent.whatsapp_out', 'patient', pid);
    });
    return this.consent(pid, c);
  }

  // ---------- Sending to one patient ----------
  @RequirePerm('whatsapp.send') @Get('patients/:id/messages')
  patientMessages(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT s.id, s.purpose, s.status, s.reason, s.send_at, s.processed_at, s.created_at, u.full_name AS created_by_name, m.status AS delivery
      FROM scheduled_messages s LEFT JOIN users u ON u.id=s.created_by LEFT JOIN whatsapp_messages m ON m.id=s.message_id
      WHERE s.patient_id=$1 ORDER BY s.created_at DESC LIMIT 100`, [uid(pid)]));
  }

  @RequirePerm('whatsapp.send') @Post('patients/:id/messages')
  async sendToPatient(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ purpose: v.enum('follow_up', 'vaccination', 'treatment', 'payment', 'announcement'), message: v.str(1, 600).nullable(),
      invoiceId: v.uuid().nullable(), consultationId: v.uuid().nullable(), date: v.date().nullable() }, body);
    if (b.purpose === 'announcement' && !b.message) throw new BadRequestException('Write the message');
    if (b.purpose === 'payment' && !b.invoiceId) throw new BadRequestException('Choose the invoice');
    if (b.purpose === 'vaccination' && !b.date) throw new BadRequestException('Enter the date the vaccination is due');
    const id = await this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT id FROM patients WHERE id=$1 AND organization_id=$2`, [uid(pid), c.orgId]);
      if (!p) throw new NotFoundException('Patient not found');
      if (b.purpose === 'follow_up' && !b.consultationId && !b.date) throw new BadRequestException('Enter the follow-up date');
      if (b.consultationId && !(await t.one(`SELECT 1 AS x FROM consultations WHERE id=$1 AND patient_id=$2`, [b.consultationId, pid]))) throw new BadRequestException('Consultation not found');
      if (b.invoiceId && !(await t.one(`SELECT 1 AS x FROM invoices WHERE id=$1 AND patient_id=$2 AND status='issued'`, [b.invoiceId, pid]))) throw new BadRequestException('Invoice not found');
      const r = await t.one(`INSERT INTO scheduled_messages(organization_id, purpose, patient_id, invoice_id, consultation_id, message, about_date, send_at, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,now(),$8) RETURNING id`, [c.orgId, b.purpose, pid, b.invoiceId ?? null, b.consultationId ?? null, b.message ?? null, b.date ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'whatsapp.queue', 'patient', pid, { purpose: b.purpose });
      return r.id as string;
    });
    await this.worker.tick();
    return this.db.tx(c, (t) => t.one(`SELECT id, purpose, status, reason, send_at, processed_at FROM scheduled_messages WHERE id=$1`, [id]));
  }

  /** General announcement to every patient of the workspace who agreed to WhatsApp messages. */
  @RequirePerm('whatsapp.send', 'org.manage') @Post('whatsapp/announcements')
  async announce(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ message: v.str(5, 600) }, body);
    const n = await this.db.tx(c, async (t) => {
      const rows = await t.q(`INSERT INTO scheduled_messages(organization_id, purpose, patient_id, message, send_at, created_by)
        SELECT $1, 'announcement', p.id, $2, now(), $3 FROM patients p JOIN patient_consents pc ON pc.patient_id=p.id AND pc.channel='whatsapp' AND pc.opted_in
        WHERE p.organization_id=$1 AND p.archived_at IS NULL RETURNING id`, [c.orgId, b.message, c.userId]);
      await audit(t, c.userId, c.orgId, 'whatsapp.announcement', 'organization', c.orgId, { recipients: rows.length });
      return rows.length;
    });
    this.worker.tick().catch(() => undefined);
    return { queued: n };
  }

  // ---------- Outbox ----------
  @RequirePerm('whatsapp.send') @Get('whatsapp/queue')
  queue(@Ctx() c: TenantInfo, @Query('status') status?: string) {
    const q = parse({ status: v.enum('pending', 'sent', 'skipped', 'failed', 'cancelled').optional() }, { status });
    return this.db.tx(c, (t) => t.q(`SELECT s.id, s.purpose, s.status, s.reason, s.send_at, s.processed_at, s.created_at, p.id AS patient_id, p.full_name AS patient_name,
        u.full_name AS created_by_name, m.status AS delivery
      FROM scheduled_messages s JOIN patients p ON p.id=s.patient_id LEFT JOIN users u ON u.id=s.created_by LEFT JOIN whatsapp_messages m ON m.id=s.message_id
      WHERE s.organization_id=$1 AND ($2::text IS NULL OR s.status=$2) ORDER BY s.send_at DESC LIMIT 200`, [c.orgId, q.status ?? null]));
  }

  @RequirePerm('whatsapp.send') @Delete('whatsapp/queue/:id')
  cancelQueued(@Param('id') id: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const r = await t.q(`UPDATE scheduled_messages SET status='cancelled', reason='cancelled_by_staff' WHERE id=$1 AND status='pending' RETURNING id`, [uid(id)]);
      if (!r.length) throw new ConflictException('Only a message that is still waiting can be cancelled');
      await audit(t, c.userId, c.orgId, 'whatsapp.cancel', 'scheduled_message', id);
      return { ok: true };
    });
  }

  // ---------- Inbox ----------
  /** People who can be assigned a conversation: active members holding the WhatsApp permission. */
  @RequirePerm('whatsapp.send') @Get('whatsapp/team')
  team(@Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT m.id, u.full_name, m.role_code FROM memberships m JOIN users u ON u.id=m.user_id
      JOIN membership_permissions mp ON mp.membership_id=m.id AND mp.permission_code='whatsapp.send'
      WHERE m.organization_id=$1 AND m.status='active' ORDER BY u.full_name`, [c.orgId]));
  }

  @RequirePerm('whatsapp.send') @Get('whatsapp/conversations')
  conversations(@Ctx() c: TenantInfo, @Query('filter') filter?: string, @Query('patient') patient?: string) {
    const f = parse({ filter: v.enum('unanswered', 'mine', 'open', 'closed', 'all').optional(), patient: v.uuid().optional() }, { filter, patient });
    const mine = c.memberships.map((m) => m.id);
    const where = { unanswered: `cv.status='open' AND cv.last_inbound_at IS NOT NULL AND (cv.last_outbound_at IS NULL OR cv.last_outbound_at < cv.last_inbound_at)`,
      mine: `cv.assigned_to = ANY($2::uuid[])`, open: `cv.status='open'`, closed: `cv.status='closed'`, all: 'true' }[f.filter ?? 'open'];
    return this.db.tx(c, (t) => t.q(`SELECT cv.id, cv.contact_number, cv.status, cv.unread, cv.last_message_at, cv.last_inbound_at, cv.last_outbound_at, cv.assigned_to,
        p.id AS patient_id, p.full_name AS patient_name, p.patient_number, au.full_name AS assigned_name, a.display_number,
        (SELECT body FROM whatsapp_messages m WHERE m.conversation_id=cv.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
        (cv.last_inbound_at > now() - interval '24 hours') AS window_open
      FROM whatsapp_conversations cv JOIN whatsapp_accounts a ON a.id=cv.account_id LEFT JOIN patients p ON p.id=cv.patient_id
      LEFT JOIN memberships am ON am.id=cv.assigned_to LEFT JOIN users au ON au.id=am.user_id
      WHERE cv.organization_id=$1 AND ${where} AND cardinality($2::uuid[]) >= 0 AND ($3::uuid IS NULL OR cv.patient_id=$3) ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 200`, [c.orgId, mine, f.patient ?? null]));
  }

  @RequirePerm('whatsapp.send') @Get('whatsapp/conversations/:id')
  conversation(@Param('id') id: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const cv = await t.one(`SELECT cv.*, p.full_name AS patient_name, p.patient_number, a.display_number, (cv.last_inbound_at > now() - interval '24 hours') AS window_open
        FROM whatsapp_conversations cv JOIN whatsapp_accounts a ON a.id=cv.account_id LEFT JOIN patients p ON p.id=cv.patient_id WHERE cv.id=$1 AND cv.organization_id=$2`, [uid(id), c.orgId]);
      if (!cv) throw new NotFoundException('Conversation not found');
      if (cv.unread) await t.q(`UPDATE whatsapp_conversations SET unread=0 WHERE id=$1`, [id]);
      cv.messages = await t.q(`SELECT m.id, m.direction, m.body, m.status, m.error, m.purpose, m.created_at, m.status_at, u.full_name AS sent_by_name
        FROM whatsapp_messages m LEFT JOIN users u ON u.id=m.sent_by WHERE m.conversation_id=$1 ORDER BY m.created_at`, [id]);
      return cv;
    });
  }

  /** Free-text reply. Meta allows it only within 24 hours of the patient's last message; otherwise send a template. */
  @RequirePerm('whatsapp.send') @Post('whatsapp/conversations/:id/reply')
  async reply(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ body: v.str(1, 4000) }, body);
    const cv = await this.db.tx(c, async (t) => {
      const r = await t.one(`SELECT cv.id, cv.contact_number, cv.account_id, a.phone_number_id, a.status AS account_status, (cv.last_inbound_at > now() - interval '24 hours') AS window_open
        FROM whatsapp_conversations cv JOIN whatsapp_accounts a ON a.id=cv.account_id WHERE cv.id=$1 AND cv.organization_id=$2`, [uid(id), c.orgId]);
      if (!r) throw new NotFoundException('Conversation not found');
      return { ...r, token: (await t.one(`SELECT comm_account_token($1) AS t`, [r.account_id])).t };
    });
    if (!cv.window_open) throw new ConflictException({ message: 'More than 24 hours since the patient last wrote. Meta only allows an approved template now.', code: 'window_closed' });
    if (cv.account_status !== 'connected' || !cv.token) throw new ConflictException({ message: 'This WhatsApp number is not connected', code: 'not_connected' });
    let metaId: string | null = null, status = 'sent', error: string | null = null;
    try { metaId = await sendText(cv.phone_number_id, decryptSecret(cv.token), cv.contact_number, b.body); } catch (e) { status = 'failed'; error = e instanceof WaError ? e.message.slice(0, 300) : 'send_error'; }
    return this.db.tx(c, async (t) => {
      const m = (await t.one(`SELECT comm_record_reply($1,$2,$3,$4,$5) AS id`, [id, b.body, metaId, status, error])).id;
      await audit(t, c.userId, c.orgId, 'whatsapp.reply', 'whatsapp_conversation', id, { status });
      return t.one(`SELECT id, direction, body, status, error, created_at FROM whatsapp_messages WHERE id=$1`, [m]);
    });
  }

  @RequirePerm('whatsapp.send') @Patch('whatsapp/conversations/:id')
  updateConversation(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ assignedTo: v.uuid().nullable(), status: v.enum('open', 'closed').optional(), patientId: v.uuid().nullable() }, body);
    return this.db.tx(c, async (t) => {
      const cur = await t.one(`SELECT id FROM whatsapp_conversations WHERE id=$1 AND organization_id=$2`, [uid(id), c.orgId]);
      if (!cur) throw new NotFoundException('Conversation not found');
      if (b.assignedTo && !(await t.one(`SELECT 1 AS x FROM memberships m JOIN membership_permissions mp ON mp.membership_id=m.id AND mp.permission_code='whatsapp.send'
          WHERE m.id=$1 AND m.organization_id=$2 AND m.status='active'`, [b.assignedTo, c.orgId]))) throw new BadRequestException('Choose a team member who handles WhatsApp');
      if (b.patientId && !(await t.one(`SELECT 1 AS x FROM patients WHERE id=$1 AND organization_id=$2`, [b.patientId, c.orgId]))) throw new BadRequestException('Patient not found');
      const sets: string[] = []; const vals: unknown[] = [id];
      const add = (col: string, val: unknown) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
      if (b.assignedTo !== undefined) add('assigned_to', b.assignedTo);
      if (b.status !== undefined) add('status', b.status);
      if (b.patientId !== undefined) add('patient_id', b.patientId);
      if (!sets.length) throw new BadRequestException('Nothing to update');
      await t.q(`UPDATE whatsapp_conversations SET ${sets.join(', ')} WHERE id=$1`, vals);
      await audit(t, c.userId, c.orgId, 'whatsapp.conversation_update', 'whatsapp_conversation', id, b);
      return { ok: true };
    });
  }
}

@Module({ controllers: [CommController, WebhookController], providers: [CommWorker], exports: [CommWorker] })
export class CommModule {}
