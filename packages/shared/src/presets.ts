// Platform presets for the specialty engine: the patient profile sections each specialty starts with,
// plus the dashboard widgets it shows. Synced into clinical_templates by db/sync_presets.js.
import type { Field, Section, TemplateSchema, Label } from './templates.js';

const L = (en: string, fr: string, ar: string): Label => ({ en, fr, ar });
const t = (key: string, en: string, o: Partial<Field> = {}): Field => ({ key, type: 'text', label: en, optional: true, ...o });
const ta = (key: string, en: string, o: Partial<Field> = {}): Field => ({ key, type: 'textarea', label: en, optional: true, ...o });
const n = (key: string, en: string, unit: string, min: number, max: number, o: Partial<Field> = {}): Field => ({ key, type: 'number', label: en, unit, min, max, optional: true, ...o });
const d = (key: string, en: string, o: Partial<Field> = {}): Field => ({ key, type: 'date', label: en, optional: true, ...o });
const b = (key: string, en: string): Field => ({ key, type: 'boolean', label: en, optional: true });
const sel = (key: string, en: string, opts: string[], o: Partial<Field> = {}): Field => ({
  key, type: 'select', label: en, optional: true, ...o,
  options: opts.map((v) => ({ value: v, label: v.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) })),
});
const multi = (key: string, en: string, opts: string[]): Field => ({ ...sel(key, en, opts), type: 'multiselect' });
const rep = (key: string, en: string, fields: Field[]): Field => ({ key, type: 'repeat', label: en, optional: true, fields });
const comp = (key: string, en: string, compute: string): Field => ({ key, type: 'computed', label: en, compute });

const VITALS: Section = {
  key: 'vitals', label: L('Vital signs', 'Signes vitaux', 'العلامات الحيوية'), widget: 'vitals_trend',
  fields: [
    n('weight_kg', 'Weight', 'kg', 0.3, 400), n('height_cm', 'Height', 'cm', 20, 250), comp('bmi', 'BMI', 'bmi'),
    n('systolic', 'Systolic BP', 'mmHg', 50, 260), n('diastolic', 'Diastolic BP', 'mmHg', 30, 160),
    n('heart_rate', 'Heart rate', 'bpm', 20, 250), n('temperature_c', 'Temperature', '°C', 30, 44, { step: 0.1 }),
    n('spo2', 'SpO2', '%', 50, 100),
  ],
};
const GENERAL_HISTORY: Section = {
  key: 'history', label: L('Medical history', 'Antécédents médicaux', 'التاريخ الطبي'),
  fields: [
    ta('chronic_diseases', 'Chronic diseases'), ta('past_history', 'Previous medical history'), ta('surgeries', 'Surgeries'),
    ta('current_medications', 'Current medications'), ta('allergies', 'Allergies'), ta('family_history', 'Family history'),
    sel('smoking', 'Smoking', ['never', 'former', 'current']), ta('preventive_care', 'Preventive care and screening'),
  ],
};

export interface Preset { specialty: string; kind: 'patient_profile' | 'dashboard' | 'examination'; name: string; schema: TemplateSchema }

const profile = (specialty: string, name: string, sections: Section[], widgets: string[]): Preset[] => [
  { specialty, kind: 'patient_profile', name, schema: { format: 1, sections } },
  { specialty, kind: 'dashboard', name: `${name} dashboard`, schema: { format: 1, sections: [], widgets } },
];

const COMMON_WIDGETS = ['patients_today', 'waiting_room', 'next_appointment', 'new_patients', 'notifications'];

export const PRESETS: Preset[] = [
  ...profile('pediatrics', 'Pediatric profile', [
    { key: 'birth', label: L('Birth history', 'Antécédents de naissance', 'تاريخ الولادة'), fields: [
      n('gestational_age_weeks', 'Gestational age at birth', 'weeks', 20, 45), n('birth_weight_kg', 'Birth weight', 'kg', 0.3, 7, { step: 0.01 }),
      n('birth_length_cm', 'Birth length', 'cm', 20, 65), n('birth_head_cm', 'Head circumference at birth', 'cm', 20, 45),
      sel('delivery', 'Delivery', ['vaginal', 'c_section', 'assisted']), ta('neonatal_notes', 'Neonatal notes'),
      comp('age', 'Current age', 'age'),
    ] },
    { key: 'growth', label: L('Growth monitoring', 'Suivi de croissance', 'مراقبة النمو'), widget: 'growth_chart', fields: [
      rep('measurements', 'Measurements', [d('date', 'Date', { required: true }), n('weight_kg', 'Weight', 'kg', 0.3, 150, { step: 0.01 }),
        n('height_cm', 'Height', 'cm', 20, 220), n('head_cm', 'Head circumference', 'cm', 20, 65)]),
    ] },
    { key: 'milestones', label: L('Developmental milestones', 'Étapes du développement', 'مراحل النمو'), fields: [
      rep('items', 'Milestones', [t('milestone', 'Milestone', { required: true }), d('achieved_on', 'Achieved on'), t('notes', 'Notes')]),
    ] },
    { key: 'vaccinations', label: L('Vaccinations', 'Vaccinations', 'اللقاحات'), widget: 'vaccination_schedule', fields: [
      rep('doses', 'Doses', [t('vaccine', 'Vaccine', { required: true }), n('dose_number', 'Dose', '#', 1, 10), d('given_on', 'Given on'),
        d('next_due', 'Next due'), t('lot', 'Lot number')]),
    ] },
    { key: 'nutrition', label: L('Feeding and nutrition', 'Alimentation', 'التغذية'), fields: [
      sel('feeding', 'Feeding', ['breastfeeding', 'formula', 'mixed', 'solids', 'family_diet']), ta('nutrition_notes', 'Nutrition history'),
    ] },
    { key: 'history', label: L('Pediatric history', 'Antécédents pédiatriques', 'التاريخ المرضي للطفل'), fields: [
      ta('allergies', 'Allergies'), ta('past_illnesses', 'Past illnesses and hospitalizations'), ta('family_history', 'Family history'),
    ] },
  ], [...COMMON_WIDGETS, 'vaccinations_due', 'growth_followups']),

  ...profile('obgyn', 'Gynecology and obstetrics profile', [
    { key: 'menstrual', label: L('Menstrual history', 'Antécédents menstruels', 'التاريخ الطمثي'), fields: [
      n('menarche_age', 'Age at menarche', 'years', 7, 20), n('cycle_length_days', 'Cycle length', 'days', 15, 90),
      n('period_length_days', 'Period length', 'days', 1, 15), sel('regularity', 'Regularity', ['regular', 'irregular']), b('dysmenorrhea', 'Dysmenorrhea'),
    ] },
    { key: 'pregnancy', label: L('Current pregnancy', 'Grossesse actuelle', 'الحمل الحالي'), widget: 'pregnancy_tracker', fields: [
      b('pregnant', 'Currently pregnant'), d('lmp', 'Last menstrual period'), comp('edd', 'Estimated delivery date', 'edd'),
      comp('gestational_age', 'Gestational age', 'gestational_age'), sel('risk', 'Risk level', ['low', 'moderate', 'high']),
      rep('prenatal_visits', 'Prenatal visits', [d('date', 'Date', { required: true }), n('weight_kg', 'Weight', 'kg', 30, 200),
        n('systolic', 'Systolic BP', 'mmHg', 60, 220), n('fundal_height_cm', 'Fundal height', 'cm', 5, 50), t('notes', 'Notes')]),
    ] },
    { key: 'obstetric', label: L('Obstetric history', 'Antécédents obstétricaux', 'التاريخ التوليدي'), fields: [
      n('gravida', 'Gravida', '', 0, 30), n('para', 'Para', '', 0, 30), n('abortions', 'Abortions / miscarriages', '', 0, 30),
      rep('pregnancies', 'Previous pregnancies', [n('year', 'Year', '', 1950, 2100), sel('outcome', 'Outcome', ['live_birth', 'miscarriage', 'stillbirth', 'ectopic', 'termination']),
        sel('delivery', 'Delivery', ['vaginal', 'c_section', 'assisted']), t('notes', 'Complications')]),
    ] },
    { key: 'gynecology', label: L('Gynecological history', 'Antécédents gynécologiques', 'التاريخ النسائي'), fields: [
      sel('contraception', 'Contraception', ['none', 'pill', 'iud', 'implant', 'condom', 'injection', 'other']),
      d('last_pap_smear', 'Last Pap smear'), ta('gyn_conditions', 'Gynecological conditions'),
    ] },
  ], [...COMMON_WIDGETS, 'pregnancies_due', 'prenatal_followups']),

  ...profile('orthopedics', 'Orthopedic profile', [
    { key: 'musculoskeletal', label: L('Musculoskeletal history', 'Antécédents musculo-squelettiques', 'التاريخ العضلي الهيكلي'), widget: 'body_map', fields: [
      multi('pain_locations', 'Pain location', ['neck', 'shoulder_left', 'shoulder_right', 'elbow_left', 'elbow_right', 'wrist_left', 'wrist_right', 'back_upper', 'back_lower', 'hip_left', 'hip_right', 'knee_left', 'knee_right', 'ankle_left', 'ankle_right']),
      n('pain_intensity', 'Pain intensity', '0-10', 0, 10), ta('mobility', 'Mobility assessment'),
    ] },
    { key: 'injuries', label: L('Fractures and injuries', 'Fractures et blessures', 'الكسور والإصابات'), fields: [
      rep('items', 'Injuries', [t('description', 'Injury or fracture', { required: true }), d('date', 'Date'), t('treatment', 'Treatment')]),
    ] },
    { key: 'rom', label: L('Range of motion', 'Amplitude articulaire', 'مدى الحركة'), fields: [
      rep('joints', 'Joints', [t('joint', 'Joint', { required: true }), n('flexion_deg', 'Flexion', '°', 0, 180), n('extension_deg', 'Extension', '°', 0, 180), t('notes', 'Notes')]),
    ] },
    { key: 'rehab', label: L('Rehabilitation', 'Rééducation', 'إعادة التأهيل'), fields: [ta('plan', 'Rehabilitation plan'), ta('progress', 'Progress notes')] },
  ], [...COMMON_WIDGETS, 'followup_exams']),

  ...profile('dentistry', 'Dental profile', [
    { key: 'dental_chart', label: L('Dental chart (FDI)', 'Schéma dentaire (FDI)', 'مخطط الأسنان'), widget: 'dental_chart', fields: [
      rep('teeth', 'Teeth', [n('tooth', 'Tooth (FDI)', '', 11, 85, { required: true }),
        sel('condition', 'Condition', ['healthy', 'caries', 'filled', 'crown', 'missing', 'implant', 'root_canal', 'bridge', 'fractured']), t('surface', 'Surfaces'), t('notes', 'Notes')]),
    ] },
    { key: 'dental_history', label: L('Dental history', 'Antécédents dentaires', 'التاريخ السني'), fields: [
      d('last_visit', 'Last dental visit'), sel('hygiene', 'Oral hygiene', ['good', 'fair', 'poor']), b('bleeding_gums', 'Bleeding gums'),
      b('sensitivity', 'Sensitivity'), ta('notes', 'Dental history notes'),
    ] },
    { key: 'treatment_plan', label: L('Treatment plan', 'Plan de traitement', 'خطة العلاج'), fields: [
      rep('steps', 'Planned procedures', [n('tooth', 'Tooth (FDI)', '', 11, 85), t('procedure', 'Procedure', { required: true }),
        n('session', 'Session', '#', 1, 50), sel('status', 'Status', ['planned', 'in_progress', 'done'])]),
    ] },
  ], [...COMMON_WIDGETS, 'treatment_sessions']),

  ...profile('dermatology', 'Dermatology profile', [
    { key: 'skin', label: L('Skin profile', 'Profil cutané', 'ملف البشرة'), fields: [
      sel('fitzpatrick', 'Fitzpatrick skin type', ['I', 'II', 'III', 'IV', 'V', 'VI']), ta('skin_conditions', 'Known skin conditions'), ta('allergies', 'Allergies'),
    ] },
    { key: 'lesions', label: L('Lesions', 'Lésions', 'الآفات'), widget: 'body_map', fields: [
      rep('items', 'Lesions', [t('location', 'Body location', { required: true }), t('type', 'Type'), n('size_mm', 'Size', 'mm', 0, 500), d('first_seen', 'First noted'), t('notes', 'Notes')]),
    ] },
    { key: 'procedures', label: L('Treatments and aesthetic procedures', 'Traitements et esthétique', 'العلاجات والإجراءات التجميلية'), fields: [
      rep('items', 'Procedures', [d('date', 'Date', { required: true }), t('procedure', 'Procedure', { required: true }), t('area', 'Area'), t('notes', 'Notes')]),
    ] },
  ], [...COMMON_WIDGETS, 'photo_followups']),

  ...profile('cardiology', 'Cardiology profile', [
    VITALS,
    { key: 'cardio_history', label: L('Cardiovascular history', 'Antécédents cardiovasculaires', 'التاريخ القلبي الوعائي'), fields: [
      multi('risk_factors', 'Risk factors', ['hypertension', 'diabetes', 'dyslipidemia', 'smoking', 'obesity', 'family_history', 'ckd']),
      ta('conditions', 'Cardiac conditions'), ta('procedures', 'Procedures (stent, bypass, ablation...)'), ta('medications', 'Cardiac medications'),
    ] },
    { key: 'ecg', label: L('ECG records', 'ECG', 'تخطيط القلب'), fields: [
      rep('items', 'ECGs', [d('date', 'Date', { required: true }), t('rhythm', 'Rhythm'), n('rate', 'Rate', 'bpm', 20, 250), t('findings', 'Findings')]),
    ] },
    { key: 'echo', label: L('Echocardiography', 'Échocardiographie', 'تخطيط صدى القلب'), fields: [
      rep('items', 'Echo reports', [d('date', 'Date', { required: true }), n('ef_percent', 'Ejection fraction', '%', 5, 90), t('findings', 'Findings')]),
    ] },
  ], [...COMMON_WIDGETS, 'bp_followups']),

  ...profile('general_practice', 'General practice profile', [VITALS, GENERAL_HISTORY], [...COMMON_WIDGETS, 'chronic_followups']),
];

const exam = (specialty: string, name: string, sections: Section[]): Preset => ({ specialty, kind: 'examination', name, schema: { format: 1, sections } });
const GENERAL_EXAM: Section = { key: 'general', label: L('General examination', 'Examen général', 'الفحص العام'), fields: [
  sel('appearance', 'General appearance', ['well', 'unwell', 'distressed']), ta('cardiovascular', 'Cardiovascular'), ta('respiratory', 'Respiratory'),
  ta('abdomen', 'Abdomen'), ta('neuro', 'Neurological'), ta('skin', 'Skin'), ta('other_findings', 'Other findings'),
] };

/** Examination forms used inside a consultation (Release 2). Same engine, same versioning as the profile. */
export const EXAM_PRESETS: Preset[] = [
  exam('pediatrics', 'Pediatric examination', [
    { key: 'growth', label: L('Measurements', 'Mesures', 'القياسات'), fields: [n('weight_kg', 'Weight', 'kg', 0.3, 150, { step: 0.01 }), n('height_cm', 'Height', 'cm', 20, 220), n('head_cm', 'Head circumference', 'cm', 20, 65), n('temperature_c', 'Temperature', '°C', 30, 44, { step: 0.1 })] },
    { key: 'development', label: L('Development', 'Développement', 'النمو'), fields: [sel('development', 'Development for age', ['appropriate', 'delayed', 'to_review']), ta('milestones_notes', 'Milestones observed')] },
    GENERAL_EXAM,
  ]),
  exam('obgyn', 'Gynecological / obstetric examination', [
    { key: 'obstetric', label: L('Obstetric examination', 'Examen obstétrical', 'الفحص التوليدي'), fields: [n('fundal_height_cm', 'Fundal height', 'cm', 5, 50), n('fetal_heart_rate', 'Fetal heart rate', 'bpm', 60, 220), sel('presentation', 'Presentation', ['cephalic', 'breech', 'transverse', 'unknown']), b('fetal_movements', 'Fetal movements felt')] },
    { key: 'gynecological', label: L('Gynecological examination', 'Examen gynécologique', 'الفحص النسائي'), fields: [ta('external', 'External examination'), ta('speculum', 'Speculum'), ta('bimanual', 'Bimanual')] },
    { key: 'ultrasound', label: L('Ultrasound', 'Échographie', 'الموجات فوق الصوتية'), fields: [ta('ultrasound_findings', 'Ultrasound findings'), n('estimated_fetal_weight_g', 'Estimated fetal weight', 'g', 10, 6000)] },
  ]),
  exam('orthopedics', 'Orthopedic examination', [
    { key: 'joint', label: L('Joint examination', 'Examen articulaire', 'فحص المفاصل'), widget: 'body_map', fields: [t('joint', 'Joint examined'), n('pain_intensity', 'Pain intensity', '0-10', 0, 10), n('flexion_deg', 'Flexion', '°', 0, 180), n('extension_deg', 'Extension', '°', 0, 180), b('swelling', 'Swelling'), b('instability', 'Instability'), ta('special_tests', 'Special tests')] },
    { key: 'imaging', label: L('Imaging', 'Imagerie', 'التصوير'), fields: [sel('imaging_type', 'Imaging', ['none', 'x_ray', 'mri', 'ct', 'ultrasound']), ta('imaging_findings', 'Findings')] },
  ]),
  exam('dentistry', 'Dental examination', [
    { key: 'procedures', label: L('Procedures this session', 'Actes de la séance', 'إجراءات الجلسة'), widget: 'dental_chart', fields: [
      rep('teeth', 'Teeth treated', [n('tooth', 'Tooth (FDI)', '', 11, 85, { required: true }), t('procedure', 'Procedure', { required: true }), t('surface', 'Surfaces'), t('notes', 'Notes')])] },
    { key: 'oral', label: L('Oral examination', 'Examen buccal', 'الفحص الفموي'), fields: [sel('gingiva', 'Gingiva', ['healthy', 'gingivitis', 'periodontitis']), ta('soft_tissues', 'Soft tissues'), ta('occlusion', 'Occlusion')] },
  ]),
  exam('dermatology', 'Skin examination', [
    { key: 'lesion', label: L('Lesion examination', 'Examen des lésions', 'فحص الآفات'), widget: 'body_map', fields: [
      rep('lesions', 'Lesions', [t('location', 'Location', { required: true }), t('morphology', 'Morphology'), n('size_mm', 'Size', 'mm', 0, 500), t('dermoscopy', 'Dermoscopy')])] },
    { key: 'aesthetic', label: L('Aesthetic procedure', 'Acte esthétique', 'الإجراء التجميلي'), fields: [t('procedure', 'Procedure'), t('area', 'Area'), t('product', 'Product / settings'), ta('notes', 'Notes')] },
  ]),
  exam('cardiology', 'Cardiovascular examination', [
    { ...VITALS, key: 'vitals' },
    { key: 'cardio', label: L('Cardiovascular examination', 'Examen cardiovasculaire', 'الفحص القلبي الوعائي'), fields: [ta('heart_sounds', 'Heart sounds'), t('murmur', 'Murmur'), b('edema', 'Peripheral edema'), ta('pulses', 'Peripheral pulses'), ta('ecg_today', 'ECG today')] },
  ]),
  exam('general_practice', 'General examination', [{ ...VITALS, key: 'vitals' }, GENERAL_EXAM]),
];

/** Specialties without a full preset start from the general practice base (prepared, not yet specialized). */
export const BASE_SPECIALTY = 'general_practice';
