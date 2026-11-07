// 가상계좌 웹훅 secret — 서버 전용(node:crypto). 학부모 화면에서 import 하지 말 것.
//
// ■ 왜 원문이 아니라 해시를 저장하나
//   토스는 가상계좌 승인 응답에만 secret 을 준다(이후 조회 응답은 null). 입금 알림(DEPOSIT_CALLBACK)이 오면
//   그 본문의 secret 이 승인 때 받은 값과 같은지 비교해 위조 알림을 거른다.
//   비교만 하면 되므로 SHA-256 해시만 남긴다 — DB·백업이 새도 해시로는 진짜 알림을 만들 수 없다.

import { createHash, timingSafeEqual } from "node:crypto";
import { stripPaymentSecret, type DepositSecretCheck } from "@/lib/payments/virtualAccount";

export function hashDepositSecret(secret: string): string {
    return createHash("sha256").update(`stiz-va-secret:v1:${secret}`).digest("hex");
}

/** 웹훅으로 받은 secret 과 저장된 해시를 타이밍 안전 비교한다. */
export function checkDepositSecret(provided: unknown, storedHash: unknown): DepositSecretCheck {
    if (typeof storedHash !== "string" || !/^[0-9a-f]{64}$/.test(storedHash)) return "NOT_STORED";
    if (typeof provided !== "string" || !provided) return "NOT_PROVIDED";
    const a = Buffer.from(hashDepositSecret(provided), "hex");
    const b = Buffer.from(storedHash, "hex");
    // 둘 다 32바이트라 길이가 같다. 길이가 달라도 예외 대신 불일치로 돌린다.
    return a.length === b.length && timingSafeEqual(a, b) ? "MATCH" : "MISMATCH";
}

/**
 * 승인 응답을 저장용으로 바꾼다: secret 원문은 지우고 해시와 발급 정보만 덧붙인다.
 * secret 이 없으면(조회로 복구한 경우) 해시 칸을 비운다.
 */
export function buildIssuedRawResponse(payment: Record<string, unknown>, issue: unknown): Record<string, unknown> {
    const secret = payment.secret;
    return {
        // secret 칸(최상위·virtualAccount 안)을 지운 사본
        ...stripPaymentSecret(payment),
        virtualAccountIssue: issue,
        depositSecretHash: typeof secret === "string" && secret ? hashDepositSecret(secret) : null,
    };
}
