// 보호자 «연락처 바꾸기» 판정 — 순수 함수(DB·시계 없음). 실행 테스트: tests/child-edit.test.mjs
// 연결부: phone-change.ts (본인인증 결과를 포트원에서 다시 읽은 뒤 이 판정을 거쳐서만 번호를 바꾼다)

/** 연락처 변경용 인증 건 번호 머리말 — 자녀 연결 인증 건(stizchild_)과 섞이지 않게 */
export const PHONE_CHANGE_ID_PREFIX = "stizphone_";

/** 이름 불일치 안내 — 화면이 이 문장을 알아보고 «이름 고치러 가기» 링크를 붙인다 */
export const PHONE_NAME_MISMATCH_MESSAGE = "본인인증한 이름이 계정 이름과 달라요. 설정의 «이름»을 본인 이름으로 바꾼 뒤 다시 해 주세요.";

/**
 * 계정 이름이 «본인인증에 나올 법한 이름» 모양인가 — 한글 2~5자(성+이름) 또는 영문 이름.
 * «민준맘»·«홍길동 어머니» 같은 이름은 인증 이름과 달라 거절되므로, 인증 «전에» 미리 알려 헛걸음을 막는다.
 * (판정이 아니라 안내용 — 실제 일치 여부는 인증 뒤 phoneChangeOutcome 이 본다)
 */
export function looksLikeLegalName(name: string | null | undefined): boolean {
  const v = String(name ?? "").normalize("NFC").trim();
  if (/^[가-힣]{2,5}$/.test(v)) return !/(엄마|아빠|맘|파파|어머니|아버지|할머니|할아버지|이모|삼촌|보호자)$/.test(v);
  return /^[A-Za-z][A-Za-z .'-]{1,39}$/.test(v);
}

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
    return { ok: false, status: 409, error: PHONE_NAME_MISMATCH_MESSAGE };
  }
  if (input.takenByOther) {
    return { ok: false, status: 409, error: "다른 계정이 쓰고 있는 번호예요. 그 계정으로 로그인하거나 학원에 문의해 주세요." };
  }
  return { ok: true, changed: input.currentPhone !== input.verifiedPhone };
}
