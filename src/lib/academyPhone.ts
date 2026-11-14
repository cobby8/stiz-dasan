import { getAcademySettings } from "@/lib/queries";
import { usableAcademyPhone } from "@/lib/academyPhoneRules";

/**
 * 학부모 화면의 «학원에 전화하기» 버튼용 학원 대표 번호(설정값 AcademySettings.contactPhone).
 * 번호를 코드에 박지 않는다 — 설정에서 바꾸면 화면도 바뀐다.
 * 못 읽었거나 걸 수 없는 값(자리채움 번호·이상한 길이)이면 null → 화면은 전화 링크 없이 글자만 보인다.
 * 판정은 academyPhoneRules 한 곳(홈 «자녀 없음»·결석 알리기·셔틀 변경·가족 연결이 같은 기준을 쓴다).
 */
export async function getUsableAcademyPhone(): Promise<string | null> {
  const phone = await getAcademySettings()
    .then((settings) => (settings as { contactPhone?: string | null } | null)?.contactPhone ?? null)
    .catch(() => null);
  return usableAcademyPhone(phone);
}
