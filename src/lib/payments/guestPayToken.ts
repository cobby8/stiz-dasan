// 비회원 결제 링크 토큰 — 서버 전용(node:crypto). 화면 코드에서 import 하지 말 것.
//
// ■ 왜 원문이 아니라 해시를 저장하나
//   토큰 = 그 청구서 한 장을 보고 결제하는 열쇠다. 토큰 표(PaymentInvoiceAccessToken)에는 SHA-256 해시만 남긴다.
//   원문은 발급 직후(안내 문자 본문·관리자 «결제 링크 복사»)에만 쓰인다.
//   ⚠️ 단, 안내 발송 기록(BillingNoticeDelivery.body·문자 대기열 본문)에는 링크 원문이 남는다 — 그 표가 새면
//   남은 링크는 열린다(청구서 한 장·결제만 가능, 만료·납부·취소 시 닫힘). 필요하면 «결제 링크 모두 닫기»로 닫는다.
//   그래서 «이미 있는 링크를 다시 꺼내 주기»는 할 수 없고, 필요할 때마다 새로 발급한다.

import { createHash, randomBytes } from "node:crypto";
import { isGuestPayTokenShape } from "@/lib/payments/guestPayLinkRules";

export function hashGuestPayToken(token: string): string {
    return createHash("sha256").update(`stiz-guest-pay:v1:${token}`).digest("hex");
}

/** 새 토큰(32바이트 = base64url 43자)과 저장용 해시 */
export function createGuestPayToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: hashGuestPayToken(token) };
}

/** 주소·본문에서 받은 토큰 → 해시(모양이 틀리면 null — DB 를 부르지 않는다) */
export function guestTokenHashOrNull(token: unknown): string | null {
    return isGuestPayTokenShape(token) ? hashGuestPayToken(token) : null;
}

/**
 * 토스 customerKey(비회원) — 청구서 id 를 그대로 보내지 않고 해시로(토스 규격: 2~50자, 영문·숫자·-_).
 * 학부모 계정 키(stiz_…)와 다른 머리말이라 회원 결제수단과 섞이지 않는다. 체험비 결제(stiz_t_)와 같은 방식.
 */
export function guestCustomerKey(invoiceId: string): string {
    const digest = createHash("sha256").update(`stiz-guest-customer:v1:${invoiceId}`).digest("base64url").slice(0, 36);
    return `stiz_g_${digest}`;
}
