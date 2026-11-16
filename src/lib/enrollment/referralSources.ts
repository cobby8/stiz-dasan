/**
 * 유입 경로(체험 신청 TrialLead.source · 수강 신청 EnrollmentApplication.referralSource) 허용 값 한 곳.
 *
 * 왜 따로 두나(이월 리뷰 R-2):
 *   공개 신청서의 서버 저장은 이 값이 «비어 있지 않은지»만 봤다. 화면을 거치지 않고 보내면
 *   아무 글자나 저장돼 유입 통계(값별로 묶어 센다)가 오염된다.
 *   → 저장 직전에 normalizeReferralSource 로 한 번 거른다. 목록 밖 값은 거절하지 않고 «기타»로 저장한다.
 *
 * 목록을 고칠 때:
 *   화면에 선택지를 추가하면 여기에도 같이 넣는다. 빠뜨리면 정상 신청의 값이 «기타»로 바뀐다.
 *   한글 이름(REFERRAL_SOURCE_LABELS)도 이 파일에 있다 — 값을 넣으면 이름도 같이 넣는다(타입 검사가 강제).
 *   tests/referral-source-allowlist.test.mjs 가 화면·관리자 선택지와 이 목록을 비교해 빠지면 깨진다.
 *
 * ⚠️ 이 파일은 다른 모듈을 import 하지 않는다(테스트가 그대로 불러 실행한다).
 * ⚠️ 원생의 가입 경로(Student.referralSource — «지인소개» 같은 한글 문장)는 다른 칸이다. 여기서 다루지 않는다.
 */

/** 목록 밖 값이 들어왔을 때 저장하는 값(«기타») */
export const REFERRAL_SOURCE_FALLBACK = "OTHER";

export const REFERRAL_SOURCE_VALUES = [
    // 공개 체험 신청서(apply/trial/TrialApplicationForm.tsx)
    "NAVER_AD",        // 네이버 검색광고 — 광고 주소로 들어오면 초기값(apply/trial/page.tsx)
    "NAVER_SEARCH",    // 네이버 키워드 검색
    "PORTAL_OTHER",    // 네이버 외 포털검색
    "NAVER_BLOG",      // 스티즈 네이버블로그
    "INSTAGRAM",       // 인스타그램
    "YOUTUBE",         // 유튜브
    "PASSBY",          // 지나가다 발견
    "REFERRAL",        // 지인소개
    "SOOMGO",          // 숨고
    "DANGGEUN",        // 당근마켓
    "OTHER",           // 기타
    // 공개 수강 신청서에만 있는 값(apply/enroll/EnrollApplicationLaterSteps.tsx)
    "SMS_PROMOTION",   // 문자 홍보
    // 관리자 화면 선택지·예전 값 — 학부모가 기존 신청서를 불러와 다시 내면 이 값이 그대로 돌아온다
    "WEBSITE",          // 홈페이지(관리자 체험 등록 기본값 · 운영 DB 에 있음)
    "NAVER",            // 네이버(관리자 체험 등록·수정 선택지)
    "FLYER",            // 전단지(관리자 체험 수정·수강 신청 수정 선택지)
    "EXISTING_STUDENT", // 기존 수강생(관리자 수강 신청 수정 선택지)
] as const;

export type ReferralSourceValue = (typeof REFERRAL_SOURCE_VALUES)[number];

// Set 으로 찾는다 — 객체 키 조회(obj[value])는 "constructor" 같은 글자가 «있는 값»으로 통과한다
const REFERRAL_SOURCE_SET: ReadonlySet<string> = new Set(REFERRAL_SOURCE_VALUES);

/** 허용 목록에 있는 값인지(글자 그대로 비교 — 공백 제거·대소문자 변환을 하지 않는다) */
export function isKnownReferralSource(value: unknown): value is ReferralSourceValue {
    return typeof value === "string" && REFERRAL_SOURCE_SET.has(value);
}

/**
 * 저장 직전 정규화(순수 함수 — 어떤 입력에도 던지지 않는다).
 *
 * - 없음(null·undefined)·빈 문자열·공백만 → ""(빈 값 그대로).
 *   «필수» 검사와 기본값(`|| "WEBSITE"` · `|| null`)은 부르는 쪽이 그대로 맡는다.
 * - 앞뒤 공백을 떼고 목록에 있으면 → 그 값.
 * - 그 밖(목록에 없는 글자·대소문자가 다른 값·아주 긴 글자·숫자·객체·배열) → "OTHER".
 *
 * 대소문자는 맞춰 주지 않는다: 화면은 항상 목록의 글자 그대로 보낸다. 다르게 온 값은 화면을 거치지 않은
 * 요청이므로 추측해서 살리지 않고 «기타»로 모은다.
 */
export function normalizeReferralSource(value: unknown): ReferralSourceValue | "" {
    if (value === null || value === undefined) return "";
    // 공개 서버 액션이라 문자열이 아닌 값도 올 수 있다 — 글자로 바꿔 저장하지 않는다
    if (typeof value !== "string") return REFERRAL_SOURCE_FALLBACK;
    const trimmed = value.trim();
    if (!trimmed) return "";
    return isKnownReferralSource(trimmed) ? trimmed : REFERRAL_SOURCE_FALLBACK;
}

/**
 * 코드값 → 한글 이름 표 «한 곳»(2026-11-17).
 *
 * 왜 여기 두나: 이름 표가 통계·수강 신청·체험 관리에 세 벌 있었고 서로 달랐다.
 *   NAVER_AD·YOUTUBE·DANGGEUN·SMS_PROMOTION 은 통계·수강 신청 표에 이름이 없어 코드 글자 그대로 보였다.
 *   → 관리자·통계 화면은 이 표만 쓴다(src/lib/stats/sourceLabels.ts 도 이 표에서 만든다).
 *
 * 이름의 기준: 학부모가 공개 신청서에서 실제로 고르는 글자(체험 신청서 → 수강 신청서 순).
 *   공개 신청서에 없는 값(WEBSITE·NAVER·FLYER·EXISTING_STUDENT)은 관리자 화면에서 쓰던 이름.
 *   공개 신청서의 SOURCE_OPTIONS 글자를 고치면 여기도 같이 고친다 — 테스트가 두 쪽을 비교한다.
 *
 * Record<ReferralSourceValue, string> 이라 허용 목록에 값을 넣고 이름을 빠뜨리면(또는 그 반대) 타입 검사가 막는다.
 * 관리자 선택 상자의 순서는 이 표가 아니라 REFERRAL_SOURCE_VALUES 순서를 쓴다.
 */
export const REFERRAL_SOURCE_LABELS: Record<ReferralSourceValue, string> = {
    NAVER_AD: "네이버 검색광고",
    NAVER_SEARCH: "네이버 키워드 검색",
    PORTAL_OTHER: "네이버 외 포털검색",
    NAVER_BLOG: "스티즈 네이버블로그",
    INSTAGRAM: "인스타그램",
    YOUTUBE: "유튜브",
    PASSBY: "지나가다 발견",
    REFERRAL: "지인소개",
    SOOMGO: "숨고",
    DANGGEUN: "당근마켓",
    OTHER: "기타",
    SMS_PROMOTION: "문자 홍보",
    WEBSITE: "홈페이지",
    NAVER: "네이버",
    FLYER: "전단지",
    EXISTING_STUDENT: "기존 수강생",
};

/**
 * 코드값 → 화면에 보일 이름(순수 함수).
 *
 * - 표에 있는 값 → 한글 이름.
 * - 표에 없는 값(예전 자료·처음 보는 코드) → 받은 글자 그대로(지어내지 않는다 — 예전 화면들의 `표[x] || x` 와 같다).
 * - 없음(null·undefined)·빈 문자열 → "". «미입력» 같은 빈 값 문구는 부르는 화면이 정한다.
 */
export function referralSourceLabel(value: string | null | undefined): string {
    if (value === null || value === undefined) return "";
    // Set 으로 확인한 뒤에만 표를 읽는다 — "constructor" 같은 글자가 이름으로 나오지 않게
    return isKnownReferralSource(value) ? REFERRAL_SOURCE_LABELS[value] : String(value);
}
