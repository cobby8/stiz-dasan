import BillingTemplateClient from "./BillingTemplateClient";
import { getCachedAdminBillingPayload } from "@/lib/adminReadPayloads";
import { requireAdmin } from "@/lib/auth-guard";

// 30초 캐시: Server Action 호출 시 즉시 무효화
export const revalidate = 30;

export default async function BillingTemplatePage() {
  await requireAdmin();
    const { templates, programs } = await getCachedAdminBillingPayload();

    return <BillingTemplateClient initialTemplates={templates} programs={programs} />;
}
