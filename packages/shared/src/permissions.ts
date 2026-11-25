// Permission codes and role defaults. Must match db/migrations/003 (checked by a test against the database).
export const PERMISSIONS = {
  'org.manage': 'Manage workspace profile, locations, rooms, departments',
  'staff.manage': 'Invite, assign and suspend staff',
  'permission.manage': 'Change staff permissions',
  'patient.register': 'Register patients',
  'patient.file.read': 'Open patient files',
  'patient.history.read': 'View medical history',
  'clinical_notes.read': 'Read confidential clinical notes',
  'appointment.manage': 'Manage appointments',
  'prescription.view': 'View prescriptions',
  'prescription.create': 'Create or approve prescriptions',
  'document.upload': 'Upload documents',
  'payment.register': 'Register payments',
  'finance.view': 'View financial information',
  'insurance.manage': 'Manage insurance providers, policies and claims',
  'whatsapp.send': 'WhatsApp communication',
  'report.view': 'View reports',
  'template.manage': 'Customize specialty templates',
} as const;
export type Permission = keyof typeof PERMISSIONS;
export const PERMISSION_CODES = Object.keys(PERMISSIONS) as Permission[];

export const ROLES = ['super_admin', 'center_owner', 'center_admin', 'doctor', 'assistant', 'receptionist', 'accountant', 'insurance_admin', 'patient'] as const;
export type Role = (typeof ROLES)[number];
export const STAFF_ROLES: Role[] = ['center_owner', 'center_admin', 'doctor', 'assistant', 'receptionist', 'accountant', 'insurance_admin'];
export const ORG_WIDE_ROLES: Role[] = ['center_owner', 'center_admin', 'receptionist', 'accountant', 'insurance_admin'];

export const ROLE_DEFAULTS: Record<string, Permission[]> = {
  center_owner: ['org.manage', 'staff.manage', 'permission.manage', 'finance.view', 'report.view'],
  center_admin: ['org.manage', 'staff.manage', 'permission.manage', 'patient.register', 'patient.file.read', 'appointment.manage', 'report.view'],
  doctor: ['patient.register', 'patient.file.read', 'patient.history.read', 'clinical_notes.read', 'appointment.manage',
    'prescription.view', 'prescription.create', 'document.upload', 'payment.register', 'finance.view',
    'insurance.manage', 'whatsapp.send', 'report.view', 'template.manage', 'permission.manage'],
  assistant: ['patient.register', 'patient.file.read', 'appointment.manage', 'document.upload'],
  receptionist: ['patient.register', 'patient.file.read', 'appointment.manage', 'payment.register'],
  accountant: ['payment.register', 'finance.view', 'report.view'],
  insurance_admin: ['insurance.manage'],
};

/** Permissions a role may never hold, whatever an administrator switches on. */
export function isGrantable(role: string, perm: Permission): boolean {
  if (perm === 'prescription.create') return role === 'doctor';
  if (role === 'patient' || role === 'super_admin') return false;
  return true;
}
