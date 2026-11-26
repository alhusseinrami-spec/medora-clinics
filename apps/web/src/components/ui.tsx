'use client';
import { useEffect, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { WORDMARK_CLINICS, WORDMARK_MEDORA, WORDMARK_VIEWBOX } from './logo-paths';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** MEDORA Clinics mark: the MEDORA Care cross (dark teal top and bottom, light teal sides, coral centre). */
export function LogoMark({ size = 32, onDark = false, onWhite = false }: { size?: number; onDark?: boolean; onWhite?: boolean }) {
  // onWhite: always the light-background colours (used inside the white tile, whatever the theme).
  const dark = onWhite ? '#115D62' : onDark ? '#E7EEF2' : 'var(--logo-dark)';
  return (
    <svg width={size} height={size} viewBox="0 0 208 208" aria-hidden className="shrink-0">
      <rect x="74" y="0" width="60" height="60" rx="12" fill={dark} />
      <rect x="74" y="148" width="60" height="60" rx="12" fill={dark} />
      <rect x="0" y="74" width="60" height="60" rx="12" fill="var(--logo-light)" />
      <rect x="148" y="74" width="60" height="60" rx="12" fill="var(--logo-light)" />
      <circle cx="104" cy="104" r="30" fill="var(--logo-coral)" />
    </svg>
  );
}

/** Full logo: mark plus the "Medora / CLINICS" wordmark, drawn as outlines so it renders the same everywhere. */
export function Logo({ size = 40, word = true, onDark = false, tile = false }: { size?: number; word?: boolean; onDark?: boolean; tile?: boolean }) {
  return (
    <span className="inline-flex items-center gap-[0.32em]" style={{ fontSize: size }} role="img" aria-label="Medora Clinics">
      {tile
        ? <span className="grid shrink-0 place-items-center rounded-[22%] bg-white" style={{ width: size * 1.25, height: size * 1.25 }}><LogoMark size={size * 0.8} onWhite /></span>
        : <LogoMark size={size} onDark={onDark} />}
      {word && (
        <svg height={size} viewBox={WORDMARK_VIEWBOX} aria-hidden className="shrink-0">
          <path d={WORDMARK_MEDORA} fill={onDark ? '#FFFFFF' : 'var(--logo-ink)'} />
          <path d={WORDMARK_CLINICS} fill={onDark ? 'rgba(255,255,255,0.85)' : 'var(--logo-sub)'} />
        </svg>
      )}
    </span>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'sm' | 'md'; busy?: boolean };
export function Button({ variant = 'primary', size = 'md', busy, className, children, disabled, ...p }: BtnProps) {
  return (
    <button {...p} disabled={disabled || busy} className={cx(
      'inline-flex items-center justify-center gap-2 rounded-[10px] font-medium transition disabled:opacity-50 disabled:cursor-not-allowed',
      size === 'sm' ? 'h-8 px-3 text-sm' : 'h-10 px-4 text-sm',
      variant === 'primary' && 'bg-brand text-white hover:brightness-110',
      variant === 'secondary' && 'border border-line bg-card hover:bg-surface',
      variant === 'ghost' && 'hover:bg-brand-soft text-ink',
      variant === 'danger' && 'bg-danger text-white hover:brightness-110', className)}>
      {busy && <span className="size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />}{children}
    </button>
  );
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: ReactNode; error?: string; children: ReactNode; className?: string }) {
  return (
    <label className={cx('block', className)}>
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-danger">{error}</span>}
    </label>
  );
}
const control = 'w-full rounded-[10px] border border-line bg-card px-3 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20';
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(control, 'h-10', p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea rows={3} {...p} className={cx(control, 'py-2', p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(control, 'h-10', p.className)} />;

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-[12px] border border-line bg-card', className)}>
      {(title || actions) && <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
        <h2 className="font-[family-name:var(--font-display)] text-[15px] font-semibold">{title}</h2>{actions}</header>}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Stat({ label, value, tone = 'brand', sub }: { label: string; value: ReactNode; tone?: 'brand' | 'accent' | 'warning' | 'info'; sub?: ReactNode }) {
  const bar = { brand: 'bg-brand', accent: 'bg-accent', warning: 'bg-warning', info: 'bg-info' }[tone];
  return (
    <div className="relative overflow-hidden rounded-[12px] border border-line bg-card p-4">
      <span className={cx('absolute inset-y-0 start-0 w-1', bar)} />
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="tabular mt-1.5 font-[family-name:var(--font-display)] text-2xl font-semibold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted">{sub}</p>}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  scheduled: 'bg-line text-ink', confirmed: 'bg-info/15 text-info', arrived: 'bg-accent/20 text-accent', waiting: 'bg-warning/15 text-warning',
  in_consultation: 'bg-brand/15 text-brand', completed: 'bg-success/15 text-success', cancelled: 'bg-danger/15 text-danger', no_show: 'bg-danger/15 text-danger',
  draft: 'bg-warning/15 text-warning', signed: 'bg-success/15 text-success', issued: 'bg-info/15 text-info', void: 'bg-line text-muted', paid: 'bg-success/15 text-success', unpaid: 'bg-warning/15 text-warning',
  trial: 'bg-info/15 text-info', active: 'bg-success/15 text-success', past_due: 'bg-warning/15 text-warning', trial_expired: 'bg-danger/15 text-danger', expired: 'bg-danger/15 text-danger', suspended: 'bg-danger/15 text-danger',
  open: 'bg-warning/15 text-warning', answered: 'bg-info/15 text-info', closed: 'bg-line text-muted', refunded: 'bg-line text-muted',
  submitted: 'bg-info/15 text-info', approved: 'bg-success/15 text-success', partially_approved: 'bg-warning/15 text-warning', rejected: 'bg-danger/15 text-danger', reimbursed: 'bg-success/15 text-success',
};
export function Badge({ children, status, className }: { children: ReactNode; status?: string; className?: string }) {
  return <span className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', status ? STATUS_TONE[status] : 'bg-brand-soft text-brand', className)}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-[10px] border border-dashed border-line px-4 py-8 text-center text-sm text-muted">{children}</p>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const e = error as any;
  return <div role="alert" className="rounded-[10px] border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger">
    {e.message ?? String(e)}{e.details?.length ? <ul className="mt-1 list-disc ps-5">{e.details.map((d: string) => <li key={d}>{d}</li>)}</ul> : null}
  </div>;
}

export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal className={cx('w-full rounded-[14px] border border-line bg-card shadow-xl', wide ? 'max-w-2xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="font-[family-name:var(--font-display)] font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded p-1 text-muted hover:bg-surface" aria-label="Close">✕</button>
        </header>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: string }[]; value: string; onChange: (k: string) => void }) {
  return <div className="flex gap-1 border-b border-line">{tabs.map((t) => (
    <button key={t.key} onClick={() => onChange(t.key)} className={cx('-mb-px border-b-2 px-3 py-2 text-sm font-medium', value === t.key ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink')}>{t.label}</button>
  ))}</div>;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative h-5 w-9 shrink-0 rounded-full transition disabled:opacity-40', checked ? 'bg-brand' : 'bg-line')}>
      <span className={cx('absolute top-0.5 size-4 rounded-full bg-white shadow transition-all', checked ? 'start-[18px]' : 'start-0.5')} />
    </button>
  );
}

export const fmtTime = (iso: string, lang = 'en') => new Date(iso).toLocaleTimeString(lang === 'ar' ? 'ar-LB' : lang, { hour: '2-digit', minute: '2-digit' });
export const fmtDate = (iso: string, lang = 'en') => new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-LB' : lang, { day: 'numeric', month: 'short', year: 'numeric' });

/** Money with its currency; LBP without decimals. */
export const fmtMoney = (n: number | string | null | undefined, cur = 'USD', lang = 'en') => {
  const v = Number(n ?? 0);
  return `${v.toLocaleString(lang === 'ar' ? 'ar-LB' : lang, { minimumFractionDigits: cur === 'LBP' ? 0 : 2, maximumFractionDigits: cur === 'LBP' ? 0 : 2 })} ${cur === 'USD' ? '$' : 'LBP'}`;
};
