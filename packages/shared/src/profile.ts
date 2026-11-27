// Patient profile vocabularies shared by the API and the web app. Must match db/migrations/015_patient_profile.sql.
type L3 = { en: string; fr: string; ar: string };

/** Measurements that can be recorded on any patient, with their unit and how many decimals to show. */
export const MEASUREMENTS: Record<string, { label: L3; unit: string; decimals: number; min: number; max: number }> = {
  weight: { label: { en: 'Weight', fr: 'Poids', ar: 'الوزن' }, unit: 'kg', decimals: 1, min: 0.3, max: 400 },
  height: { label: { en: 'Height', fr: 'Taille', ar: 'الطول' }, unit: 'cm', decimals: 0, min: 20, max: 250 },
  bmi: { label: { en: 'BMI', fr: 'IMC', ar: 'مؤشر كتلة الجسم' }, unit: 'kg/m²', decimals: 1, min: 5, max: 90 },
  systolic: { label: { en: 'Systolic BP', fr: 'PA systolique', ar: 'الضغط الانقباضي' }, unit: 'mmHg', decimals: 0, min: 40, max: 300 },
  diastolic: { label: { en: 'Diastolic BP', fr: 'PA diastolique', ar: 'الضغط الانبساطي' }, unit: 'mmHg', decimals: 0, min: 20, max: 200 },
  heart_rate: { label: { en: 'Heart rate', fr: 'Fréquence cardiaque', ar: 'النبض' }, unit: '/min', decimals: 0, min: 20, max: 250 },
  temperature: { label: { en: 'Temperature', fr: 'Température', ar: 'الحرارة' }, unit: '°C', decimals: 1, min: 30, max: 45 },
  spo2: { label: { en: 'Oxygen saturation', fr: 'Saturation O₂', ar: 'تشبع الأكسجين' }, unit: '%', decimals: 0, min: 50, max: 100 },
  fasting_glucose: { label: { en: 'Fasting glucose', fr: 'Glycémie à jeun', ar: 'السكر على الريق' }, unit: 'mg/dL', decimals: 0, min: 20, max: 900 },
  hba1c: { label: { en: 'HbA1c', fr: 'HbA1c', ar: 'السكر التراكمي' }, unit: '%', decimals: 1, min: 3, max: 20 },
  ldl: { label: { en: 'LDL cholesterol', fr: 'Cholestérol LDL', ar: 'الكوليسترول الضار' }, unit: 'mg/dL', decimals: 0, min: 10, max: 500 },
  hdl: { label: { en: 'HDL cholesterol', fr: 'Cholestérol HDL', ar: 'الكوليسترول النافع' }, unit: 'mg/dL', decimals: 0, min: 5, max: 200 },
  triglycerides: { label: { en: 'Triglycerides', fr: 'Triglycérides', ar: 'الدهون الثلاثية' }, unit: 'mg/dL', decimals: 0, min: 10, max: 3000 },
  creatinine: { label: { en: 'Creatinine', fr: 'Créatinine', ar: 'الكرياتينين' }, unit: 'mg/dL', decimals: 2, min: 0.1, max: 20 },
  egfr: { label: { en: 'eGFR', fr: 'DFG estimé', ar: 'معدل الترشيح' }, unit: 'mL/min', decimals: 0, min: 1, max: 200 },
  tsh: { label: { en: 'TSH', fr: 'TSH', ar: 'TSH' }, unit: 'mIU/L', decimals: 2, min: 0.01, max: 100 },
  hemoglobin: { label: { en: 'Hemoglobin', fr: 'Hémoglobine', ar: 'الهيموغلوبين' }, unit: 'g/dL', decimals: 1, min: 2, max: 25 },
  inr: { label: { en: 'INR', fr: 'INR', ar: 'INR' }, unit: '', decimals: 1, min: 0.5, max: 10 },
};
export const MEASUREMENT_CODES = Object.keys(MEASUREMENTS);
/** Labs whose last value is worth a factual reminder ("HbA1c last recorded 4 months ago"). */
export const RECALL_LABS = ['hba1c', 'ldl', 'inr', 'tsh', 'creatinine'];

export const CLINICAL_ITEM_KINDS = ['problem', 'allergy', 'medication', 'immunization'] as const;
export const CLINICAL_ITEM_STATUSES: Record<(typeof CLINICAL_ITEM_KINDS)[number], string[]> = {
  problem: ['active', 'chronic', 'resolved'], allergy: ['active', 'resolved'], medication: ['active', 'stopped'], immunization: ['active'],
};

export const TOOTH_CONDITIONS = ['healthy', 'caries', 'filling', 'crown', 'root_canal', 'missing', 'implant', 'bridge', 'extraction_planned', 'fracture', 'sensitive', 'other'] as const;
/** FDI permanent teeth, in chart order: upper right to upper left, then lower right to lower left. */
export const PERMANENT_TEETH = { upper: [18, 17, 16, 15, 14, 13, 12, 11, 21, 22, 23, 24, 25, 26, 27, 28], lower: [48, 47, 46, 45, 44, 43, 42, 41, 31, 32, 33, 34, 35, 36, 37, 38] };
export const PRIMARY_TEETH = { upper: [55, 54, 53, 52, 51, 61, 62, 63, 64, 65], lower: [85, 84, 83, 82, 81, 71, 72, 73, 74, 75] };
export function isTooth(n: number): boolean {
  const q = Math.floor(n / 10), u = n % 10;
  return (q >= 1 && q <= 4 && u >= 1 && u <= 8) || (q >= 5 && q <= 8 && u >= 1 && u <= 5);
}

/** Purposes for which Lebanese Law 81/2018 asks for a separate, explicit answer. */
export const CONSENT_PURPOSES = ['chart_access', 'family_proxy', 'diaspora_payer', 'insurance_claims', 'photos', 'research'] as const;
/** Purposes whose consent names a person (who may be told, who pays). */
export const CONSENT_NEEDS_DETAIL = ['family_proxy', 'diaspora_payer'];
