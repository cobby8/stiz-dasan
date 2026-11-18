import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
// 이름 비교 기준 = 본인인증 실명이 있으면 실명, 없으면 닉네임(2026-11-18 검수 N-1)
import { identityComparableName } from "@/lib/identity/verified-identity";

/**
 * 간편로그인 → 본인인증(KG이니시스 통합인증) → 기존 학부모 계정 연결(원장 결정 2026-10-26).
 *
 * 왜 본인인증인가: 문자 인증은 「지금 그 휴대폰을 들고 있다」만 증명한다. 통합인증은 통신사 명의로
 * 「이 번호의 명의자가 이 사람이다」까지 증명한다. 그래서 명의 번호·이름이 계정과 같을 때만 연결한다.
 * 관리자·직원 계정은 학생 전체 정보가 열리는 계정이라 처음엔 이 길로 열지 않았다. 2026-11-17 원장 지시로
 * «이름 일치·로그인 수단·휴대폰 인증을 갖춘 계정이 정확히 하나»일 때만 연다(selectLinkTarget).
 */

export type LinkCandidate = {
  id: string;
  role: string;
  name: string | null;
  /** 본인인증 실명(2026-11-18) — 있으면 이름 비교는 닉네임(name)이 아니라 이것으로 한다 */
  identityVerifiedName?: string | null;
  authUserId: string | null;
  phoneVerifiedAt: Date | string | null;
  /** 승인된 추가 역할(선생님·기사님, UserRoleGrant ACTIVE)이 있는지 — 주 역할이 학부모여도 직원 화면이 열린다. */
  hasActiveStaffGrant?: boolean;
};

/**
 * 로그인 계정이 아직 없는 «직원 기록»에 본인이 직접 로그인을 붙여도 되는가(2026-11-17 원장 지시
 * «알아서 다 처리할 수 있게 — 관리자가 일일이 개입하면 왜 만드나»).
 *
 * 원장이 직원 화면에 이름·휴대폰 번호·역할을 적어 둔 기록은 «이 번호·이 이름에 이 역할을 미리 붙여 둔 것»이다.
 * 예전에는 원장이 «로그인 연결 초대»를 따로 보내야 했고, 그 전에는 로그인도 비밀번호 찾기도 되지 않았다.
 * 이제 본인이 간편로그인 + 본인인증(통신사 명의 확인)을 하면 그 기록에 로그인이 붙는다. 조건은 좁게:
 *  - 이 번호를 쓰는 계정이 «그 기록 하나뿐»(같은 번호에 다른 계정이 있으면 자동으로 고르지 않는다)
 *  - 직원 역할(학부모가 아님) · 로그인 계정 없음 · 탈퇴(요청) 아님
 *  - 본인인증 명의자 이름이 기록의 이름과 같음
 */
export type StaffClaimCandidate = LinkCandidate & {
  withdrawn?: boolean;
  /** 로그인 없는 직원 기록인가 — authUserId 없음 + 이메일이 직접 추가 자리표시(@staff.local). 조회가 계산해 준다. */
  noLogin?: boolean;
};
export function selectStaffRecordToClaim(rows: StaffClaimCandidate[], verifiedName: string): { userId: string } | null {
  if (rows.length !== 1) return null;
  const [row] = rows;
  // authUserId 만으로는 «로그인 없음»을 알 수 없다 — 초대로 가입한 직원은 authUserId 없이 로그인이 있다(noLogin 이 가른다).
  if (row.role === "PARENT" || row.authUserId || row.noLogin !== true || row.withdrawn) return null;
  const name = normalizePersonName(verifiedName);
  if (!name || name !== normalizePersonName(identityComparableName(row))) return null;
  return { userId: row.id };
}

export type LinkTargetResult =
  | { kind: "OK"; userId: string; authUserId: string }
  | { kind: "NONE" } // 이 번호의 계정이 없다 → 일반 간편가입으로
  | { kind: "STAFF" } // 관리자·직원이 쓰는 번호 → 이 길로 열지 않는다
  | { kind: "MULTIPLE" } // 학부모 계정이 여러 개 → 자동으로 고르지 않는다
  | { kind: "NAME_MISMATCH" } // 명의자 이름과 계정 이름이 다르다
  | { kind: "NOT_READY" }; // 로그인 수단·휴대폰 인증이 없는 계정(빈 계정은 문자 인증 흐름이 따로 맡는다)

/** 이름 비교용 — 공백·대소문자·유니코드 조합 차이만 없앤다(성·이름을 바꾸지는 않는다). */
export function normalizePersonName(value: string | null | undefined): string {
  return String(value ?? "").normalize("NFC").replace(/\s+/g, "").toLowerCase();
}

/** 명의 번호를 쓰는 계정들 중 연결할 계정을 고른다. 정확히 «학부모 하나»일 때만 OK. */
export function selectLinkTarget(rows: LinkCandidate[], verifiedName: string): LinkTargetResult {
  if (rows.length === 0) return { kind: "NONE" };
  // 주 역할뿐 아니라 승인된 추가 역할도 본다 — 「학부모 겸 기사님」도 학생 정보가 열리는 계정이다(보안 리뷰 2026-10-26).
  if (rows.some((row) => row.role !== "PARENT" || row.hasActiveStaffGrant)) {
    // 2026-11-17 원장 지시 «(직원 번호도) 연결되게 만들어» — 원장 본인이 본인인증까지 마치고도 막혔다.
    // 예전에는 직원이 쓰는 번호면 무조건 막았다(2026-10-26 보안 리뷰). 이제 조건을 학부모보다 좁게 잡아 연다:
    // 이 번호의 계정 중 «명의자 이름이 같고 · 로그인 수단이 있고 · 휴대폰 인증을 마친» 계정이 정확히 하나일 때만.
    // 하나로 정해지지 않으면(같은 번호를 쓰는 계정이 둘 다 해당·이름 다름·인증 전) 지금처럼 막는다 — 자동으로 고르지 않는다.
    const verified = normalizePersonName(verifiedName);
    // 직원 계정은 초대 가입 때 문자 인증을 거쳤지만 phoneVerifiedAt 을 적지 않았다(가드도 직원은 면제한다). 그래서 «휴대폰 인증을
    // 마친» 조건을 직원에게 그대로 걸면 초대로 가입한 직원은 전부 막힌다(2026-11-17) — 이름 일치 + 로그인 수단이 있으면 후보로 보고,
    // 후보가 여럿일 때만 휴대폰 인증을 마친 쪽으로 좁힌다. 그래도 하나로 정해지지 않으면 막는다.
    const named = rows.filter((row) => verified && normalizePersonName(identityComparableName(row)) === verified && row.authUserId);
    const eligible = named.length > 1 ? named.filter((row) => row.phoneVerifiedAt) : named;
    const only = eligible.length === 1 ? eligible[0] : null;
    if (!only?.authUserId) return { kind: "STAFF" };
    return { kind: "OK", userId: only.id, authUserId: only.authUserId };
  }
  if (rows.length > 1) return { kind: "MULTIPLE" };
  const [row] = rows;
  const name = normalizePersonName(verifiedName);
  if (!name || name !== normalizePersonName(identityComparableName(row))) return { kind: "NAME_MISMATCH" };
  if (!row.authUserId || !row.phoneVerifiedAt) return { kind: "NOT_READY" };
  return { kind: "OK", userId: row.id, authUserId: row.authUserId };
}

export const LINK_RESULT_MESSAGES: Record<Exclude<LinkTargetResult["kind"], "OK">, string> = {
  NONE: "인증하신 휴대폰 번호로 가입된 계정이 없습니다. 이전 화면에서 새로 가입해 주세요.",
  STAFF: "학원 직원이 쓰는 번호인데 연결할 계정을 하나로 정하지 못했어요. 아이디로 로그인한 뒤 마이페이지 ‘간편로그인 연결’에서 연결해 주세요.",
  MULTIPLE: "이 번호로 등록된 계정이 여러 개라 자동으로 연결하지 않았어요. 학원에 문의해 주세요.",
  NAME_MISMATCH: "본인인증 이름과 학원에 등록된 보호자 이름이 달라 연결하지 않았어요. 학원에 문의해 주세요.",
  NOT_READY: "아직 로그인 설정이 끝나지 않은 계정이에요. 휴대폰 문자 인증으로 계정을 먼저 활성화해 주세요.",
};

/** 본인인증은 이 시간 안에 끝난 것만 받는다(오래된 인증 결과를 다시 쓰지 못하게). */
export const LINK_VERIFICATION_MAX_AGE_MS = 10 * 60 * 1000;

export function isFreshVerification(verifiedAt: string | null | undefined, now = Date.now()): boolean {
  const at = verifiedAt ? Date.parse(verifiedAt) : Number.NaN;
  return Number.isFinite(at) && at <= now + 60_000 && now - at <= LINK_VERIFICATION_MAX_AGE_MS;
}

function linkSecret(): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("서버 설정이 완료되지 않았습니다.");
  return secret;
}

function sessionTag(authUserId: string): string {
  return createHmac("sha256", linkSecret()).update(`social-link:${authUserId}`).digest("hex").slice(0, 20);
}

/**
 * 본인인증 건 번호를 서버가 만든다. 번호 안에 「이 간편로그인 사용자」 표식이 들어 있어서,
 * 남이 끝낸 인증 건 번호를 가져와도 다른 사람의 세션에서는 통과하지 못한다.
 */
export function createLinkVerificationId(authUserId: string): string {
  return `stizlink_${sessionTag(authUserId)}_${randomBytes(9).toString("base64url")}`;
}

export function isLinkVerificationIdFor(identityVerificationId: string, authUserId: string): boolean {
  const match = /^stizlink_([0-9a-f]{20})_[A-Za-z0-9_-]{12}$/.exec(identityVerificationId);
  if (!match) return false;
  const expected = Buffer.from(sessionTag(authUserId));
  const actual = Buffer.from(match[1]);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** 연결 알림 문자 — 본인이 아니면 바로 알 수 있게(남이 붙였을 때의 안전장치). */
export function socialLinkNoticeBody(providerLabel: string): string {
  // 머리말 [스티즈농구교실] 통일(2026-11-09)
  return `[스티즈농구교실] 회원님 계정에 ${providerLabel} 로그인이 연결되었습니다. 본인이 하지 않았다면 바로 학원(070-8824-5712)으로 연락해 주세요.`;
}

/** 본인인증으로 기존 계정에 로그인된 순간의 알림 — 연결 단계에서 취소해도 «들어왔다»는 사실은 알린다. */
export function identityLoginNoticeBody(): string {
  return "[스티즈농구교실] 휴대폰 명의 본인인증으로 회원님 계정에 로그인되었습니다. 본인이 하지 않았다면 바로 학원(070-8824-5712)으로 연락해 주세요.";
}
