import "server-only";

import { getAcademySettings } from "@/lib/queries";
import { DEFAULT_PRIVACY_POLICY } from "@/lib/defaultPolicies";

/**
 * 가입·계정 활성화 화면의 «약관 보기» 창에 넣을 본문 — /terms·/privacy 페이지와 같은 데이터 원천(학원 설정).
 * 개인정보 처리방침은 /privacy 와 같이 비어 있으면 기본 방침을 쓴다. 이용약관이 비어 있으면 null(창에서 «등록 전» 안내).
 */
export async function getParentPolicyTexts(): Promise<{ terms: string | null; privacy: string }> {
  try {
    const settings = (await getAcademySettings()) as { termsOfService?: string | null; privacyPolicy?: string | null };
    return {
      terms: settings.termsOfService?.trim() || null,
      privacy: settings.privacyPolicy?.trim() || DEFAULT_PRIVACY_POLICY,
    };
  } catch {
    // 설정을 못 읽어도 가입은 막지 않는다 — 창에는 기본 방침/등록 전 안내, 전체 페이지 링크는 그대로
    return { terms: null, privacy: DEFAULT_PRIVACY_POLICY };
  }
}

export type ParentPolicyTexts = Awaited<ReturnType<typeof getParentPolicyTexts>>;
