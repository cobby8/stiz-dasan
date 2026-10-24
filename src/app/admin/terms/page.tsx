import TermsAdminClient from "./TermsAdminClient";
import { getCachedAdminSettingsPayload } from "@/lib/adminReadPayloads";

// 30초 캐시: Server Action 호출 시 즉시 무효화
export const revalidate = 30;

export default async function AdminTermsPage() {
    const { settings, fetchError } = await getCachedAdminSettingsPayload();

    return <TermsAdminClient termsOfService={settings?.termsOfService ?? ""} fetchError={fetchError} />;
}
