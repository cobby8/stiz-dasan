import FinanceClient from "./FinanceClient";
import Link from "next/link";
import { getCachedAdminFinancePayload } from "@/lib/adminReadPayloads";
import { requireAdmin } from "@/lib/auth-guard";
import { isBillingParentSendEnabled } from "@/lib/billing/parentSendGuard";
import { isSheetSyncRetired } from "@/lib/operations-sync/sheetRetirement";
import { todayKst } from "@/lib/datetime/kst";

// 30초 캐시: 아무도 수정 안 할 때 캐시 유지, Server Action 호출 시 즉시 무효화
export const revalidate = 30;

export default async function AdminFinancePage() {
    // 이번 달 = KST 기준. 서버(UTC)의 getMonth() 는 매월 1일 KST 00~09시에 지난달을 연다.
    const [initialYear, initialMonth] = todayKst().split("-").map(Number);
    const [adminUser, payload] = await Promise.all([
        requireAdmin(),
        getCachedAdminFinancePayload(initialYear, initialMonth),
    ]);
    const { payments, summary, paymentProvider } = payload;

    return (
        <>
            <FinanceClient
                initialPayments={payments}
                initialYear={initialYear}
                initialMonth={initialMonth}
                initialSummary={summary}
                initialPaymentProvider={paymentProvider}
                currentAdminRole={adminUser.appUserRole}
                // 학부모 청구 안내 사이트 발송 잠금 여부(서버 환경변수로만 판정)
                billingParentSendEnabled={isBillingParentSendEnabled()}
                // 시트 원장 은퇴(2026-10~) 면 「시트 점검」 버튼·패널을 숨긴다("0" 이면 옛 화면)
                sheetRetired={isSheetSyncRetired(process.env)}
            />
            <details className="mt-4 text-sm text-gray-500"><summary className="min-h-11 cursor-pointer py-3">장부 점검</summary><Link href="/admin/finance/monthly-ledger" className="inline-flex min-h-11 items-center underline">월별·반별 장부 점검 (조회 전용)</Link></details>
        </>
    );
}
