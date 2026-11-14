// 보호자 «연락처 바꾸기» 판정 — 순수 함수(DB·시계 없음). 실행 테스트: tests/child-edit.test.mjs
// 연결부: phone-change.ts (본인인증 결과를 포트원에서 다시 읽은 뒤 이 판정을 거쳐서만 번호를 바꾼다)

/** 연락처 변경용 인증 건 번호 머리말 — 자녀 연결 인증 건(stizchild_)과 섞이지 않게 */
export const PHONE_CHANGE_ID_PREFIX = "stizphone_";

export type PhoneChangeOutcome =
  | { ok: true; changed: boolean }
  | { ok: false; status: number; error: string };

/**
 * 인증을 통과한 뒤 «번호를 바꿔도 되는가».
 *  - 이름은 identityName(공백 제거·소문자) 으로 정리한 값, 번호는 숫자만.
 *  - 인증한 이름 ≠ 계정 이름 → 거절(설정의 «이름»을 본인 이름으로 바꾼 뒤 다시).
 *  - 다른 계정이 쓰는 번호 → 거절.
 *  - 지금 번호와 같으면 changed=false(인증 사실만 새로 기록).
 */
export function phoneChangeOutcome(input: {
  accountName: string;
  verifiedName: string;
  currentPhone: string;
  verifiedPhone: string;
  takenByOther: boolean;
}): PhoneChangeOutcome {
  if (!input.verifiedName || !/^01\d{8,9}$/.test(input.verifiedPhone)) {
    return { ok: false, status: 400, error: "본인인증 정보를 확인하지 못했습니다. 다시 인증해 주세요." };
  }
  if (input.accountName !== input.verifiedName) {
    return { ok: false, status: 409, error: "본인인증한 이름이 계정 이름과 달라요. 설정의 «이름»을 본인 이름으로 바꾼 뒤 다시 해 주세요." };
  }
  if (input.takenByOther) {
    return { ok: false, status: 409, error: "다른 계정이 쓰고 있는 번호예요. 그 계정으로 로그인하거나 학원에 문의해 주세요." };
  }
  return { ok: true, changed: input.currentPhone !== input.verifiedPhone };
}
