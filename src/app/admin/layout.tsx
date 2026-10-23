import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth-guard";
import { classifyAdminLayoutAuthFailure } from "@/lib/adminLayoutAuth";
import AdminShellClient from "./AdminShellClient";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";
import { getAccountViewAccess } from "@/lib/account-view-access";

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
        if (classifyAdminLayoutAuthFailure(error) === "LOGIN_REQUIRED") {
            redirect("/login?mode=staff&redirect=/admin");
        }

        // 권한 부족 또는 DB·인증 서비스 장애는 로그인 문제로 숨기지 않습니다.
        // 이 오류는 Next.js 오류 처리 계층에서 복구 방법과 함께 보여줍니다.
        throw error;
    }

    const { views } = await getAccountViewAccess();
    return (
        <AdminShellClient
            initialUserName={adminUser.appUserName || adminUser.user_metadata?.name || "관리자"}
            initialUserEmail={adminUser.email || ""}
            accountViews={views}
            // 시트 원장 은퇴(2026-10~) 면 시스템 도구의 「시트 동기화」 버튼을 숨긴다("0" 이면 옛 화면)
            sheetRetired={isSheetSyncRetired(process.env)}
        >
            {children}
        </AdminShellClient>
    );
}
