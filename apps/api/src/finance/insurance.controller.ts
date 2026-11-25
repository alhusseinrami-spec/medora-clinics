import { BadRequestException, Body, ConflictException, Controller, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Db, Tx } from '../db/db.service.js';
import { Ctx, RequireAnyPerm, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';
import { convert, round2, uid } from './invoices.controller.js';

const POLICY = {
  providerId: v.uuid(), policyNumber: v.str(1, 80), memberName: v.str(1, 160).nullable(), relationship: v.str(1, 60).nullable(),
  coveragePercent: v.num(0, 100).nullable(), annualCeiling: v.num(0, 1e12).nullable(), coveredServices: v.str(1, 2000).nullable(),
  nonCoveredServices: v.str(1, 2000).nullable(), notes: v.str(1, 2000).nullable(), validFrom: v.date().nullable(), validUntil: v.date().nullable(),
  cardDocumentId: v.uuid().nullable(), isActive: v.bool().optional(),
};
const POLICY_COLS: Record<string, string> = {
  providerId: 'provider_id', policyNumber: 'policy_number', memberName: 'member_name', relationship: 'relationship', coveragePercent: 'coverage_percent',
  annualCeiling: 'annual_ceiling', coveredServices: 'covered_services', nonCoveredServices: 'non_covered_services', notes: 'notes',
  validFrom: 'valid_from', validUntil: 'valid_until', cardDocumentId: 'card_document_id', isActive: 'is_active',
};

/**
 * Insurance: a directory of insurers, patient policies, and claims prepared from invoices.
 * No insurer is connected electronically: claims are prepared and tracked here, and submitted by the clinic.
 */
@Controller()
export class InsuranceController {
  constructor(private db: Db) {}

  @RequireAnyPerm('insurance.manage', 'patient.register', 'payment.register') @Get('insurance/providers')
  providers(@Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT id, name, kind, phone, email, notes, is_active, organization_id IS NULL AS platform FROM insurance_providers
      WHERE organization_id IS NULL OR organization_id=$1 ORDER BY organization_id IS NOT NULL, name`, [c.orgId]));
  }

  @RequirePerm('insurance.manage') @Post('insurance/providers')
  addProvider(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 160), kind: v.enum('nssf', 'private', 'other'), phone: v.str(3, 40).nullable(), email: v.email().nullable(), notes: v.str(1, 1000).nullable() }, body);
    return this.db.tx(c, async (t) => {
      const r = await t.one(`INSERT INTO insurance_providers(organization_id, name, kind, phone, email, notes) VALUES ($1,$2,$3,$4,$5,$6)
        RETURNING id, name, kind, phone, email, notes, is_active, false AS platform`, [c.orgId, b.name, b.kind, b.phone ?? null, b.email ?? null, b.notes ?? null]);
      await audit(t, c.userId, c.orgId, 'insurance.provider_create', 'insurance_provider', r.id);
      return r;
    });
  }

  @RequirePerm('insurance.manage') @Patch('insurance/providers/:id')
  updateProvider(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ name: v.str(2, 160).optional(), phone: v.str(3, 40).nullable(), email: v.email().nullable(), notes: v.str(1, 1000).nullable(), isActive: v.bool().optional() }, body);
    return this.db.tx(c, async (t) => {
      const r = await t.one(`UPDATE insurance_providers SET name=coalesce($2,name), phone=CASE WHEN $7 THEN $3 ELSE phone END, email=CASE WHEN $8 THEN $4 ELSE email END,
          notes=CASE WHEN $9 THEN $5 ELSE notes END, is_active=coalesce($6,is_active)
        WHERE id=$1 AND organization_id=$10 RETURNING id, name, kind, phone, email, notes, is_active`,
        [uid(id), b.name ?? null, b.phone ?? null, b.email ?? null, b.notes ?? null, b.isActive ?? null, b.phone !== undefined, b.email !== undefined, b.notes !== undefined, c.orgId]);
      if (!r) throw new NotFoundException('Insurer not found in this workspace (the platform directory cannot be edited)');
      await audit(t, c.userId, c.orgId, 'insurance.provider_update', 'insurance_provider', id);
      return r;
    });
  }

  // ---------- Policies ----------
  @RequirePerm('patient.file.read') @Get('patients/:id/policies')
  policies(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT ip.*, pr.name AS provider_name, pr.kind AS provider_kind, d.title AS card_title
      FROM insurance_policies ip JOIN insurance_providers pr ON pr.id=ip.provider_id LEFT JOIN medical_documents d ON d.id=ip.card_document_id
      WHERE ip.patient_id=$1 ORDER BY ip.is_active DESC, ip.created_at DESC`, [uid(pid)]));
  }

  @RequireAnyPerm('insurance.manage', 'patient.register') @Post('patients/:id/policies')
  addPolicy(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse(POLICY, body) as Record<string, unknown>;
    return this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT id FROM patients WHERE id=$1 AND organization_id=$2`, [uid(pid), c.orgId]);
      if (!p) throw new NotFoundException('Patient not found');
      await this.checkCard(t, b.cardDocumentId as string | null | undefined, pid);
      const keys = Object.keys(POLICY_COLS).filter((k) => b[k] !== undefined);
      const r = await t.one(`INSERT INTO insurance_policies(organization_id, patient_id, created_by, ${keys.map((k) => POLICY_COLS[k]).join(',')})
        VALUES ($1,$2,$3,${keys.map((_, i) => `$${i + 4}`).join(',')}) RETURNING id`, [c.orgId, pid, c.userId, ...keys.map((k) => b[k])]);
      await audit(t, c.userId, c.orgId, 'insurance.policy_create', 'insurance_policy', r.id, { patient: pid });
      return this.policy(t, r.id);
    });
  }

  @RequireAnyPerm('insurance.manage', 'patient.register') @Patch('policies/:id')
  updatePolicy(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const shape = Object.fromEntries(Object.entries(POLICY).map(([k, r]) => [k, (r as any).isOptional ? r : (r as any).optional()]));
    const b = parse(shape as typeof POLICY, body) as Record<string, unknown>;
    const keys = Object.keys(POLICY_COLS).filter((k) => b[k] !== undefined);
    if (!keys.length) throw new BadRequestException('Nothing to update');
    return this.db.tx(c, async (t) => {
      const cur = await t.one(`SELECT patient_id FROM insurance_policies WHERE id=$1`, [uid(id)]);
      if (!cur) throw new NotFoundException('Policy not found');
      await this.checkCard(t, b.cardDocumentId as string | null | undefined, cur.patient_id);
      await t.q(`UPDATE insurance_policies SET ${keys.map((k, i) => `${POLICY_COLS[k]}=$${i + 2}`).join(', ')} WHERE id=$1`, [id, ...keys.map((k) => b[k])]);
      await audit(t, c.userId, c.orgId, 'insurance.policy_update', 'insurance_policy', id, { fields: keys });
      return this.policy(t, id);
    });
  }

  // ---------- Claims ----------
  @RequirePerm('insurance.manage') @Get('claims')
  claims(@Ctx() c: TenantInfo, @Query('status') status?: string) {
    const q = parse({ status: v.enum('draft', 'submitted', 'approved', 'partially_approved', 'rejected', 'reimbursed').optional() }, { status });
    return this.db.tx(c, (t) => t.q(`SELECT cl.id, cl.status, cl.amount_claimed, cl.amount_approved, cl.claim_number, cl.submitted_at, cl.decided_at, cl.reimbursed_at, cl.created_at,
        i.invoice_number, i.currency, p.full_name AS patient_name, p.patient_number, pr.name AS provider_name, pol.policy_number
      FROM claims cl JOIN invoices i ON i.id=cl.invoice_id JOIN patients p ON p.id=i.patient_id JOIN insurance_policies pol ON pol.id=cl.policy_id
      JOIN insurance_providers pr ON pr.id=pol.provider_id
      WHERE cl.organization_id=$1 AND ($2::text IS NULL OR cl.status=$2) ORDER BY cl.created_at DESC LIMIT 300`, [c.orgId, q.status ?? null]));
  }

  /**
   * Prepares a claim from an issued invoice. Without an amount, it claims the policy's coverage percentage of
   * the lines marked as covered by insurance.
   */
  @RequirePerm('insurance.manage') @Post('claims')
  createClaim(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ invoiceId: v.uuid(), policyId: v.uuid(), amountClaimed: v.num(0.01, 1e12).optional(), notes: v.str(1, 2000).nullable() }, body);
    return this.db.tx(c, async (t) => {
      const inv = await t.one(`SELECT i.id, i.status, i.kind, i.patient_id, i.currency, b.total, b.credited, b.covered_subtotal FROM invoices i
        JOIN invoice_balances b ON b.invoice_id=i.id WHERE i.id=$1`, [b.invoiceId]);
      if (!inv) throw new NotFoundException('Invoice not found');
      if (inv.status !== 'issued' || inv.kind !== 'invoice') throw new ConflictException('Claims are prepared from issued invoices');
      const pol = await t.one(`SELECT id, patient_id, coverage_percent, is_active, valid_until FROM insurance_policies WHERE id=$1`, [b.policyId]);
      if (!pol || pol.patient_id !== inv.patient_id) throw new BadRequestException('That policy is not this patient\'s');
      if (!pol.is_active) throw new BadRequestException('That policy is not active');
      const open = await t.one(`SELECT coalesce(sum(coalesce(amount_approved, amount_claimed)),0) AS s FROM claims WHERE invoice_id=$1 AND status <> 'rejected'`, [inv.id]);
      const max = round2(Number(inv.total) - Number(inv.credited) - Number(open.s));
      const suggested = round2(Number(inv.covered_subtotal) * Number(pol.coverage_percent ?? 0) / 100);
      const amount = b.amountClaimed ?? suggested;
      if (!(amount > 0)) throw new BadRequestException('Mark the covered lines on the invoice, set the policy coverage, or enter the amount to claim');
      if (amount > max + 0.004) throw new BadRequestException(`At most ${max} ${inv.currency} can still be claimed on this invoice`);
      const r = await t.one(`INSERT INTO claims(organization_id, invoice_id, policy_id, amount_claimed, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [c.orgId, inv.id, pol.id, amount, b.notes ?? null, c.userId]);
      await audit(t, c.userId, c.orgId, 'claim.create', 'claim', r.id, { invoice: inv.id, amount });
      return this.claim(t, r.id);
    });
  }

  @RequirePerm('insurance.manage') @Get('claims/:id')
  get(@Param('id') id: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => this.claim(t, uid(id)));
  }

  @RequirePerm('insurance.manage') @Post('claims/:id/submit')
  submit(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ claimNumber: v.str(1, 80).nullable() }, body);
    return this.db.tx(c, async (t) => {
      await t.q(`UPDATE claims SET status='submitted', submitted_at=now(), claim_number=coalesce($2, claim_number) WHERE id=$1`, [uid(id), b.claimNumber ?? null]);
      await audit(t, c.userId, c.orgId, 'claim.submit', 'claim', id);
      return this.claim(t, id);
    });
  }

  /** Records the insurer's answer. */
  @RequirePerm('insurance.manage') @Post('claims/:id/decision')
  decide(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ status: v.enum('approved', 'partially_approved', 'rejected'), amountApproved: v.num(0, 1e12).optional(), reason: v.str(1, 1000).nullable(), claimNumber: v.str(1, 80).nullable() }, body);
    return this.db.tx(c, async (t) => {
      const cur = await t.one(`SELECT amount_claimed FROM claims WHERE id=$1`, [uid(id)]);
      if (!cur) throw new NotFoundException('Claim not found');
      let approved: number | null = null;
      if (b.status === 'approved') approved = b.amountApproved ?? Number(cur.amount_claimed);
      if (b.status === 'partially_approved') {
        if (b.amountApproved === undefined) throw new BadRequestException('Enter the approved amount');
        approved = b.amountApproved;
      }
      if (approved !== null && approved > Number(cur.amount_claimed) + 0.004) throw new BadRequestException('The approved amount is more than was claimed');
      if (b.status === 'rejected' && !b.reason) throw new BadRequestException('Enter the rejection reason');
      await t.q(`UPDATE claims SET status=$2, amount_approved=$3, rejection_reason=$4, decided_at=now(), claim_number=coalesce($5, claim_number) WHERE id=$1`,
        [id, b.status, approved, b.status === 'rejected' ? b.reason : null, b.claimNumber ?? null]);
      await audit(t, c.userId, c.orgId, `claim.${b.status}`, 'claim', id, { approved });
      return this.claim(t, id);
    });
  }

  /** The insurer paid: records an insurance payment on the invoice (with a receipt) and closes the claim. */
  @RequirePerm('insurance.manage') @Post('claims/:id/reimburse')
  reimburse(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ amount: v.num(0.01, 1e12), currency: v.enum('USD', 'LBP'), reference: v.str(1, 120).nullable() }, body);
    return this.db.tx(c, async (t) => {
      const cl = await t.one(`SELECT cl.id, cl.status, cl.amount_approved, cl.invoice_id, i.currency FROM claims cl JOIN invoices i ON i.id=cl.invoice_id WHERE cl.id=$1`, [uid(id)]);
      if (!cl) throw new NotFoundException('Claim not found');
      if (!['approved', 'partially_approved'].includes(cl.status)) throw new ConflictException('Record the insurer\'s approval first');
      const rate = Number((await t.one(`SELECT app_current_rate($1) AS r`, [c.orgId])).r);
      if (convert(b.amount, b.currency, cl.currency, rate) > Number(cl.amount_approved) + (cl.currency === 'LBP' ? 1000 : 0.01)) throw new BadRequestException('That is more than the approved amount');
      const p = await t.one(`INSERT INTO payments(organization_id, invoice_id, method_code, amount, currency, lbp_per_usd, received_by, reference, claim_id)
        VALUES ($1,$2,'insurance',$3,$4,$5,$6,$7,$8) RETURNING id, receipt_number`, [c.orgId, cl.invoice_id, b.amount, b.currency, rate, c.userId, b.reference ?? null, cl.id]);
      await t.q(`UPDATE claims SET status='reimbursed', reimbursed_at=now(), reimbursed_payment_id=$2 WHERE id=$1`, [id, p.id]);
      await audit(t, c.userId, c.orgId, 'claim.reimbursed', 'claim', id, { payment: p.id, amount: b.amount, currency: b.currency });
      return this.claim(t, id);
    });
  }

  /** Attaches a document from the patient's file (report, lab result, insurance card) to the claim. */
  @RequirePerm('insurance.manage') @Post('claims/:id/documents')
  attach(@Param('id') id: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ documentId: v.uuid() }, body);
    return this.db.tx(c, async (t) => {
      const cl = await t.one(`SELECT cl.id, i.patient_id FROM claims cl JOIN invoices i ON i.id=cl.invoice_id WHERE cl.id=$1`, [uid(id)]);
      if (!cl) throw new NotFoundException('Claim not found');
      const d = await t.one(`SELECT id FROM medical_documents WHERE id=$1 AND patient_id=$2 AND deleted_at IS NULL`, [b.documentId, cl.patient_id]);
      if (!d) throw new BadRequestException('That document is not in this patient\'s file');
      await t.q(`INSERT INTO claim_documents(organization_id, claim_id, document_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [c.orgId, id, b.documentId]);
      await audit(t, c.userId, c.orgId, 'claim.attach', 'claim', id, { document: b.documentId });
      return this.claim(t, id);
    });
  }

  private async checkCard(t: Tx, docId: string | null | undefined, pid: string) {
    if (!docId) return;
    const d = await t.one(`SELECT id FROM medical_documents WHERE id=$1 AND patient_id=$2 AND deleted_at IS NULL`, [docId, pid]);
    if (!d) throw new BadRequestException('The insurance card must be a document in this patient\'s file');
  }

  private async policy(t: Tx, id: string) {
    return t.one(`SELECT ip.*, pr.name AS provider_name, pr.kind AS provider_kind FROM insurance_policies ip JOIN insurance_providers pr ON pr.id=ip.provider_id WHERE ip.id=$1`, [id]);
  }

  private async claim(t: Tx, id: string) {
    const r = await t.one(`SELECT cl.*, i.invoice_number, i.currency, i.patient_id, p.full_name AS patient_name, p.patient_number,
        pol.policy_number, pol.coverage_percent, pol.member_name, pr.name AS provider_name, pr.kind AS provider_kind, u.full_name AS created_by_name
      FROM claims cl JOIN invoices i ON i.id=cl.invoice_id JOIN patients p ON p.id=i.patient_id JOIN insurance_policies pol ON pol.id=cl.policy_id
      JOIN insurance_providers pr ON pr.id=pol.provider_id LEFT JOIN users u ON u.id=cl.created_by WHERE cl.id=$1`, [id]);
    if (!r) throw new NotFoundException('Claim not found');
    r.documents = await t.q(`SELECT d.id, d.title, d.kind, d.mime_type FROM claim_documents cd JOIN medical_documents d ON d.id=cd.document_id WHERE cd.claim_id=$1`, [id]);
    for (const k of ['amount_claimed', 'amount_approved', 'coverage_percent']) if (r[k] != null) r[k] = Number(r[k]);
    return r;
  }
}
