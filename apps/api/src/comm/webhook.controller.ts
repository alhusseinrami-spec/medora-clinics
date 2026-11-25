import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Post, Query, Req, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { Db } from '../db/db.service.js';
import { Public } from '../common/decorators.js';
import { validSignature, wa } from './whatsapp.js';

/**
 * Meta WhatsApp webhook. Meta calls GET once to verify the URL (hub.verify_token must match WHATSAPP_VERIFY_TOKEN),
 * then POSTs messages and delivery statuses signed with the app secret (X-Hub-Signature-256). Unsigned or
 * wrongly signed calls are refused. Without the app secret configured, the webhook is off.
 */
@Controller('webhooks/whatsapp')
export class WebhookController {
  constructor(private db: Db) {}

  @Public() @Get()
  verify(@Query('hub.mode') mode: string, @Query('hub.verify_token') token: string, @Query('hub.challenge') challenge: string) {
    if (!wa.verifyToken()) throw new ServiceUnavailableException('WhatsApp webhook is not configured');
    if (mode !== 'subscribe' || token !== wa.verifyToken()) throw new ForbiddenException('Verification failed');
    return challenge;
  }

  @Public() @Post() @HttpCode(200)
  async receive(@Req() req: any, @Headers('x-hub-signature-256') sig: string | undefined, @Body() body: unknown) {
    if (!wa.appSecret()) throw new ServiceUnavailableException('WhatsApp webhook is not configured');
    const raw: Buffer = Buffer.isBuffer(body) ? body : Buffer.from('');
    if (!validSignature(raw, sig)) throw new UnauthorizedException('Bad signature');
    let payload: any; try { payload = JSON.parse(raw.toString('utf8')); } catch { return { ok: true }; }
    let messages = 0, statuses = 0;
    for (const entry of payload?.entry ?? []) for (const change of entry?.changes ?? []) {
      const value = change?.value; const pnid = value?.metadata?.phone_number_id;
      if (change?.field !== 'messages' || !pnid) continue;
      for (const m of value.messages ?? []) {
        const text = m.type === 'text' ? m.text?.body : m.type === 'button' ? m.button?.text : m.type === 'interactive'
          ? (m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title) : `[${m.type}]`;
        const at = m.timestamp ? new Date(Number(m.timestamp) * 1000) : new Date();
        await this.db.tx({}, (t) => t.q(`SELECT comm_inbound($1,$2,$3,$4,$5)`, [pnid, String(m.from ?? ''), String(text ?? '').slice(0, 4000), String(m.id), at.toISOString()]));
        messages++;
      }
      for (const s of value.statuses ?? []) {
        const at = s.timestamp ? new Date(Number(s.timestamp) * 1000) : new Date();
        const err = s.errors?.[0] ? `${s.errors[0].code ?? ''} ${s.errors[0].title ?? s.errors[0].message ?? ''}`.trim().slice(0, 300) : null;
        await this.db.tx({}, (t) => t.q(`SELECT comm_status($1,$2,$3,$4)`, [String(s.id), String(s.status), err, at.toISOString()]));
        statuses++;
      }
    }
    return { ok: true, messages, statuses };
  }
}
