import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 간편로그인 → 본인인증(KG이니시스 통합인증) → 기존 학부모 계정 연결(원장 결정 2026-10-26).
 *
 * 왜 본인인증인가: 문자 인증은 「지금 그 휴대폰을 들고 있다」만 증명한다. 통합인증은 통신사 명의로
 * 「이 번호의 명의자가 이 사람이다」까지 증명한다. 그래서 명의 번호·이름이 계정과 같을 때만 연결한다.
 * 관리자·직원 계정은 이 길로 열지 않는다 — 학생 전체 정보가 열리는 계정이라서다.
 */

export type LinkCandidate = {
  id: string;
  role: string;
  name: string | null;
  authUserId: string | null;
  phoneVerifiedAt: Date | string | null;
  /** 승인된 추가 역할(선생님·기사님, UserRoleGrant ACTIVE)이 있는지 — 주 역할이 학부모여도 직원 화면이 열린다. */
  hasActiveStaffGrant?: boolean;
};

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
  if (rows.some((row) => row.role !== "PARENT" || row.hasActiveStaffGrant)) return { kind: "STAFF" };
  if (rows.length > 1) return { kind: "MULTIPLE" };
  const [row] = rows;
  const name = normalizePersonName(verifiedName);
  if (!name || name !== normalizePersonName(row.name)) return { kind: "NAME_MISMATCH" };
  if (!row.authUserId || !row.phoneVerifiedAt) return { kind: "NOT_READY" };
  return { kind: "OK", userId: row.id, authUserId: row.authUserId };
}

export const LINK_RESULT_MESSAGES: Record<Exclude<LinkTargetResult["kind"], "OK">, string> = {
  NONE: "인증하신 휴대폰 번호로 가입된 계정이 없습니다. 이전 화면에서 새로 가입해 주세요.",
  STAFF: "학원 직원이 쓰는 번호라 자동으로 연결하지 않았어요. 학원에 문의해 주세요.",
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
  return `[STIZ 농구교실] 회원님 계정에 ${providerLabel} 로그인이 연결되었습니다. 본인이 하지 않았다면 바로 학원(070-8824-5712)으로 연락해 주세요.`;
}

/** 본인인증으로 기존 계정에 로그인된 순간의 알림 — 연결 단계에서 취소해도 «들어왔다»는 사실은 알린다. */
export function identityLoginNoticeBody(): string {
  return "[STIZ 농구교실] 휴대폰 명의 본인인증으로 회원님 계정에 로그인되었습니다. 본인이 하지 않았다면 바로 학원(070-8824-5712)으로 연락해 주세요.";
}
