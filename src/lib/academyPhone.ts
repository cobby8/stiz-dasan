import { getAcademySettings } from "@/lib/queries";
import { usableAcademyPhone } from "@/lib/academyPhoneRules";
import { normalizeExternalUrl } from "@/lib/externalUrl";

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

/**
 * 학부모 화면의 «전화·카카오 문의» 버튼 묶음용 연락처(2026-11-17 g3) — 전화 번호 + 카카오 채널 주소.
 * 둘 다 설정값(AcademySettings)이고, 못 읽거나 비어 있으면 null → 그 버튼만 숨는다.
 * 결석 알리기·수납 화면이 각자 하던 것과 같은 판정이다(같은 요청 안에서 설정은 한 번만 읽힌다).
 */
export async function getAcademyContact(): Promise<{ phone: string | null; kakaoChannelUrl: string | null }> {
  const settings = (await getAcademySettings().catch(() => null)) as
    | { contactPhone?: string | null; kakaoChannelUrl?: string | null }
    | null;
  // 카카오 채널 주소는 공개 바닥글과 같은 규칙으로 다듬는다 — https:// 없이 «pf.kakao.com/_xxx» 로 저장돼도 바깥 주소로 열린다
  const kakao = normalizeExternalUrl(typeof settings?.kakaoChannelUrl === "string" ? settings.kakaoChannelUrl : "");
  return {
    phone: usableAcademyPhone(settings?.contactPhone ?? null),
    kakaoChannelUrl: kakao || null,
  };
}
