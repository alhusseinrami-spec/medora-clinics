import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { Db, Tx } from '../db/db.service.js';
import { Ctx, RequireAnyPerm, RequirePerm } from '../common/decorators.js';
import type { TenantInfo } from '../common/types.js';
import { parse, v } from '../common/validate.js';
import { audit } from '../common/audit.js';

export const uid = (x: string) => parse({ id: v.uuid() }, { id: x }).id;
export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
/** Converts an amount between USD and LBP with a given (frozen) rate. */
export const convert = (amount: number, from: string, to: string, rate: number) => (from === to ? amount : to === 'USD' ? amount / rate : amount * rate);

const ITEM = v.object({
  description: v.str(1, 300), quantity: v.num(0.01, 10000).optional(), unitPrice: v.num(0, 1e11),
  kind: v.enum('consultation', 'service', 'product', 'other').optional(), serviceId: v.uuid().nullable(), insuranceCovered: v.bool().optional(),
});
type Item = { description: string; quantity?: number; unitPrice: number; kind?: string; serviceId?: string | null; insuranceCovered?: boolean };
const METHODS = ['cash', 'card', 'bank_transfer', 'whish', 'omt'] as const;
const LIST_COLS = `i.id, i.kind, i.status, i.invoice_number, i.currency, i.lbp_per_usd, i.issued_at, i.created_at, i.patient_id, i.doctor_membership_id,
  i.credit_for_invoice_id, p.full_name AS patient_name, p.patient_number, du.full_name AS doctor_name,
  b.total, b.credited, b.paid, round(b.total - b.credited - b.paid, 2) AS balance`;
const LIST_FROM = `FROM invoices i JOIN invoice_balances b ON b.invoice_id=i.id JOIN patients p ON p.id=i.patient_id
  LEFT JOIN memberships dm ON dm.id=i.doctor_membership_id LEFT JOIN users du ON du.id=dm.user_id`;

@Controller()
export class InvoicesController {
  constructor(private db: Db) {}

  @RequireAnyPerm('payment.register', 'finance.view', 'insurance.manage') @Get('invoices')
  list(@Ctx() c: TenantInfo, @Query() q: Record<string, string>) {
    const f = parse({ status: v.enum('draft', 'issued', 'void').optional(), patient: v.uuid().optional(), doctor: v.uuid().optional(),
      from: v.date().optional(), to: v.date().optional(), unpaid: v.enum('1').optional(), kind: v.enum('invoice', 'credit_note').optional(), q: v.str(1, 80).optional() }, q);
    return this.db.tx(c, (t) => t.q(`SELECT ${LIST_COLS} ${LIST_FROM}
      WHERE i.organization_id=$1 AND ($2::text IS NULL OR i.status=$2) AND ($3::uuid IS NULL OR i.patient_id=$3) AND ($4::uuid IS NULL OR i.doctor_membership_id=$4)
        AND ($5::date IS NULL OR coalesce(i.issued_at, i.created_at) >= $5::date) AND ($6::date IS NULL OR coalesce(i.issued_at, i.created_at) < $6::date + 1)
        AND ($7::text IS NULL OR (i.status='issued' AND i.kind='invoice' AND b.total - b.credited - b.paid > 0.004))
        AND ($8::text IS NULL OR i.kind=$8)
        AND ($9::text IS NULL OR lower(p.full_name) LIKE '%' || lower($9) || '%' OR i.invoice_number::text = $9 OR upper(p.patient_number) = upper($9))
      ORDER BY coalesce(i.issued_at, i.created_at) DESC LIMIT 300`,
      [c.orgId, f.status ?? null, f.patient ?? null, f.doctor ?? null, f.from ?? null, f.to ?? null, f.unpaid ?? null, f.kind ?? null, f.q ?? null]));
  }

  /**
   * Creates a draft invoice (or issues it straight away with issue=true). From an appointment, the doctor,
   * department and the appointment's service or the doctor's consultation fee are filled in.
   */
  @RequirePerm('payment.register') @Post('invoices')
  create(@Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({
      patientId: v.uuid().optional(), appointmentId: v.uuid().optional(), doctorMembershipId: v.uuid().nullable(), departmentId: v.uuid().nullable(),
      currency: v.enum('USD', 'LBP').optional(), items: v.array(ITEM, 50).optional(), discount: v.num(0, 1e11).optional(), tax: v.num(0, 1e11).optional(),
      notes: v.str(1, 2000).nullable(), issue: v.bool().optional(),
    }, body);
    return this.db.tx(c, async (t) => {
      let patientId = b.patientId; let doctor = b.doctorMembershipId ?? null; let dept = b.departmentId ?? null;
      let items = (b.items ?? []) as Item[]; let currency = b.currency;
      if (b.appointmentId) {
        const a = await t.one(`SELECT a.patient_id, a.doctor_membership_id, a.department_id, a.status, s.name AS service_name, s.price, s.currency AS service_currency,
            m.consultation_fee, (SELECT id FROM invoices WHERE appointment_id=a.id AND kind='invoice' AND status<>'void') AS existing
          FROM appointments a JOIN memberships m ON m.id=a.doctor_membership_id LEFT JOIN services s ON s.id=a.service_id
          WHERE a.id=$1 AND a.organization_id=$2`, [b.appointmentId, c.orgId]);
        if (!a) throw new NotFoundException('Appointment not found');
        if (a.existing) throw new ConflictException({ message: 'This visit already has an invoice', code: 'already_invoiced', invoiceId: a.existing });
        patientId ??= a.patient_id; doctor ??= a.doctor_membership_id; dept ??= a.department_id;
        if (patientId !== a.patient_id) throw new BadRequestException('The appointment is for another patient');
        if (!items.length) {
          if (a.service_name) { items = [{ description: a.service_name, unitPrice: Number(a.price), kind: 'consultation' }]; currency ??= a.service_currency; }
          else if (a.consultation_fee != null) items = [{ description: 'Consultation', unitPrice: Number(a.consultation_fee), kind: 'consultation' }];
        }
      }
      if (!patientId) throw new BadRequestException('Choose a patient');
      if (!doctor && !c.orgWide) doctor = c.doctorMembershipId ?? (c.actingDoctors.length === 1 ? c.actingDoctors[0] : null);
      if (!doctor && !c.orgWide) throw new BadRequestException('Choose the doctor this invoice is for');
      if (doctor && !c.orgWide && !c.actingDoctors.includes(doctor)) throw new ForbiddenException('You do not work for this doctor');
      const r = await t.one(`INSERT INTO invoices(organization_id, patient_id, doctor_membership_id, department_id, appointment_id, currency, discount, tax, notes, status, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10) RETURNING id`,
        [c.orgId, patientId, doctor, dept, b.appointmentId ?? null, currency ?? 'USD', b.discount ?? 0, b.tax ?? 0, b.notes ?? null, c.userId]);
      await this.writeItems(t, r.id, items);
      await audit(t, c.userId, c.orgId, 'invoice.create', 'invoice', r.id, { patient: patientId });
      if (b.issue) await this.doIssue(t, c, r.id);
      return this.load(t, r.id);
    });
  }

  @RequireAnyPerm('payment.register', 'finance.view', 'insurance.manage') @Get('invoices/:id')
  get(@Param('id') iid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => this.load(t, uid(iid)));
  }

  @RequirePerm('payment.register') @Patch('invoices/:id')
  update(@Param('id') iid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ currency: v.enum('USD', 'LBP').optional(), items: v.array(ITEM, 50).optional(), discount: v.num(0, 1e11).optional(),
      tax: v.num(0, 1e11).optional(), notes: v.str(1, 2000).nullable(), departmentId: v.uuid().nullable() }, body);
    return this.db.tx(c, async (t) => {
      const cur = await this.draft(t, uid(iid));
      const sets: string[] = []; const vals: unknown[] = [iid];
      const set = (col: string, val: unknown) => { vals.push(val); sets.push(`${col}=$${vals.length}`); };
      if (b.currency) set('currency', b.currency);
      if (b.discount !== undefined) set('discount', b.discount);
      if (b.tax !== undefined) set('tax', b.tax);
      if (b.notes !== undefined) set('notes', b.notes);
      if (b.departmentId !== undefined) set('department_id', b.departmentId);
      if (sets.length) await t.q(`UPDATE invoices SET ${sets.join(', ')} WHERE id=$1`, vals);
      if (b.items) { await t.q(`DELETE FROM invoice_items WHERE invoice_id=$1`, [cur.id]); await this.writeItems(t, cur.id, b.items as Item[]); }
      await audit(t, c.userId, c.orgId, 'invoice.update', 'invoice', iid);
      return this.load(t, iid);
    });
  }

  /** Issues the invoice: it receives the next number, today's date, and its exchange rate and commission are frozen. */
  @RequirePerm('payment.register') @Post('invoices/:id/issue')
  issue(@Param('id') iid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => { await this.doIssue(t, c, uid(iid)); return this.load(t, iid); });
  }

  @RequirePerm('payment.register') @Delete('invoices/:id')
  remove(@Param('id') iid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      await this.draft(t, uid(iid));
      await t.q(`DELETE FROM invoices WHERE id=$1`, [iid]);
      await audit(t, c.userId, c.orgId, 'invoice.delete_draft', 'invoice', iid);
      return { ok: true };
    });
  }

  /** Voids an issued invoice nobody has paid (wrong patient, duplicate). Its number stays used and visible. */
  @RequirePerm('finance.view') @Post('invoices/:id/void')
  void(@Param('id') iid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ reason: v.str(3, 500) }, body);
    if (!c.permissions.has('payment.register')) throw new ForbiddenException('Voiding needs the payment permission too');
    return this.db.tx(c, async (t) => {
      const cur = await this.mustLoad(t, uid(iid));
      if (cur.status !== 'issued') throw new ConflictException('Only an issued invoice can be voided');
      await t.q(`UPDATE invoices SET status='void', voided_at=now(), void_reason=$2 WHERE id=$1`, [iid, b.reason]);
      await audit(t, c.userId, c.orgId, 'invoice.void', 'invoice', iid, { reason: b.reason });
      return this.load(t, iid);
    });
  }

  /** A credit note reduces what the patient owes on an issued invoice. Money already paid is returned with a refund. */
  @RequirePerm('finance.view') @Post('invoices/:id/credit-notes')
  creditNote(@Param('id') iid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ reason: v.str(3, 500), amount: v.num(0.01, 1e11) }, body);
    if (!c.permissions.has('payment.register')) throw new ForbiddenException('Credit notes need the payment permission too');
    return this.db.tx(c, async (t) => {
      const inv = await this.mustLoad(t, uid(iid));
      if (inv.status !== 'issued' || inv.kind !== 'invoice') throw new ConflictException('Credit notes apply to issued invoices');
      const creditable = round2(inv.total - inv.credited);
      if (b.amount > creditable + 0.004) throw new BadRequestException(`At most ${creditable} ${inv.currency} can be credited on this invoice`);
      const cn = await t.one(`INSERT INTO invoices(organization_id, patient_id, doctor_membership_id, department_id, currency, lbp_per_usd, kind, credit_for_invoice_id, notes, status, created_by, doctor_percent)
        VALUES ($1,$2,$3,$4,$5,$6,'credit_note',$7,$8,'draft',$9,$10) RETURNING id`,
        [c.orgId, inv.patient_id, inv.doctor_membership_id, inv.department_id, inv.currency, inv.lbp_per_usd, iid, b.reason, c.userId, inv.doctor_percent]);
      await t.q(`INSERT INTO invoice_items(invoice_id, description, unit_price, kind) VALUES ($1,$2,$3,'other')`, [cn.id, `Credit on invoice ${inv.invoice_number}: ${b.reason}`, b.amount]);
      await t.q(`UPDATE invoices SET status='issued', issued_by=$2 WHERE id=$1`, [cn.id, c.userId]);
      await audit(t, c.userId, c.orgId, 'invoice.credit_note', 'invoice', iid, { creditNote: cn.id, amount: b.amount, reason: b.reason });
      return this.load(t, iid);
    });
  }

  /** Records money received. Paying in the other currency is converted at today's rate, which is stored on the payment. */
  @RequirePerm('payment.register') @Post('invoices/:id/payments')
  pay(@Param('id') iid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ method: v.enum(...METHODS), amount: v.num(0.01, 1e12), currency: v.enum('USD', 'LBP'), reference: v.str(1, 120).nullable(), note: v.str(1, 500).nullable() }, body);
    return this.db.tx(c, async (t) => {
      const inv = await this.mustLoad(t, uid(iid));
      if (inv.status !== 'issued' || inv.kind !== 'invoice') throw new ConflictException('Payments are recorded on issued invoices');
      const rate = Number((await t.one(`SELECT app_current_rate($1) AS r`, [c.orgId])).r ?? inv.lbp_per_usd);
      const inInvoiceCurrency = convert(b.amount, b.currency, inv.currency, rate);
      if (inInvoiceCurrency > inv.balance + (inv.currency === 'LBP' ? 1000 : 0.01)) {
        throw new BadRequestException(`That is more than the balance of ${inv.balance} ${inv.currency}`);
      }
      const p = await t.one(`INSERT INTO payments(organization_id, invoice_id, method_code, amount, currency, lbp_per_usd, received_by, reference, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, receipt_number`, [c.orgId, iid, b.method, b.amount, b.currency, rate, c.userId, b.reference ?? null, b.note ?? null]);
      await audit(t, c.userId, c.orgId, 'payment.receive', 'payment', p.id, { invoice: iid, amount: b.amount, currency: b.currency, method: b.method });
      return { ...(await this.load(t, iid)), receipt: { id: p.id, receiptNumber: p.receipt_number } };
    });
  }

  /** Refunds (part of) a payment, in the same currency and method. Needs the finance permission as well. */
  @RequirePerm('finance.view') @Post('payments/:id/refund')
  refund(@Param('id') pid: string, @Body() body: unknown, @Ctx() c: TenantInfo) {
    const b = parse({ amount: v.num(0.01, 1e12), reason: v.str(3, 500) }, body);
    if (!c.permissions.has('payment.register')) throw new ForbiddenException('Refunds need the payment permission too');
    return this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT p.*, coalesce((SELECT -sum(r.amount) FROM payments r WHERE r.refund_of=p.id), 0) AS refunded FROM payments p WHERE p.id=$1`, [uid(pid)]);
      if (!p) throw new NotFoundException('Payment not found');
      if (p.refund_of) throw new BadRequestException('This is already a refund');
      const left = round2(Number(p.amount) - Number(p.refunded));
      if (b.amount > left + 0.004) throw new BadRequestException(`At most ${left} ${p.currency} can be refunded on this payment`);
      const r = await t.one(`INSERT INTO payments(organization_id, invoice_id, method_code, amount, currency, lbp_per_usd, received_by, refund_of, note)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, receipt_number`, [c.orgId, p.invoice_id, p.method_code, -b.amount, p.currency, p.lbp_per_usd, c.userId, p.id, b.reason]);
      await audit(t, c.userId, c.orgId, 'payment.refund', 'payment', r.id, { of: p.id, amount: b.amount, reason: b.reason });
      return this.load(t, p.invoice_id);
    });
  }

  /** Receipt: one payment with its invoice and the workspace letterhead. */
  @RequireAnyPerm('payment.register', 'finance.view', 'insurance.manage') @Get('payments/:id')
  receipt(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, async (t) => {
      const p = await t.one(`SELECT p.id, p.receipt_number, p.amount, p.currency, p.lbp_per_usd, p.method_code, pm.name AS method_name, p.reference, p.note,
          p.received_at, p.refund_of, p.invoice_id, u.full_name AS received_by_name
        FROM payments p JOIN payment_methods pm ON pm.code=p.method_code LEFT JOIN users u ON u.id=p.received_by WHERE p.id=$1`, [uid(pid)]);
      if (!p) throw new NotFoundException('Payment not found');
      return { ...p, invoice: await this.load(t, p.invoice_id) };
    });
  }

  @RequireAnyPerm('payment.register', 'finance.view', 'insurance.manage') @Get('patients/:id/invoices')
  patientInvoices(@Param('id') pid: string, @Ctx() c: TenantInfo) {
    return this.db.tx(c, (t) => t.q(`SELECT ${LIST_COLS} ${LIST_FROM} WHERE i.patient_id=$1 ORDER BY coalesce(i.issued_at, i.created_at) DESC`, [uid(pid)]));
  }

  private async doIssue(t: Tx, c: TenantInfo, iid: string) {
    const cur = await this.draft(t, iid);
    const n = await t.one(`SELECT count(*)::int AS n, coalesce(sum(quantity*unit_price),0) AS sub FROM invoice_items WHERE invoice_id=$1`, [iid]);
    if (!n.n) throw new BadRequestException('Add at least one line');
    if (Number(cur.discount) > Number(n.sub) + Number(cur.tax)) throw new BadRequestException('The discount is larger than the invoice');
    await t.q(`UPDATE invoices SET status='issued', issued_by=$2 WHERE id=$1`, [iid, c.userId]);
    await audit(t, c.userId, c.orgId, 'invoice.issue', 'invoice', iid);
  }

  private async writeItems(t: Tx, iid: string, items: Item[]) {
    for (const [i, it] of items.entries()) {
      await t.q(`INSERT INTO invoice_items(invoice_id, service_id, description, quantity, unit_price, kind, insurance_covered, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [iid, it.serviceId ?? null, it.description, it.quantity ?? 1, it.unitPrice, it.kind ?? 'service', it.insuranceCovered ?? false, i]);
    }
  }

  private async draft(t: Tx, iid: string) {
    const r = await t.one(`SELECT id, status, discount, tax FROM invoices WHERE id=$1`, [iid]);
    if (!r) throw new NotFoundException('Invoice not found');
    if (r.status !== 'draft') throw new ConflictException({ message: 'An issued invoice cannot be changed. Issue a credit note instead.', code: 'record_locked' });
    return r;
  }

  private async mustLoad(t: Tx, iid: string) {
    const r = await t.one(`SELECT i.*, b.total, b.credited, b.paid, b.covered_subtotal, round(b.total - b.credited - b.paid, 2) AS balance
      FROM invoices i JOIN invoice_balances b ON b.invoice_id=i.id WHERE i.id=$1`, [iid]);
    if (!r) throw new NotFoundException('Invoice not found');
    for (const k of ['total', 'credited', 'paid', 'covered_subtotal', 'balance', 'discount', 'tax', 'lbp_per_usd', 'doctor_percent']) if (r[k] != null) r[k] = Number(r[k]);
    return r;
  }

  /** Everything the invoice page and its print view need. */
  async load(t: Tx, iid: string) {
    const r = await this.mustLoad(t, iid);
    const extra = await t.one(`SELECT p.full_name AS patient_name, p.patient_number, p.phone AS patient_phone, p.address AS patient_address,
        du.full_name AS doctor_name, dm.specialty_code, dm.license_number, d.name AS department_name,
        o.name AS organization_name, o.phone AS organization_phone, o.address AS organization_address, o.email AS organization_email,
        cu.full_name AS created_by_name, iu.full_name AS issued_by_name, src.invoice_number AS credit_for_number
      FROM invoices i JOIN patients p ON p.id=i.patient_id JOIN organizations o ON o.id=i.organization_id
      LEFT JOIN memberships dm ON dm.id=i.doctor_membership_id LEFT JOIN users du ON du.id=dm.user_id LEFT JOIN departments d ON d.id=i.department_id
      LEFT JOIN users cu ON cu.id=i.created_by LEFT JOIN users iu ON iu.id=i.issued_by LEFT JOIN invoices src ON src.id=i.credit_for_invoice_id WHERE i.id=$1`, [iid]);
    const [items, payments, creditNotes, claims] = await Promise.all([
      t.q(`SELECT id, service_id, description, quantity, unit_price, kind, insurance_covered, round(quantity*unit_price, 2) AS amount FROM invoice_items WHERE invoice_id=$1 ORDER BY position`, [iid]),
      t.q(`SELECT p.id, p.receipt_number, p.amount, p.currency, p.lbp_per_usd, p.method_code, pm.name AS method_name, p.reference, p.note, p.received_at, p.refund_of, p.claim_id,
           u.full_name AS received_by_name FROM payments p JOIN payment_methods pm ON pm.code=p.method_code LEFT JOIN users u ON u.id=p.received_by
           WHERE p.invoice_id=$1 ORDER BY p.received_at`, [iid]),
      t.q(`SELECT i.id, i.invoice_number, i.issued_at, i.notes, b.total FROM invoices i JOIN invoice_balances b ON b.invoice_id=i.id
           WHERE i.credit_for_invoice_id=$1 AND i.status='issued' ORDER BY i.issued_at`, [iid]),
      t.q(`SELECT c.id, c.status, c.amount_claimed, c.amount_approved, ip.name AS provider_name FROM claims c JOIN insurance_policies pol ON pol.id=c.policy_id
           JOIN insurance_providers ip ON ip.id=pol.provider_id WHERE c.invoice_id=$1 ORDER BY c.created_at`, [iid]),
    ]);
    const num = (x: any) => ({ ...x, ...Object.fromEntries(['quantity', 'unit_price', 'amount', 'lbp_per_usd', 'total', 'amount_claimed', 'amount_approved'].filter((k) => x[k] != null).map((k) => [k, Number(x[k])])) });
    return { ...r, ...extra, items: items.map(num), payments: payments.map(num), creditNotes: creditNotes.map(num), claims: claims.map(num) };
  }
}
