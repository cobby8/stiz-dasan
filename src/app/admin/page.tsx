import AdminDashboardClient from "./AdminDashboardClient";
import { getCachedAdminDashboardPrimaryPayload } from "@/lib/adminReadPayloads";
import { getInboxCounts } from "@/lib/requests/admin-inbox";

// 30초 캐시: Server Action 호출 시 즉시 무효화됨
export const revalidate = 30;

export default async function AdminDashboard() {
    // «처리할 신청» 숫자는 신청함과 같은 개수(getInboxCounts — SQL 한 번)로 맞춘다
    const [initialData, inboxCounts] = await Promise.all([getCachedAdminDashboardPrimaryPayload(), getInboxCounts()]);

    return <AdminDashboardClient initialData={initialData} inboxCounts={inboxCounts} />;
}
