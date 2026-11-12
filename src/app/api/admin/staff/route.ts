import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth-guard";
import { getCachedAdminStaffPayload } from "@/lib/adminReadPayloads";
import { redactOwnerInviteTokens } from "@/lib/staff/staffRoster";

export const dynamic = "force-dynamic";

export async function GET() {
    let canManage = false;
    try {
        const admin = await requireAdmin();
        canManage = admin.appUserRole === "ADMIN";
    } catch {
        return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    try {
        const payload = await getCachedAdminStaffPayload();

        return NextResponse.json(
            // 부원장(보기 전용)에게는 원장·부원장 계정 초대의 링크 토큰을 싣지 않는다(페이지와 같은 기준, 보안 검수 ①)
            { ...payload, invitations: redactOwnerInviteTokens(payload.invitations, canManage) },
            {
                headers: {
                    "Cache-Control": "private, max-age=30, stale-while-revalidate=60",
                },
            },
        );
    } catch (error) {
        console.error("[api/admin/staff] failed:", error);
        return NextResponse.json({ error: "Failed to load staff" }, { status: 500 });
    }
}
