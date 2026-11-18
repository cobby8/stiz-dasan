/**
 * 아이디·비밀번호 찾기를 «본인인증»으로 할 때 계정 고르기 (2026-11-18 4단계 B) — 순수 함수.
 * 연결부: parent-password-reset.ts issueIdentityVerifiedPasswordReset. 실행 테스트: tests/anonymous-identity.test.mjs
 *
 * 문자 인증 찾기는 «그 번호를 지금 들고 있다»만 보고, 번호의 학부모 계정을 모두 보여 준다(고르게 한다).
 * 본인인증은 명의 번호·실명을 주므로 «그 사람의 계정»을 바로 찾되 더 좁게 —
 *  - 이 번호의 학부모 계정이 정확히 하나
 *  - 그 계정 이름(본인인증 실명이 있으면 실명, 없으면 닉네임)이 명의자 이름과 같음
 * 둘 중 하나라도 아니면 자동으로 고르지 않는다(문자 인증 샛길·학원 문의로 안내).
 */

import { normalizePersonName } from "@/lib/account/social-link";
import { identityComparableName } from "./verified-identity";
import { SMS_FALLBACK_HINT } from "./sms-fallback-label";

export const IDENTITY_RESET_MULTIPLE_MESSAGE =
  `이 번호로 가입된 계정이 여러 개라 본인인증으로는 고르지 않았어요. 문자 인증으로 찾으려면 ${SMS_FALLBACK_HINT} 그래도 안 되면 학원에 문의해 주세요.`;
export const IDENTITY_RESET_NAME_MISMATCH_MESSAGE =
  `본인인증 이름과 계정 이름이 달라 본인인증으로는 찾지 않았어요. 문자 인증으로 찾으려면 ${SMS_FALLBACK_HINT} 그래도 안 되면 학원에 문의해 주세요.`;

export type IdentityResetPick<T> =
  | { kind: "OK"; account: T }
  | { kind: "NONE" } // 로그인할 수 있는 학부모 계정이 없다 → 부르는 쪽이 «계정 없음» 문구
  | { kind: "MULTIPLE"; error: string }
  | { kind: "NAME_MISMATCH"; error: string };

export function selectIdentityResetAccount<T extends { name?: string | null; identityVerifiedName?: string | null }>(
  rows: T[],
  verifiedName: string,
): IdentityResetPick<T> {
  if (rows.length === 0) return { kind: "NONE" };
  if (rows.length > 1) return { kind: "MULTIPLE", error: IDENTITY_RESET_MULTIPLE_MESSAGE };
  const name = normalizePersonName(verifiedName);
  if (!name || name !== normalizePersonName(identityComparableName(rows[0]))) {
    return { kind: "NAME_MISMATCH", error: IDENTITY_RESET_NAME_MISMATCH_MESSAGE };
  }
  return { kind: "OK", account: rows[0] };
}
