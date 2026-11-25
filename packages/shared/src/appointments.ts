export const APPOINTMENT_STATUSES = ['scheduled', 'confirmed', 'arrived', 'waiting', 'in_consultation', 'completed', 'cancelled', 'no_show'] as const;
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

const NEXT: Record<AppointmentStatus, AppointmentStatus[]> = {
  scheduled: ['confirmed', 'arrived', 'cancelled', 'no_show'],
  confirmed: ['scheduled', 'arrived', 'cancelled', 'no_show'],
  arrived: ['waiting', 'in_consultation', 'cancelled'],
  waiting: ['in_consultation', 'cancelled'],
  in_consultation: ['completed', 'waiting'],
  completed: [],
  cancelled: [],
  no_show: [],
};
export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return NEXT[from]?.includes(to) ?? false;
}
export function nextStatuses(from: AppointmentStatus): AppointmentStatus[] { return NEXT[from] ?? []; }
export const RESCHEDULABLE: AppointmentStatus[] = ['scheduled', 'confirmed'];

/** Minimal RRULE subset: FREQ=DAILY|WEEKLY;INTERVAL=n;COUNT=n (max 52). Returns start offsets in days. */
export function expandRecurrence(rule: string): number[] {
  const parts = Object.fromEntries(rule.split(';').map((kv) => kv.split('=') as [string, string]));
  const freq = parts.FREQ; const interval = Number(parts.INTERVAL ?? 1); const count = Number(parts.COUNT);
  if (!['DAILY', 'WEEKLY'].includes(freq) || !Number.isInteger(interval) || interval < 1 || !Number.isInteger(count) || count < 1 || count > 52) {
    throw new Error('Unsupported recurrence. Use FREQ=DAILY|WEEKLY;INTERVAL=n;COUNT=1..52');
  }
  const step = (freq === 'WEEKLY' ? 7 : 1) * interval;
  return Array.from({ length: count }, (_, i) => i * step);
}
