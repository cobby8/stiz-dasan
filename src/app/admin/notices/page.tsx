import { requireAdmin } from "@/lib/auth-guard";
import NoticesAdminClient from "./NoticesAdminClient";
import { getCachedAdminNoticesPayload } from "@/lib/adminReadPayloads";

export const revalidate = 30;

export default async function AdminNoticesPage() {
    // 레이아웃 검사만 믿지 않고 화면마다 관리자 확인(d3 — 레이아웃이 바뀌거나 우회돼도 데이터가 새지 않게)
    await requireAdmin();
    const { notices, classes, pagination } = await getCachedAdminNoticesPayload();

    return <NoticesAdminClient notices={notices} classes={classes} pagination={pagination} />;
}
