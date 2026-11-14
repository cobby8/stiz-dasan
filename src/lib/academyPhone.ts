import { getAcademySettings } from "@/lib/queries";

/**
 * 학부모 화면의 «학원에 전화하기» 버튼용 학원 대표 번호(설정값 AcademySettings.contactPhone).
 * 번호를 코드에 박지 않는다 — 설정에서 바꾸면 화면도 바뀐다.
 * 못 읽었거나 자리채움 번호(010-0000-0000)면 null → 화면은 전화 링크 없이 글자만 보인다.
 * (학부모 홈 «자녀 없음» 화면이 쓰던 것과 같은 규칙을 한 곳으로 모았다)
 */
export async function getUsableAcademyPhone(): Promise<string | null> {
  const phone = await getAcademySettings()
    .then((settings) => (settings as { contactPhone?: string | null } | null)?.contactPhone ?? null)
    .catch(() => null);
  return usableAcademyPhone(phone);
}

/** 번호 판정만(순수 함수) — 숫자 8자리 이상이고 자리채움 번호가 아니어야 쓴다 */
export function usableAcademyPhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 8 || digits === "01000000000") return null;
  return String(phone);
}
