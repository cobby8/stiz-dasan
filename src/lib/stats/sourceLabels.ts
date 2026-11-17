/**
 * 유입경로 라벨 한 곳 — 2026-11-13 통계 화면 개편(원장 결정표 승인).
 *
 * 왜 따로 두나:
 *   신청 화면(ApplyAdminClient)과 통계 «유입·전환» 탭이 같은 코드값 → 이름 표를 써야
 *   한쪽만 고쳐져 같은 경로가 두 이름으로 보이는 일이 없다.
 *
 * 두 종류의 값이 섞여 있다(2026-11-13 운영 DB 실측):
 *   - 체험 문의·수강신청(TrialLead.source / EnrollmentApplication.referralSource) = 코드값(REFERRAL …)
 *   - 원생(Student.referralSource) = 옛 시트에서 넘어온 한글 문장(«지인소개», «네이버 키워드 검색(남양주…)») + 일부 코드값
 *   → 문의 표는 코드값 그대로 SOURCE_LABELS 로, 원생 표는 normalizeReferral 로 같은 이름에 모은다.
 *
 * ⚠️ 이 파일이 import 하는 것은 순수 모듈 하나(유입 경로 허용 값·이름 표)뿐이다 — 테스트가 그대로 불러 실행한다.
 */
import { REFERRAL_SOURCE_LABELS } from "@/lib/enrollment/referralSources";

// 유입경로 라벨 — 코드값의 이름은 한 곳(referralSources.ts 의 REFERRAL_SOURCE_LABELS)에서 온다(2026-11-17).
// 여기에 이름을 따로 적지 않는다: 예전엔 이 표에 없는 값(NAVER_AD·YOUTUBE 등)이 통계에 코드 글자로 보였다.
export const SOURCE_LABELS: Record<string, string> = {
    ...REFERRAL_SOURCE_LABELS,
    // UNKNOWN 은 저장하는 값이 아니다 — 통계 조회가 «빈 값»을 묶을 때만 만드는 이름이라 허용 목록에는 넣지 않는다
    UNKNOWN: "미입력",
};

/** 코드값 → 화면 이름(모르는 값은 그대로, 빈 값은 «미입력») */
export function sourceLabel(source: string | null | undefined): string {
    const key = String(source ?? "").trim();
    if (!key) return "미입력";
    return SOURCE_LABELS[key] || key;
}

/**
 * 원생 가입경로(한글 문장·코드값 섞임) → 같은 이름으로 모은다.
 * 예) «네이버 키워드 검색(남양주 농구교실 …)»·«네이버 키워드 검색»·NAVER_SEARCH → «네이버 키워드 검색»
 * 모르는 문장은 지어내지 않고 그대로 둔다.
 */
export function normalizeReferral(value: string | null | undefined): string {
    const raw = String(value ?? "").trim();
    if (!raw) return "미입력";
    if (SOURCE_LABELS[raw]) return SOURCE_LABELS[raw];
    const text = raw.replace(/\s+/g, "");
    if (text.includes("지인")) return SOURCE_LABELS.REFERRAL;
    if (text.includes("지나가다")) return SOURCE_LABELS.PASSBY;
    if (text.includes("블로그")) return SOURCE_LABELS.NAVER_BLOG;
    if (text.includes("네이버키워드") || text.includes("네이버검색")) return SOURCE_LABELS.NAVER_SEARCH;
    if (text.includes("포털")) return SOURCE_LABELS.PORTAL_OTHER;
    if (text.includes("인스타")) return SOURCE_LABELS.INSTAGRAM;
    if (text.includes("숨고")) return SOURCE_LABELS.SOOMGO;
    if (text.includes("기존수강생") || text.includes("수강이력")) return SOURCE_LABELS.EXISTING_STUDENT;
    if (text.includes("전단")) return SOURCE_LABELS.FLYER;
    return raw;
}
