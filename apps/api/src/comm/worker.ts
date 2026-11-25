import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { decryptSecret } from '../common/crypto.js';
import { APPOINTMENT_PURPOSES, TEMPLATE_PARAMS, WaError, fmtAmount, fmtDate, fmtTime, render, sendTemplate, sendText, toWaNumber, type Purpose } from './whatsapp.js';

export interface TickResult { planned: number; sent: number; skipped: number; failed: number }

/**
 * Background sender. Every interval it plans due reminders and follow-ups, claims due messages and sends them through
 * the clinic's own WhatsApp number. A message is skipped (with the reason kept) when the patient has not consented,
 * has no number, the number is not connected, the visit changed, or no approved template exists outside the 24-hour window.
 */
@Injectable()
export class CommWorker implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null; private running: Promise<TickResult> | null = null;
  private log = new Logger('Messages');
  constructor(private db: Db) {}

  onModuleInit() {
    const ms = Number(process.env.COMM_WORKER_INTERVAL_MS ?? 30000);
    if (process.env.COMM_WORKER === 'off' || !ms) return;
    this.timer = setInterval(() => { this.tick().catch((e) => this.log.error(e.message)); }, ms);
    this.timer.unref();
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); await this.running?.catch(() => undefined); }

  /** One pass. Safe to call concurrently (one runs at a time) and from several API instances (rows are claimed with SKIP LOCKED). */
  tick(): Promise<TickResult> {
    if (!this.running) this.running = this.pass().finally(() => { this.running = null; });
    return this.running;
  }

  private async pass(): Promise<TickResult> {
    const res: TickResult = { planned: 0, sent: 0, skipped: 0, failed: 0 };
    res.planned = Number((await this.db.tx({}, (t) => t.one(`SELECT comm_plan() AS n`)))?.n ?? 0);
    for (;;) {
      const jobs = await this.db.tx({}, (t) => t.q(`SELECT * FROM comm_claim_due(25)`));
      if (!jobs.length) break;
      for (const j of jobs) {
        const out = await this.send(j);
        res[out.status === 'sent' ? 'sent' : out.status === 'skipped' ? 'skipped' : 'failed']++;
        await this.db.tx({}, (t) => t.q(`SELECT comm_finish($1,$2,$3,$4,$5,$6,$7)`,
          [j.id, out.status, out.reason ?? null, j.account_id, out.to ?? null, out.body ?? null, out.metaId ?? null]));
      }
      if (jobs.length < 25) break;
    }
    return res;
  }

  private async send(j: any): Promise<{ status: 'sent' | 'skipped' | 'failed'; reason?: string; to?: string; body?: string; metaId?: string }> {
    const skip = (reason: string) => ({ status: 'skipped' as const, reason });
    if (!j.consent) return skip('no_consent');
    const to = toWaNumber(j.patient_phone);
    if (!to) return skip('no_whatsapp_number');
    if (!j.account_id || j.account_status !== 'connected' || !j.token_enc) return skip('whatsapp_not_connected');
    const purpose = j.purpose as Purpose;
    if (APPOINTMENT_PURPOSES.includes(purpose)) {
      if (!j.appt_starts_at) return skip('appointment_changed');
      const moved = j.appointment_starts_at && new Date(j.appointment_starts_at).getTime() !== new Date(j.appt_starts_at).getTime();
      if (purpose === 'cancellation' ? j.appt_status !== 'cancelled' : (moved || !['scheduled', 'confirmed'].includes(j.appt_status))) return skip('appointment_changed');
    }
    if (purpose === 'payment' && !(Number(j.balance) > 0)) return skip('already_paid');
    if (!j.body) return skip('no_template');
    const lang = j.language ?? 'en', tz = j.timezone ?? 'Asia/Beirut';
    const when = j.appt_starts_at ?? (j.follow_up_date ? `${j.follow_up_date}T12:00:00Z` : null);
    const vars: Record<string, string> = {
      patient: String(j.patient_name ?? '').split(' ')[0] || String(j.patient_name ?? ''), doctor: j.doctor_name ?? j.clinic_name, clinic: j.clinic_name,
      date: when ? fmtDate(when, lang, tz) : '', time: j.appt_starts_at ? fmtTime(j.appt_starts_at, lang, tz) : '',
      amount: j.balance != null ? fmtAmount(j.balance, j.currency ?? 'USD', lang) : '', message: j.message ?? '',
    };
    const body = render(j.body, vars);
    let token: string;
    try { token = decryptSecret(j.token_enc); } catch { return skip('whatsapp_not_connected'); }
    try {
      let metaId: string;
      if (j.meta_template_name) metaId = await sendTemplate(j.phone_number_id, token, to, j.meta_template_name, lang, TEMPLATE_PARAMS[purpose].map((k) => vars[k] ?? ''));
      else if (j.window_open) metaId = await sendText(j.phone_number_id, token, to, body);
      else return skip('template_not_approved');
      return { status: 'sent', to, body, metaId };
    } catch (e) {
      return { status: 'failed', reason: e instanceof WaError ? e.message.slice(0, 300) : 'send_error' };
    }
  }
}
