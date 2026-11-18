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
 * 학부모 화면의 «카카오 문의» 버튼을 열지 여부 — 스위치 한 곳(2026-11-17 원장 지시).
 * 왜 닫았나: 「카카오 문의하기는 제대로 준비도 안 됐는데 오픈하면 안 되지」 — 채널 상담 응대가 준비되면 true 로 켠다.
 * 닫혀 있으면 학부모 화면에 넘기는 카카오 주소를 null 로 만든다 → 결석·수납·보강 등 모든 «카카오 문의» 버튼이 같이 숨는다.
 * 공개 바닥글의 «카카오 채널» 링크(PublicFooter)는 채널 소개 링크라 이 스위치와 무관하다.
 */
export const PARENT_KAKAO_INQUIRY_OPEN = false;

/** 학부모 화면에 넘길 카카오 주소 — 스위치가 닫혀 있으면 null */
export function parentKakaoUrl(raw: unknown): string | null {
  if (!PARENT_KAKAO_INQUIRY_OPEN) return null;
  return normalizeExternalUrl(typeof raw === "string" ? raw : "") || null;
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
  // 단, 학부모 «카카오 문의»가 닫혀 있으면(PARENT_KAKAO_INQUIRY_OPEN) null
  return {
    phone: usableAcademyPhone(settings?.contactPhone ?? null),
    kakaoChannelUrl: parentKakaoUrl(settings?.kakaoChannelUrl),
  };
}
