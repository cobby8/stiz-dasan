import { requireAdmin } from "@/lib/auth-guard";
import ApplyAdminClient from "./ApplyAdminClient";
import { getCachedAdminTrialPayload } from "@/lib/adminReadPayloads";

export const revalidate = 30;

export default async function AdminApplyPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const trialPayload = await getCachedAdminTrialPayload({ limit: 50, offset: 0 });

    return (
        <ApplyAdminClient
            initialTrialLeads={trialPayload.leads}
            initialTrialStats={trialPayload.stats}
            initialTrialClasses={trialPayload.classes}
            initialTrialPagination={trialPayload.pagination}
        />
    );
}
