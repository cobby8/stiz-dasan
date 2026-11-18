import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { classifyAdminLayoutAuthFailure, forbiddenAdminDestination } from "@/lib/adminLayoutAuth";
import { resolveContinueDestination } from "@/lib/auth/continue-destination";
import AdminShellClient from "./AdminShellClient";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";
import { getAccountViewAccess } from "@/lib/account-view-access";
import { getInboxCounts } from "@/lib/requests/admin-inbox";
import { canSeeAllMoney, canSeeStats } from "@/lib/auth/moneyAccess";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    let adminUser: Awaited<ReturnType<typeof requireAdmin>>;

    try {
        adminUser = await requireAdmin();
    } catch (error) {
        const failure = classifyAdminLayoutAuthFailure(error);
        if (failure === "LOGIN_REQUIRED") {
            redirect("/login?redirect=/admin");
        }
        if (failure === "FORBIDDEN") {
            // 관리자 권한이 없는 계정(학부모·선생님 등)은 오류 화면 대신 그 계정이 쓰는 화면으로 보낸다(2026-11-18).
            // 목적지는 로그인 뒤와 같은 함수가 정한다. 다시 관리자 화면이 나오면 반복되므로 보내지 않는다.
            const destination = forbiddenAdminDestination(
                await resolveContinueDestination({ bounced: true }).catch(() => null),
            );
            if (destination) redirect(destination);
        }

        // DB·인증 서비스 장애는 로그인 문제로 숨기지 않습니다.
        // 이 오류는 Next.js 오류 처리 계층에서 복구 방법과 함께 보여줍니다.
        throw error;
    }

    // 메뉴 «신청함 N» 배지 — SQL 한 번. 실패하면 null 이라 배지만 숨고 화면은 그대로 열린다.
    const [{ views }, inboxCounts] = await Promise.all([getAccountViewAccess(), getInboxCounts()]);
    return (
        <AdminShellClient
            initialUserName={adminUser.appUserName || adminUser.user_metadata?.name || "관리자"}
            initialUserEmail={adminUser.email || ""}
            accountViews={views}
            inboxCount={inboxCounts?.action ?? null}
            // 시트 원장 은퇴(2026-10~) 면 시스템 도구의 「시트 동기화」 버튼을 숨긴다("0" 이면 옛 화면)
            sheetRetired={isSheetSyncRetired(process.env)}
            // 2026-11-14 부원장 금액 가림: 부원장이면 통계 메뉴·시스템 도구·원장 전용 탭(POS 대사)을 숨긴다
            canSeeStats={canSeeStats(adminUser.appUserRole)}
            isOwner={canSeeAllMoney(adminUser.appUserRole)}
        >
            {children}
        </AdminShellClient>
    );
}
