'use client';
import type { ReactNode } from 'react';
import { Logo } from '@/components/ui';
import { useI18n, type Lang } from '@/lib/i18n';

export function AuthFrame({ title, children, wide }: { title: string; children: ReactNode; wide?: boolean }) {
  const { t, lang, setLang } = useI18n();
  return (
    <div className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <div className="relative hidden flex-col justify-between overflow-hidden bg-brand p-12 text-white lg:flex">
        <svg className="absolute -end-24 top-24 opacity-10" width="520" height="520" viewBox="0 0 64 64" aria-hidden><path d="M12 44 V22 L22 34 L32 18 L42 34 L52 22 V44" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        <div className="[&_*]:!text-white"><Logo size={40} /></div>
        <div><p className="font-[family-name:var(--font-display)] text-4xl font-semibold leading-tight">{t('tagline')}</p>
          <p className="mt-4 max-w-md text-white/75">One account for every workplace. A workspace that adapts to your specialty. A live waiting room for your team.</p></div>
        <p className="text-xs text-white/60">Development build · synthetic data only</p>
      </div>
      <div className="flex flex-col items-center justify-center px-5 py-10">
        <div className="mb-6 flex w-full justify-end lg:hidden"><Logo /></div>
        <div className={wide ? 'w-full max-w-xl' : 'w-full max-w-sm'}>
          <div className="mb-6 flex items-center justify-between"><h1 className="font-[family-name:var(--font-display)] text-2xl font-semibold">{title}</h1>
            <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="rounded-md border border-line bg-card px-2 py-1 text-sm" aria-label="Language"><option value="en">EN</option><option value="fr">FR</option><option value="ar">ع</option></select></div>
          {children}
        </div>
      </div>
    </div>
  );
}
