import type { Tx } from '../db/db.service.js';

/** Queues an event message (confirmation, reschedule, cancellation) when the workspace switched it on. Same transaction as the change. */
export const queueAppointmentEvent = (t: Tx, purpose: 'confirmation' | 'reschedule' | 'cancellation', appointmentId: string) =>
  t.q(`SELECT comm_queue_event($1,$2)`, [purpose, appointmentId]);
