"use server";

import { requireAdmin } from "@/lib/auth-guard";
import { closeVirtualAccountByAdmin } from "@/lib/payment-ledger";

/**
 * 관리자 «가상계좌 닫기» — 학부모가 받은 입금 대기 계좌를 토스에서 닫는다(청구는 미납 그대로).
 *
 * Server Action 은 브라우저에서 직접 POST 로 부를 수 있으므로 첫 줄에서 권한을 다시 확인한다.
 * 권한 = 원장(ADMIN)만 — 현장 결제·단말기 반영과 같은 재무 권한 기준.
 * 오류는 throw 대신 { ok:false, message } 로 돌려준다(배포 환경은 throw 한 문구를 화면에 숨긴다).
 */
// paid: true = 닫는 사이 입금이 먼저 들어와 납부 완료로 반영됨(실패가 아님 — 화면은 성공 톤)
export async function closeVirtualAccountAction(paymentId: string): Promise<{ ok: true } | { ok: false; message: string; paid?: true }> {
    try {
        const admin = await requireAdmin();
        if (admin.appUserRole !== "ADMIN") return { ok: false, message: "원장만 가상계좌를 닫을 수 있습니다." };
        return await closeVirtualAccountByAdmin({ paymentId: String(paymentId ?? ""), adminUserId: admin.appUserId });
    } catch (error) {
        const message = String((error as Error)?.message ?? "");
        if (/권한|로그인/.test(message)) return { ok: false, message };
        console.error("[virtual-account-action]", message.slice(0, 300));
        return { ok: false, message: "가상계좌를 닫지 못했습니다. 잠시 후 다시 시도해 주세요." };
    }
}
