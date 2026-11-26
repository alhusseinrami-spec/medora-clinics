import { Injectable, Logger } from '@nestjs/common';
import { createECDH, createHash } from 'node:crypto';
import { sendNotification } from 'web-push';
import { Db } from '../db/db.service.js';

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/**
 * Web Push (VAPID). Keys come from WEB_PUSH_PUBLIC_KEY / WEB_PUSH_PRIVATE_KEY (generate once with
 * `npx web-push generate-vapid-keys`). In development a fixed key pair is derived so subscriptions survive restarts;
 * in production push stays off until the keys are set. Payloads are generic: never a patient name or medical detail.
 */
export function vapidKeys(): { publicKey: string; privateKey: string } | null {
  if (process.env.WEB_PUSH_PUBLIC_KEY && process.env.WEB_PUSH_PRIVATE_KEY) return { publicKey: process.env.WEB_PUSH_PUBLIC_KEY, privateKey: process.env.WEB_PUSH_PRIVATE_KEY };
  if (process.env.NODE_ENV === 'production') return null;
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(createHash('sha256').update('medora-development-only-vapid').digest());
  return { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
}

const TEXT: Record<string, Record<string, [string, string]>> = {
  en: { patient_arrived: ['Patient arrived', 'A patient is in the waiting room.'], whatsapp_message: ['New WhatsApp message', 'Open the inbox to reply.'],
    appointment_request: ['New appointment request', 'A patient asked for an appointment.'], appointment_cancelled_by_patient: ['Appointment cancelled', 'A patient cancelled an appointment online.'],
    appointment_request_accepted: ['Appointment booked', 'Your request was accepted. See the time in the app.'], appointment_request_declined: ['Appointment request answered', 'The clinic answered your request.'] },
  fr: { patient_arrived: ['Patient arrivé', 'Un patient est en salle d\'attente.'], whatsapp_message: ['Nouveau message WhatsApp', 'Ouvrez la boîte de réception pour répondre.'],
    appointment_request: ['Nouvelle demande de rendez-vous', 'Un patient demande un rendez-vous.'], appointment_cancelled_by_patient: ['Rendez-vous annulé', 'Un patient a annulé un rendez-vous en ligne.'],
    appointment_request_accepted: ['Rendez-vous confirmé', 'Votre demande est acceptée. L\'horaire est dans l\'application.'], appointment_request_declined: ['Réponse à votre demande', 'La clinique a répondu à votre demande.'] },
  ar: { patient_arrived: ['وصل مريض', 'مريض في غرفة الانتظار.'], whatsapp_message: ['رسالة واتساب جديدة', 'افتح صندوق الوارد للرد.'],
    appointment_request: ['طلب موعد جديد', 'طلب مريض موعداً.'], appointment_cancelled_by_patient: ['أُلغي موعد', 'ألغى مريض موعده عبر الإنترنت.'],
    appointment_request_accepted: ['تم حجز الموعد', 'تمت الموافقة على طلبك. الوقت موجود في التطبيق.'], appointment_request_declined: ['تم الرد على طلبك', 'ردّت العيادة على طلب الموعد.'] },
};

@Injectable()
export class PushService {
  private log = new Logger('Push');
  /** Optional HTTPS agent (tests use one that trusts a local stand-in push service). */
  agent?: import('node:https').Agent;
  constructor(private db: Db) {}

  enabled() { return vapidKeys() !== null; }

  /** Sends one generic notification to every device of the user. Dead subscriptions (404/410) are removed. */
  async notifyUser(userId: string, kind: string, organizationId?: string | null, notificationId?: string): Promise<number> {
    const keys = vapidKeys(); if (!keys) return 0;
    // With several API instances, each hears the event: only the one that claims the notification sends it.
    if (notificationId && !(await this.db.tx({}, (t) => t.one(`SELECT push_claim($1) AS ok`, [notificationId])))?.ok) return 0;
    const targets = await this.db.tx({}, (t) => t.q(`SELECT * FROM push_targets($1)`, [userId]));
    if (!targets.length) return 0;
    const lang = targets[0].language ?? 'en';
    const [title, body] = (TEXT[lang] ?? TEXT.en)[kind] ?? ['MEDORA CLINICS', ''];
    const portal = kind.startsWith('appointment_request_');
    const url = portal ? '/portal' : organizationId ? `/w/${organizationId}/${kind === 'whatsapp_message' ? 'messages' : 'dashboard'}` : '/';
    const payload = JSON.stringify({ title, body, url, tag: kind });
    let sent = 0;
    for (const s of targets) {
      try {
        await sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
          vapidDetails: { subject: process.env.WEB_PUSH_SUBJECT ?? 'mailto:support@medora.clinic', publicKey: keys.publicKey, privateKey: keys.privateKey },
          TTL: 3600, urgency: 'high', timeout: 10000, ...(this.agent ? { agent: this.agent } : {}),
        });
        sent++;
        await this.db.tx({}, (t) => t.q(`SELECT push_result($1,true,false)`, [s.id]));
      } catch (e: any) {
        const gone = e?.statusCode === 404 || e?.statusCode === 410;
        await this.db.tx({}, (t) => t.q(`SELECT push_result($1,false,$2)`, [s.id, gone])).catch(() => undefined);
        if (!gone) this.log.warn(`push failed: ${e?.statusCode ?? ''} ${e?.message ?? e}`);
      }
    }
    return sent;
  }
}
