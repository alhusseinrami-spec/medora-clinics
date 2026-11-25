'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { CLINICAL } from './i18n-clinical';
import { FINANCE } from './i18n-finance';
import { COMM } from './i18n-comm';
import { PORTAL } from './i18n-portal';

export type Lang = 'en' | 'ar' | 'fr';
type Dict = Record<string, string>;

const en: Dict = {
  vaccinationsDue: 'Vaccinations due (30 days)', deliveriesDue: 'Expected deliveries (60 days)', patientArrived: 'Patient arrived', laterReleases: 'Payments and insurance arrive in Release 3.',
  tagline: 'Smart healthcare. Simplified.', signIn: 'Sign in', signOut: 'Sign out', email: 'Email', password: 'Password',
  createAccount: 'Create an account', forgot: 'Forgot password?', continue: 'Continue', save: 'Save', cancel: 'Cancel', saved: 'Saved',
  loading: 'Loading…', search: 'Search', add: 'Add', edit: 'Edit', close: 'Close', back: 'Back', yes: 'Yes', no: 'No', none: 'None',
  dashboard: 'Dashboard', calendar: 'Calendar', waitingRoom: 'Waiting room', patients: 'Patients', settings: 'Settings', team: 'Team',
  workspace: 'Workspace', availability: 'Availability', specialty: 'Specialty templates', profile: 'My profile',
  registerDoctor: 'I am an independent doctor', registerCenter: 'I run a medical center', fullName: 'Full name', phone: 'Phone',
  specialtyLabel: 'Specialty', license: 'License number', clinicName: 'Clinic name', centerName: 'Center name', address: 'Address',
  consultationFee: 'Consultation fee (USD)', mfaCode: 'Authentication code', mfaPrompt: 'Enter the 6-digit code from your authenticator app.',
  patientsToday: 'Patients today', waiting: 'Waiting', nextAppointment: 'Next appointment', newPatients: 'New patients (30 days)',
  notifications: 'Notifications', quickActions: 'Quick actions', addPatient: 'Add patient', newAppointment: 'New appointment',
  openCalendar: 'Open calendar', walkIn: 'Walk-in', registerArrival: 'Mark arrived', callIn: 'Call in', complete: 'Complete',
  noShow: 'No-show', cancelAppt: 'Cancel', confirm: 'Confirm', todaysAppointments: "Today's appointments", pendingConfirmations: 'Pending confirmations',
  waitingFor: 'waiting', min: 'min', noOneWaiting: 'No one is waiting.', noAppointments: 'No appointments.',
  dateOfBirth: 'Date of birth', sex: 'Sex', female: 'Female', male: 'Male', other: 'Other', patientNumber: 'Patient ID',
  whatsapp: 'WhatsApp', emergencyContact: 'Emergency contact', bloodType: 'Blood type', allergies: 'Allergies',
  chronicDiseases: 'Chronic diseases', currentMedications: 'Current medications', medicalHistory: 'Previous medical history',
  nationalId: 'Identification number', language: 'Language', doctor: 'Doctor', patient: 'Patient', service: 'Service', duration: 'Duration (min)',
  start: 'Start', room: 'Room', notes: 'Notes', recurrence: 'Repeat', noRepeat: 'Does not repeat', weekly: 'Weekly', daily: 'Daily', times: 'times',
  overview: 'Overview', timeline: 'Timeline', appointments: 'Appointments', personal: 'Personal information', possibleDuplicate: 'Possible duplicate',
  duplicateHelp: 'A patient with similar details already exists in this workspace. Check before creating a new file.',
  createAnyway: 'Create anyway', invite: 'Invite', role: 'Role', permissions: 'Permissions', status: 'Status', active: 'Active', suspended: 'Suspended',
  assignTo: 'Assign to doctor', inviteLink: 'Invitation link', emailAwaiting: 'Email delivery is awaiting provider credentials. Share this link directly.',
  workingHours: 'Working hours', weekday: 'Day', from: 'From', to: 'To', theme: 'Theme', light: 'Light', dark: 'Dark', system: 'System',
  twoFactor: 'Two-factor authentication', enable: 'Enable', disable: 'Disable', on: 'On', off: 'Off', locations: 'Locations', rooms: 'Rooms', departments: 'Departments',
  day: 'Day', week: 'Week', today: 'Today', prev: 'Previous', next: 'Next', customField: 'Add a custom field', fieldKey: 'Field key', fieldLabel: 'Label',
  fieldType: 'Type', section: 'Section', hide: 'Hide', show: 'Show', version: 'Version', presetNote: 'Changes create a new version. Saved records keep the version they were recorded with.',
  noPermission: 'You do not have permission to see this.', acceptInvitation: 'Accept invitation', invitedAs: 'You are invited as',
  resetPassword: 'Reset password', newPassword: 'New password', liveConnected: 'Live', liveOffline: 'Reconnecting…', freeSlots: 'Free slots',
};
const fr: Dict = {
  vaccinationsDue: 'Vaccins à faire (30 jours)', deliveriesDue: 'Accouchements prévus (60 jours)', patientArrived: 'Patient arrivé', laterReleases: 'Paiements et assurances arrivent dans la version 3.',
  tagline: 'La santé intelligente. Simplifiée.', signIn: 'Se connecter', signOut: 'Se déconnecter', email: 'E-mail', password: 'Mot de passe',
  createAccount: 'Créer un compte', forgot: 'Mot de passe oublié ?', continue: 'Continuer', save: 'Enregistrer', cancel: 'Annuler', saved: 'Enregistré',
  loading: 'Chargement…', search: 'Rechercher', add: 'Ajouter', edit: 'Modifier', close: 'Fermer', back: 'Retour', yes: 'Oui', no: 'Non', none: 'Aucun',
  dashboard: 'Tableau de bord', calendar: 'Agenda', waitingRoom: "Salle d'attente", patients: 'Patients', settings: 'Paramètres', team: 'Équipe',
  workspace: 'Espace de travail', availability: 'Disponibilités', specialty: 'Modèles de spécialité', profile: 'Mon profil',
  registerDoctor: 'Je suis médecin indépendant', registerCenter: 'Je gère un centre médical', fullName: 'Nom complet', phone: 'Téléphone',
  specialtyLabel: 'Spécialité', license: 'Numéro de licence', clinicName: 'Nom du cabinet', centerName: 'Nom du centre', address: 'Adresse',
  consultationFee: 'Tarif de consultation (USD)', mfaCode: "Code d'authentification", mfaPrompt: "Saisissez le code à 6 chiffres de votre application d'authentification.",
  patientsToday: "Patients aujourd'hui", waiting: 'En attente', nextAppointment: 'Prochain rendez-vous', newPatients: 'Nouveaux patients (30 jours)',
  notifications: 'Notifications', quickActions: 'Actions rapides', addPatient: 'Ajouter un patient', newAppointment: 'Nouveau rendez-vous',
  openCalendar: "Ouvrir l'agenda", walkIn: 'Sans rendez-vous', registerArrival: 'Marquer arrivé', callIn: 'Appeler', complete: 'Terminer',
  noShow: 'Absent', cancelAppt: 'Annuler', confirm: 'Confirmer', todaysAppointments: "Rendez-vous du jour", pendingConfirmations: 'À confirmer',
  waitingFor: 'attente', min: 'min', noOneWaiting: "Personne n'attend.", noAppointments: 'Aucun rendez-vous.',
  dateOfBirth: 'Date de naissance', sex: 'Sexe', female: 'Femme', male: 'Homme', other: 'Autre', patientNumber: 'N° patient',
  whatsapp: 'WhatsApp', emergencyContact: "Contact d'urgence", bloodType: 'Groupe sanguin', allergies: 'Allergies',
  chronicDiseases: 'Maladies chroniques', currentMedications: 'Traitements en cours', medicalHistory: 'Antécédents médicaux',
  nationalId: "Numéro d'identité", language: 'Langue', doctor: 'Médecin', patient: 'Patient', service: 'Prestation', duration: 'Durée (min)',
  start: 'Début', room: 'Salle', notes: 'Notes', recurrence: 'Répéter', noRepeat: 'Ne se répète pas', weekly: 'Chaque semaine', daily: 'Chaque jour', times: 'fois',
  overview: 'Aperçu', timeline: 'Chronologie', appointments: 'Rendez-vous', personal: 'Informations personnelles', possibleDuplicate: 'Doublon possible',
  duplicateHelp: 'Un patient aux informations similaires existe déjà. Vérifiez avant de créer un nouveau dossier.',
  createAnyway: 'Créer quand même', invite: 'Inviter', role: 'Rôle', permissions: 'Autorisations', status: 'Statut', active: 'Actif', suspended: 'Suspendu',
  assignTo: 'Affecter au médecin', inviteLink: "Lien d'invitation", emailAwaiting: "L'envoi d'e-mails attend les identifiants du fournisseur. Partagez ce lien directement.",
  workingHours: 'Horaires', weekday: 'Jour', from: 'De', to: 'À', theme: 'Thème', light: 'Clair', dark: 'Sombre', system: 'Système',
  twoFactor: 'Authentification à deux facteurs', enable: 'Activer', disable: 'Désactiver', on: 'Activée', off: 'Désactivée', locations: 'Sites', rooms: 'Salles', departments: 'Départements',
  day: 'Jour', week: 'Semaine', today: "Aujourd'hui", prev: 'Précédent', next: 'Suivant', customField: 'Ajouter un champ', fieldKey: 'Clé du champ', fieldLabel: 'Libellé',
  fieldType: 'Type', section: 'Section', hide: 'Masquer', show: 'Afficher', version: 'Version', presetNote: 'Chaque modification crée une nouvelle version. Les dossiers enregistrés gardent leur version.',
  noPermission: "Vous n'avez pas l'autorisation de voir ceci.", acceptInvitation: "Accepter l'invitation", invitedAs: 'Vous êtes invité en tant que',
  resetPassword: 'Réinitialiser le mot de passe', newPassword: 'Nouveau mot de passe', liveConnected: 'En direct', liveOffline: 'Reconnexion…', freeSlots: 'Créneaux libres',
};
const ar: Dict = {
  vaccinationsDue: 'لقاحات مستحقة (30 يومًا)', deliveriesDue: 'ولادات متوقعة (60 يومًا)', patientArrived: 'وصل المريض', laterReleases: 'المدفوعات والتأمين تأتي في الإصدار 3.',
  tagline: 'رعاية صحية ذكية. ببساطة.', signIn: 'تسجيل الدخول', signOut: 'تسجيل الخروج', email: 'البريد الإلكتروني', password: 'كلمة المرور',
  createAccount: 'إنشاء حساب', forgot: 'نسيت كلمة المرور؟', continue: 'متابعة', save: 'حفظ', cancel: 'إلغاء', saved: 'تم الحفظ',
  loading: 'جارٍ التحميل…', search: 'بحث', add: 'إضافة', edit: 'تعديل', close: 'إغلاق', back: 'رجوع', yes: 'نعم', no: 'لا', none: 'لا شيء',
  dashboard: 'لوحة التحكم', calendar: 'التقويم', waitingRoom: 'غرفة الانتظار', patients: 'المرضى', settings: 'الإعدادات', team: 'الفريق',
  workspace: 'مساحة العمل', availability: 'أوقات العمل', specialty: 'قوالب الاختصاص', profile: 'ملفي الشخصي',
  registerDoctor: 'أنا طبيب مستقل', registerCenter: 'أدير مركزًا طبيًا', fullName: 'الاسم الكامل', phone: 'الهاتف',
  specialtyLabel: 'الاختصاص', license: 'رقم الترخيص', clinicName: 'اسم العيادة', centerName: 'اسم المركز', address: 'العنوان',
  consultationFee: 'رسوم المعاينة (دولار)', mfaCode: 'رمز التحقق', mfaPrompt: 'أدخل الرمز المكوّن من 6 أرقام من تطبيق المصادقة.',
  patientsToday: 'مرضى اليوم', waiting: 'في الانتظار', nextAppointment: 'الموعد التالي', newPatients: 'مرضى جدد (30 يومًا)',
  notifications: 'الإشعارات', quickActions: 'إجراءات سريعة', addPatient: 'إضافة مريض', newAppointment: 'موعد جديد',
  openCalendar: 'فتح التقويم', walkIn: 'بدون موعد', registerArrival: 'تسجيل الوصول', callIn: 'استدعاء', complete: 'إنهاء',
  noShow: 'لم يحضر', cancelAppt: 'إلغاء', confirm: 'تأكيد', todaysAppointments: 'مواعيد اليوم', pendingConfirmations: 'بانتظار التأكيد',
  waitingFor: 'انتظار', min: 'د', noOneWaiting: 'لا أحد في الانتظار.', noAppointments: 'لا توجد مواعيد.',
  dateOfBirth: 'تاريخ الميلاد', sex: 'الجنس', female: 'أنثى', male: 'ذكر', other: 'آخر', patientNumber: 'رقم المريض',
  whatsapp: 'واتساب', emergencyContact: 'جهة اتصال للطوارئ', bloodType: 'فصيلة الدم', allergies: 'الحساسية',
  chronicDiseases: 'الأمراض المزمنة', currentMedications: 'الأدوية الحالية', medicalHistory: 'التاريخ الطبي السابق',
  nationalId: 'رقم الهوية', language: 'اللغة', doctor: 'الطبيب', patient: 'المريض', service: 'الخدمة', duration: 'المدة (دقيقة)',
  start: 'البداية', room: 'الغرفة', notes: 'ملاحظات', recurrence: 'تكرار', noRepeat: 'بدون تكرار', weekly: 'أسبوعيًا', daily: 'يوميًا', times: 'مرات',
  overview: 'نظرة عامة', timeline: 'التسلسل الزمني', appointments: 'المواعيد', personal: 'المعلومات الشخصية', possibleDuplicate: 'تكرار محتمل',
  duplicateHelp: 'يوجد مريض ببيانات مشابهة في مساحة العمل هذه. تحقّق قبل إنشاء ملف جديد.',
  createAnyway: 'إنشاء على أي حال', invite: 'دعوة', role: 'الدور', permissions: 'الصلاحيات', status: 'الحالة', active: 'نشط', suspended: 'موقوف',
  assignTo: 'تعيين لطبيب', inviteLink: 'رابط الدعوة', emailAwaiting: 'إرسال البريد بانتظار بيانات اعتماد المزوّد. شارك هذا الرابط مباشرة.',
  workingHours: 'ساعات العمل', weekday: 'اليوم', from: 'من', to: 'إلى', theme: 'المظهر', light: 'فاتح', dark: 'داكن', system: 'النظام',
  twoFactor: 'المصادقة الثنائية', enable: 'تفعيل', disable: 'تعطيل', on: 'مفعّلة', off: 'معطّلة', locations: 'الفروع', rooms: 'الغرف', departments: 'الأقسام',
  day: 'يوم', week: 'أسبوع', today: 'اليوم', prev: 'السابق', next: 'التالي', customField: 'إضافة حقل مخصّص', fieldKey: 'مفتاح الحقل', fieldLabel: 'التسمية',
  fieldType: 'النوع', section: 'القسم', hide: 'إخفاء', show: 'إظهار', version: 'الإصدار', presetNote: 'كل تعديل ينشئ إصدارًا جديدًا. السجلات المحفوظة تحتفظ بإصدارها.',
  noPermission: 'ليست لديك صلاحية لعرض هذا.', acceptInvitation: 'قبول الدعوة', invitedAs: 'أنت مدعو بصفة',
  resetPassword: 'إعادة تعيين كلمة المرور', newPassword: 'كلمة مرور جديدة', liveConnected: 'مباشر', liveOffline: 'إعادة الاتصال…', freeSlots: 'أوقات متاحة',
};
const DICTS: Record<Lang, Dict> = { en: { ...en, ...CLINICAL.en, ...FINANCE.en, ...COMM.en, ...PORTAL.en }, fr: { ...fr, ...CLINICAL.fr, ...FINANCE.fr, ...COMM.fr, ...PORTAL.fr }, ar: { ...ar, ...CLINICAL.ar, ...FINANCE.ar, ...COMM.ar, ...PORTAL.ar } };

export const STATUS_LABEL: Record<Lang, Record<string, string>> = {
  en: { scheduled: 'Scheduled', confirmed: 'Confirmed', arrived: 'Arrived', waiting: 'Waiting', in_consultation: 'In consultation', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No-show' },
  fr: { scheduled: 'Planifié', confirmed: 'Confirmé', arrived: 'Arrivé', waiting: 'En attente', in_consultation: 'En consultation', completed: 'Terminé', cancelled: 'Annulé', no_show: 'Absent' },
  ar: { scheduled: 'مجدول', confirmed: 'مؤكد', arrived: 'وصل', waiting: 'ينتظر', in_consultation: 'في المعاينة', completed: 'مكتمل', cancelled: 'ملغى', no_show: 'لم يحضر' },
};
export const ROLE_LABEL: Record<Lang, Record<string, string>> = {
  en: { center_owner: 'Center owner', center_admin: 'Center administrator', doctor: 'Doctor', assistant: 'Assistant', receptionist: 'Receptionist', accountant: 'Accountant', insurance_admin: 'Insurance administrator' },
  fr: { center_owner: 'Propriétaire du centre', center_admin: 'Administrateur', doctor: 'Médecin', assistant: 'Assistant(e)', receptionist: 'Réceptionniste', accountant: 'Comptable', insurance_admin: 'Gestionnaire assurances' },
  ar: { center_owner: 'مالك المركز', center_admin: 'مدير المركز', doctor: 'طبيب', assistant: 'مساعد', receptionist: 'موظف استقبال', accountant: 'محاسب', insurance_admin: 'مسؤول التأمين' },
};

interface I18n { lang: Lang; setLang: (l: Lang) => void; t: (k: string) => string; dir: 'ltr' | 'rtl'; status: (s: string) => string; role: (r: string) => string }
const Ctx = createContext<I18n>(null as any);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>('en');
  useEffect(() => { const s = localStorage.getItem('medora.lang') as Lang | null; if (s && s in DICTS) setLangState(s); }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
  }, [lang]);
  const setLang = (l: Lang) => { localStorage.setItem('medora.lang', l); setLangState(l); };
  const t = (k: string) => DICTS[lang][k] ?? DICTS.en[k] ?? k;
  return <Ctx.Provider value={{ lang, setLang, t, dir: lang === 'ar' ? 'rtl' : 'ltr', status: (s) => STATUS_LABEL[lang][s] ?? s, role: (r) => ROLE_LABEL[lang][r] ?? r }}>{children}</Ctx.Provider>;
}
export const useI18n = () => useContext(Ctx);
