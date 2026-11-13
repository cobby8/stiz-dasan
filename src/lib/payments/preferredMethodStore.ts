// 서버 전용(prisma) — "server-only" 표시는 넣지 않는다: 장부(payment-ledger)를 실제로 돌리는 테스트 로더가 그 패키지를 못 푼다.
import { prisma } from "@/lib/prisma";
import {
    normalizePreferredPaymentMethod,
    preferredMethodFromTossPayment,
    type PreferredPaymentMethod,
} from "@/lib/payments/preferredMethod";

// «자주 쓰는 결제 방법» 읽기·쓰기 — User."preferredPaymentMethod" 칸(마이그레이션 20261113160000_parent_preferred_payment_method).
//
// ★ 결제를 절대 막지 않는다: 칸이 아직 없거나(마이그레이션 전) DB 오류가 나도 읽기는 null, 쓰기는 로그만 남긴다.
// ★ 대상 id 는 서버가 확인한 값만 받는다(승인 = 주문의 parentId, 설정 = requireVerifiedParent 의 appUserId).

/** 학부모 계정의 저장된 결제 방법(없거나 못 읽으면 null) */
export async function readPreferredPaymentMethod(appUserId: string | null | undefined): Promise<PreferredPaymentMethod | null> {
    if (!appUserId) return null;
    try {
        const rows = await prisma.$queryRawUnsafe<{ preferredPaymentMethod: string | null }[]>(
            `SELECT "preferredPaymentMethod" FROM "User" WHERE id = $1 LIMIT 1`,
            appUserId,
        );
        // 저장값도 다시 거른다(누가 DB 에 이상한 값을 넣어도 화면에는 아는 값만)
        return normalizePreferredPaymentMethod(rows[0]?.preferredPaymentMethod);
    } catch (error) {
        console.warn("[preferredPaymentMethod] read skipped:", error instanceof Error ? error.message : error);
        return null;
    }
}

/** 값 저장(null = 정하지 않음). 성공 여부만 돌려준다 — 던지지 않는다. */
export async function writePreferredPaymentMethod(appUserId: string, value: PreferredPaymentMethod | null): Promise<boolean> {
    try {
        await prisma.$executeRawUnsafe(
            `UPDATE "User"
                SET "preferredPaymentMethod" = $2,
                    "preferredPaymentMethodUpdatedAt" = NOW()
              WHERE id = $1 AND "withdrawnAt" IS NULL`,
            appUserId,
            value,
        );
        return true;
    } catch (error) {
        console.warn("[preferredPaymentMethod] write skipped:", error instanceof Error ? error.message : error);
        return false;
    }
}

/**
 * 토스 승인 완료 시 «지난번 결제 방법» 기억 — 승인 응답의 method·easyPay.provider 기준.
 * 모르는 방법이면 저장하지 않는다. 실패해도 결제 결과에는 영향 없음(로그만).
 */
export async function rememberPaymentMethodFromToss(parentUserId: string | null | undefined, payment: unknown): Promise<void> {
    if (!parentUserId) return;
    const value = preferredMethodFromTossPayment(payment);
    if (!value) return;
    await writePreferredPaymentMethod(parentUserId, value);
}
