import { requireAdmin } from "@/lib/auth-guard";
import FeedbackManagementClient from "./FeedbackManagementClient";
import { getCachedAdminFeedbackPayload } from "@/lib/adminReadPayloads";

// 30초 캐시: 아무도 수정 안 할 때 캐시 유지, Server Action 호출 시 즉시 무효화
export const revalidate = 30;

export default async function FeedbackPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const { feedbacks } = await getCachedAdminFeedbackPayload();

    return <FeedbackManagementClient feedbacks={feedbacks} />;
}
