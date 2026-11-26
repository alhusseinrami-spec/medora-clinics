'use client';
import { PageTitle } from '@/components/Shell';
import { MySupport } from '@/components/Support';
import { useI18n } from '@/lib/i18n';
import { useWorkspace } from '@/lib/workspace';

export default function SupportPage() {
  const { t } = useI18n(); const { orgId } = useWorkspace();
  return <><PageTitle title={t('support')} /><MySupport organizationId={orgId} /></>;
}
