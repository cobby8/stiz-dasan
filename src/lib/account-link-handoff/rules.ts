/**
 * 앱에서 간편로그인 «연결하기» — 순수 규칙(2026-11-15 원장 승인 A안).
 *
 * 왜 필요한가: 스토어 앱(웹뷰) 안에서는 카카오·구글·애플 연결 화면을 열 수 없다(구글은 웹뷰 로그인을 막고,
 * 앱은 /auth/oauth/* 를 로그인 용도로만 가로챈다). 그래서 앱에서는 «1회용 표»(토큰)를 붙인 우리 사이트 주소를
 * 휴대폰 기본 브라우저로 열고, 그 브라우저에서 같은 계정으로 잠깐 들어가 연결을 마친 뒤 바로 나온다.
 *
 * 이 파일은 DB·Next·node 기능 없이 돌아가는 계산만 담는다(화면 부품도 import 하므로 node:crypto 금지 —
 * 토큰 만들기·hash 는 token.ts). 테스트가 직접 실행해서 못박는다.
 */

/** 1회용 표 수명 — 5분(검수 반영: 10분 → 5분). 앱 화면을 열어 둔 채 오래 있다 누르면 «시간이 지났어요» 안내가 뜬다. */
export const LINK_HANDOFF_TTL_SECONDS = 5 * 60;

/**
 * 바깥 브라우저로 여는 주소의 host — www 가 없는 apex.
 * 두 앱 모두 www.stiz-dasan.kr 만 «앱 안 화면»으로 보고, 다른 host 링크를 누르면 휴대폰 기본 브라우저로 연다.
 * apex 는 Vercel 이 경로·쿼리를 유지한 채 www 로 307 보내므로 바깥 브라우저에서 우리 사이트가 열린다.
 * ⚠️ www 로 바꾸면 앱 안에서 열려 버려(연결 화면이 다시 웹뷰) 기능 전체가 무너진다.
 */
export const LINK_HANDOFF_APEX_ORIGIN = "https://stiz-dasan.kr";

/** 시작(POST)을 받아 주는 출처. 확인 화면은 apex → www 로 넘어간 뒤에 그려지므로 www 가 정상 출처다. */
export const LINK_HANDOFF_FORM_ORIGIN = "https://www.stiz-dasan.kr";

export const LINK_HANDOFF_PATH = "/auth/link-handoff";
export const LINK_HANDOFF_START_PATH = "/auth/link-handoff/start";
export const LINK_HANDOFF_DONE_PATH = "/auth/link-handoff/done";

/**
 * «앱에서 시작한 연결» 표시 쿠키(검수 반영). 시작(POST)이 굽고, 콜백은 via=app 이면서 이 쿠키가 있을 때만
 * «이 브라우저 로그아웃 + 완료 화면»으로 처리한 뒤 지운다. 주소의 via=app 만으로는 처리 방식을 바꾸지 않는다.
 * path=/auth — 콜백(/auth/callback)에만 실린다. 수명은 표 수명의 2배(제공자 화면에서 머뭇거리는 시간 포함).
 */
export const LINK_HANDOFF_GATE_COOKIE = "stiz-link-app";
export const LINK_HANDOFF_GATE_COOKIE_PATH = "/auth";
export const LINK_HANDOFF_GATE_COOKIE_MAX_AGE = 10 * 60;

/** 앱 안 «연결하기» 아래 안내 한 줄 */
export const LINK_HANDOFF_BUTTON_NOTICE = "휴대폰 브라우저가 열려요. 연결 후 앱으로 돌아와 주세요.";
/** 표가 없거나·지났거나·이미 쓰였을 때 */
export const LINK_HANDOFF_EXPIRED_MESSAGE = "연결 시간이 지났어요. 앱에서 다시 눌러 주세요.";

/** 앱 화면의 «연결하기» 링크 주소(바깥 브라우저용 apex) */
export function linkHandoffUrl(token: string): string {
  const url = new URL(LINK_HANDOFF_PATH, LINK_HANDOFF_APEX_ORIGIN);
  url.searchParams.set("t", token);
  return url.toString();
}

/**
 * 연결 줄의 버튼 그리기 방식(서버에서 정한다).
 * - "handoff" : 앱(사용자 에이전트 표식) + 앱 로그인 서버 스위치 켜짐 → 1회용 표를 붙인 바깥 브라우저 링크
 * - "hidden"  : 앱인데 스위치 꺼짐 → 지금처럼 버튼을 숨기고 안내
 * - "client"  : 표식 없음(일반 브라우저·표식 전 옛 앱) → 지금 화면 부품이 브라우저 저장소로 판정(브라우저면 기존 링크)
 */
export type LinkButtonMode = "handoff" | "hidden" | "client";

export function linkButtonMode(input: { storeAppUserAgent: boolean; nativeAuthEnabled: boolean }): LinkButtonMode {
  if (!input.storeAppUserAgent) return "client";
  return input.nativeAuthEnabled ? "handoff" : "hidden";
}

/** 앱 계정 한 줄(표 발급·사용 때 DB 에서 다시 읽는다) */
export type LinkHandoffAccountRow = {
  role: string;
  hasActiveStaffGrant: boolean;
  phoneVerifiedAt: Date | string | null;
  withdrawnAt: Date | string | null;
  withdrawRequestedAt: Date | string | null;
};

/**
 * 앱 연결 대상 계정인가(검수 반영 — 발급·사용 두 곳 모두 이 판정).
 * 기준은 본인인증 연결(src/lib/account/social-link.ts selectLinkTarget)과 같다:
 *   정확히 한 계정 · 주 역할 PARENT · 승인된 직원 추가 역할 없음 · 휴대폰 인증 완료 + 탈퇴(요청) 아님.
 * 직원 계정(학부모 겸 직원 포함)은 학생 정보가 열리는 계정이라 바깥 브라우저 자동 로그인 길을 열지 않는다.
 */
export function isLinkHandoffEligible(rows: readonly LinkHandoffAccountRow[]): boolean {
  if (rows.length !== 1) return false;
  const [row] = rows;
  return row.role === "PARENT"
    && !row.hasActiveStaffGrant
    && Boolean(row.phoneVerifiedAt)
    && !row.withdrawnAt
    && !row.withdrawRequestedAt;
}

/** 아이디 가림: 앞 2글자 + «****»(길이를 짐작하지 못하게 별 개수 고정). 2글자 이하 아이디는 앞 1글자만. */
function maskUsername(username: string): string {
  const chars = Array.from(username);
  return `${chars.length > 2 ? chars.slice(0, 2).join("") : chars[0]}****`;
}

/**
 * 이름 가림: 가운데를 가린다. 김수빈 → 김*빈, 김수 → 김*, 남궁민수 → 남**수, 외자 → *.
 */
export function maskPersonName(name: string | null | undefined): string {
  const chars = Array.from(String(name ?? "").trim());
  if (chars.length === 0) return "";
  if (chars.length === 1) return "*";
  if (chars.length === 2) return `${chars[0]}*`;
  return `${chars[0]}${"*".repeat(chars.length - 2)}${chars[chars.length - 1]}`;
}

/**
 * 완료 화면에 보일 계정(가림). 아이디가 있으면 «아이디 sn****», 없으면 «김** 님», 둘 다 없으면 «이 계정».
 */
export function maskAccountLabel(input: { username?: string | null; name?: string | null }): string {
  const username = String(input.username ?? "").trim();
  if (username) return `아이디 ${maskUsername(username)}`;
  const name = Array.from(String(input.name ?? "").trim());
  if (name.length > 0) return `${name[0]}** 님`;
  return "이 계정";
}

/** 완료 화면이 주소로 받은 가린 계정 글자가 정해진 모양인지(아니면 보이지 않는다 — 임의 문장 표시 금지) */
export function isMaskedAccountLabel(value: string | null | undefined): value is string {
  return typeof value === "string" && /^(아이디 [^\s*]{1,2}\*{4}|[^\s*]\*\* 님)$/.test(value);
}

/**
 * 확인 화면에 보일 계정(검수 반영 — «내 계정이 맞는지» 알아보기 쉽게 가린 아이디 + 가린 이름).
 * 예: «아이디 sn**** · 김*빈 님», 아이디 없으면 «김*빈 님», 둘 다 없으면 «이 계정».
 */
export function confirmAccountLabel(input: { username?: string | null; name?: string | null }): string {
  const username = String(input.username ?? "").trim();
  const name = maskPersonName(input.name);
  if (username) return name ? `아이디 ${maskUsername(username)} · ${name} 님` : `아이디 ${maskUsername(username)}`;
  return name ? `${name} 님` : "이 계정";
}

/**
 * 시작(POST) 출처 검사 — 다른 사이트가 몰래 폼을 보내 «남의 브라우저를 내 계정에 로그인시키는» 일을 막는다.
 * - 운영 출처(www) 또는 지금 요청을 받은 서버 자신의 출처(개발 서버·미리보기 배포)면 통과
 * - Origin 이 «null»(사생활 설정 등으로 브라우저가 출처를 숨김)이면, 브라우저가 붙이는
 *   Sec-Fetch-Site 가 same-origin 일 때만 통과(다른 사이트에서 온 폼은 cross-site 로 붙는다 — 페이지가 바꿀 수 없다)
 * - Origin 이 아예 없으면 거절 — 앱에서 다시 누르게 하는 편이 안전하다
 */
export function isAllowedLinkHandoffOrigin(
  origin: string | null | undefined,
  requestOrigin: string,
  secFetchSite?: string | null,
): boolean {
  if (!origin) return false;
  if (origin === "null") return secFetchSite === "same-origin";
  return origin === LINK_HANDOFF_FORM_ORIGIN || origin === requestOrigin;
}

/** 콜백 주소에 붙는 «앱에서 넘어온 연결» 표시(쿠키와 함께 있어야 효력) */
export const LINK_HANDOFF_VIA = "app";

/**
 * Supabase 로그인 세션 쿠키 이름들(sb-<프로젝트>-auth-token 과 나눠 담은 조각 .0~.4).
 * PKCE 열쇠 쿠키(…-auth-token-code-verifier)는 들어가지 않는다 — 콜백 교환에 필요하므로 남긴다.
 */
export function supabaseSessionCookieNames(supabaseUrl: string): string[] {
  let ref = "";
  try {
    ref = new URL(supabaseUrl).hostname.split(".")[0];
  } catch {
    return [];
  }
  if (!ref) return [];
  const base = `sb-${ref}-auth-token`;
  return [base, ...[0, 1, 2, 3, 4].map((n) => `${base}.${n}`)];
}

/** 이름이 로그인 세션 쿠키(또는 그 조각)인가 — PKCE 열쇠 쿠키는 false */
export function isSupabaseSessionCookieName(name: string): boolean {
  return /^sb-[A-Za-z0-9]+-auth-token(\.\d+)?$/.test(name);
}

/**
 * 시작(POST)이 실패했을 때 확인 화면에 붙이는 «오류 코드» → 문구.
 * 주소에 문장을 그대로 싣지 않는다(누가 주소를 만들어 엉뚱한 문장을 우리 화면에 띄우지 못하게).
 */
export const LINK_HANDOFF_ERROR_MESSAGES = {
  expired: LINK_HANDOFF_EXPIRED_MESSAGE,
  origin: "이 화면에서 바로 시작할 수 없어요. 앱에서 다시 눌러 주세요.",
  closed: "지금은 앱에서 간편로그인을 연결할 수 없어요. 잠시 후 다시 시도해 주세요.",
  account: "이 계정은 앱에서 간편로그인을 연결할 수 없어요. 학원에 문의해 주세요.",
  failed: "연결을 시작하지 못했어요. 앱에서 다시 눌러 주세요.",
} as const;

export type LinkHandoffErrorCode = keyof typeof LINK_HANDOFF_ERROR_MESSAGES;

function pick<T extends Record<string, string>>(table: T, code: string | null | undefined): string | null {
  return code && Object.prototype.hasOwnProperty.call(table, code) ? table[code as keyof T] : null;
}

export function linkHandoffErrorMessage(code: string | null | undefined): string | null {
  return pick(LINK_HANDOFF_ERROR_MESSAGES, code);
}

/** 완료 화면 실패 코드 → 문구(검수 반영 — 주소의 임의 문장은 보이지 않는다) */
export const LINK_DONE_ERROR_MESSAGES = {
  already: "이 간편로그인 계정은 이미 다른 계정에 연결되어 있어요. 학원에 문의해 주세요.",
  cancelled: "연결이 취소되었거나 끝나지 않았어요. 스티즈 앱으로 돌아가 다시 눌러 주세요.",
  expired: "연결 시간이 지났어요. 스티즈 앱으로 돌아가 다시 눌러 주세요.",
  failed: "간편로그인 연결을 마치지 못했어요. 스티즈 앱으로 돌아가 다시 시도해 주세요.",
} as const;

export type LinkDoneErrorCode = keyof typeof LINK_DONE_ERROR_MESSAGES;

/** 알 수 없는 코드·빈 값이면 «failed» 문구 */
export function linkDoneErrorMessage(code: string | null | undefined): string {
  return pick(LINK_DONE_ERROR_MESSAGES, code) ?? LINK_DONE_ERROR_MESSAGES.failed;
}

/** 완료 화면 주소 — 성공: linked(+가린 계정 acct), 실패: e(코드) */
export function linkHandoffDonePath(result: { linked?: string; account?: string; code?: LinkDoneErrorCode }): string {
  const params = new URLSearchParams();
  if (result.code) {
    params.set("e", result.code);
  } else if (result.linked) {
    params.set("linked", result.linked);
    if (isMaskedAccountLabel(result.account)) params.set("acct", result.account);
  }
  const query = params.toString();
  return query ? `${LINK_HANDOFF_DONE_PATH}?${query}` : LINK_HANDOFF_DONE_PATH;
}
