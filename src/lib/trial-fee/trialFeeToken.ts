// 체험비 결제 링크 토큰 — 서버 전용(node:crypto). 화면 코드에서 import 하지 말 것.
//
// ■ 왜 원문이 아니라 해시를 저장하나
//   토큰 = 그 신청의 결제 화면을 여는 열쇠다. DB·백업이 새도 열쇠를 다시 만들 수 없게 SHA-256 해시만 남긴다.
//   원문은 신청 직후 응답(신청 완료 화면)에만 한 번 실린다. 잃어버리면 같은 아이·번호로 신청서를 다시 내면 새 링크가 나온다.

import { createHash, randomBytes } from "node:crypto";
import { isTrialPaymentTokenShape } from "@/lib/trial-fee/trialFeeRules";

export function hashTrialPaymentToken(token: string): string {
    return createHash("sha256").update(`stiz-trial-pay:v1:${token}`).digest("hex");
}

/** 새 토큰(32바이트 = base64url 43자)과 저장용 해시 */
export function createTrialPaymentToken(): { token: string; hash: string } {
    const token = randomBytes(32).toString("base64url");
    return { token, hash: hashTrialPaymentToken(token) };
}

/** 주소에서 받은 토큰 → 해시(모양이 틀리면 null — DB 를 부르지 않는다) */
export function tokenHashOrNull(token: unknown): string | null {
    return isTrialPaymentTokenShape(token) ? hashTrialPaymentToken(token) : null;
}

/** 토스 customerKey — 신청 id 를 그대로 보내지 않고 해시로(2~50자, 영문·숫자·-_) */
export function trialCustomerKey(trialLeadId: string): string {
    const digest = createHash("sha256").update(`stiz-trial-customer:v1:${trialLeadId}`).digest("base64url").slice(0, 36);
    return `stiz_t_${digest}`;
}
