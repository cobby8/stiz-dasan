/**
 * 운영 서버의 토스 «테스트 키» 차단 — 순수 판정(2026-11-13).
 *
 * 왜: 운영(학부모가 실제로 쓰는 사이트)에 test_ 키가 들어가면 결제창이 열리고, 테스트 카드로 «결제»한
 * 청구서가 돈이 안 들어왔는데 «납부 완료»로 바뀐다. 그래서 운영에서는 test_ 키를 «결제 준비 안 됨»으로 본다.
 *
 * 범위: 학부모 청구서 결제(payment-ledger)만. 토스 가맹 심사용 화면(TOSS_REVIEW_* · src/lib/payments/tossReview.ts)은
 * 이름부터 다른 환경변수를 쓰고 청구서·DB 를 건드리지 않으므로 여기서 막지 않는다(심사 중 — 동작 유지).
 *
 * 이 파일은 다른 모듈을 import 하지 않는다(테스트에서 그대로 실행).
 */
export type TossKeyModeForGuard = "test" | "live" | "unknown";

/** 운영 배포(VERCEL_ENV=production)에서 클라이언트·서버 키 중 하나라도 test_ 면 true(= 결제 막음) */
export function isProductionTestKeyBlocked(
    env: Record<string, string | undefined>,
    clientKeyMode: TossKeyModeForGuard,
    secretKeyMode: TossKeyModeForGuard,
): boolean {
    if (env.VERCEL_ENV !== "production") return false;
    return clientKeyMode === "test" || secretKeyMode === "test";
}

/** 막혔을 때 학부모·관리자에게 보이는 문구 */
export const PRODUCTION_TEST_KEY_BLOCKED_MESSAGE =
    "온라인 결제 준비 중입니다. 학원으로 문의해 주세요.";
