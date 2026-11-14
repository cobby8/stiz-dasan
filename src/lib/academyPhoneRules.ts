// 학원 대표 번호 판정(순수 함수) — «학원에 전화하기» 링크를 그릴지, 어떤 번호로 걸지는 여기 한 곳에서만 정한다.
// 화면(클라이언트)과 서버가 같이 쓰도록 DB 를 읽지 않는 파일로 따로 뒀다(서버 조회는 academyPhone.ts).

/**
 * 전화 링크(tel:)에 넣을 숫자. 걸 수 없는 값이면 null → 화면은 링크 없이 글자만 보인다.
 *  - 숫자만 남긴다. «+82 10-…»(국가번호)은 «010…»으로 바꾼다
 *  - 8~12자리만 번호로 본다(번호 두 개가 이어 붙은 값·너무 짧은 값은 잘못 걸릴 수 있어 링크를 만들지 않는다)
 *  - 설정을 안 채운 자리채움 번호(010-0000-0000)는 쓰지 않는다
 */
export function academyTel(phone: string | null | undefined): string | null {
  const raw = String(phone ?? "").trim();
  let digits = raw.replace(/[^0-9]/g, "");
  if (raw.startsWith("+82") && digits.startsWith("82")) digits = `0${digits.slice(2).replace(/^0/, "")}`;
  if (digits.length < 8 || digits.length > 12) return null;
  if (digits === "01000000000") return null;
  return digits;
}

/** 화면에 넘길 번호 — 걸 수 있는 번호일 때만 원래 글자(«031-000-0000»)를 돌려준다 */
export function usableAcademyPhone(phone: string | null | undefined): string | null {
  return academyTel(phone) ? String(phone).trim() : null;
}
