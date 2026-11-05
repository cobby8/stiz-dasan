// 3년 이상 재원생 유니폼 무료 증정 — 순수 규칙(DB·시계 의존 0)
//
// 링크(토큰) 하나 = 학생 한 명의 무료 유니폼 한 벌. 상태는 한 방향으로만 간다:
//   ISSUED(발급) → USED(신청 완료)   또는   ISSUED → REVOKED(원장 취소)
// 만료는 상태 칸이 아니라 expiresAt 시각으로 판정한다(크론 없이도 정확하다).

export const UNIFORM_FREE_GRANT_STATUSES = ["ISSUED", "USED", "REVOKED"] as const;
export type UniformFreeGrantStatus = (typeof UNIFORM_FREE_GRANT_STATUSES)[number];

export const UNIFORM_FREE_GRANT_REASON = "TENURE_3Y";

// 무료 주문 표시 — 주문 메모 맨 앞에 붙여, 관리자 목록 배지·본사 메모 양쪽에서 알아보게 한다
export const FREE_UNIFORM_MEMO_PREFIX = "[3년 재원 무료 증정]";

// 무료 주문은 본사로 자동 발송하지 않는다.
// 크론(dispatchDueUniformOrders)은 PENDING·RETRY_WAIT 만 집어 가므로, 처음부터 NEEDS_REVIEW 로
// 저장하면 원장이 관리자 화면에서 «재전송» 을 누르기 전까지 본사로 나가지 않는다.
export const FREE_UNIFORM_SYNC_STATUS = "NEEDS_REVIEW";
export const FREE_UNIFORM_STIZ_MESSAGE = "무료 증정: 원장 확인 후 본사 발송";

// 토큰 = crypto.randomBytes(24) 의 base64url → 항상 32글자(A-Z a-z 0-9 - _)
export const UNIFORM_FREE_TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function isWellFormedGrantToken(token: unknown): token is string {
  return typeof token === "string" && UNIFORM_FREE_TOKEN_RE.test(token);
}

export type GrantUnusableReason = "NOT_FOUND" | "USED" | "REVOKED" | "EXPIRED";

export type GrantEvaluation =
  | { usable: true }
  | { usable: false; reason: GrantUnusableReason };

/**
 * 링크로 지금 신청할 수 있는지 판정.
 * 순서가 중요하다: 이미 신청한 링크는 만료가 지나도 «이미 신청» 으로 안내해야 학부모가 덜 헷갈린다.
 */
export function evaluateFreeGrant(
  grant: { status: string; expiresAt: Date | string | number | null } | null | undefined,
  nowMs: number,
): GrantEvaluation {
  if (!grant) return { usable: false, reason: "NOT_FOUND" };
  if (grant.status === "USED") return { usable: false, reason: "USED" };
  if (grant.status === "REVOKED") return { usable: false, reason: "REVOKED" };
  if (grant.status !== "ISSUED") return { usable: false, reason: "NOT_FOUND" };
  const expiresMs = grant.expiresAt === null ? NaN : new Date(grant.expiresAt).getTime();
  // 만료 시각이 없거나 깨졌으면 쓸 수 없는 링크로 본다(안전한 쪽)
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) return { usable: false, reason: "EXPIRED" };
  return { usable: true };
}

/** 학부모에게 보여줄 안내 문구 */
export function grantUnusableMessage(reason: GrantUnusableReason): string {
  switch (reason) {
    case "USED":
      return "이 링크로 이미 유니폼 신청이 접수되었습니다.";
    case "REVOKED":
      return "이 링크는 더 이상 사용할 수 없습니다.";
    case "EXPIRED":
      return "신청 기간이 지난 링크입니다.";
    default:
      return "링크를 확인할 수 없습니다. 받으신 주소가 맞는지 확인해 주세요.";
  }
}

/** 무료 주문 메모: 앞에 표시를 붙이고, 학부모 메모가 있으면 뒤에 잇는다 */
export function buildFreeUniformMemo(memo: string | null | undefined): string {
  const trimmed = String(memo ?? "").trim().slice(0, 500);
  return trimmed ? `${FREE_UNIFORM_MEMO_PREFIX} ${trimmed}` : FREE_UNIFORM_MEMO_PREFIX;
}

/** 관리자 목록에서 무료 증정 주문인지(배지 표시용) */
export function isFreeUniformOrderMemo(memo: string | null | undefined): boolean {
  return typeof memo === "string" && memo.startsWith(FREE_UNIFORM_MEMO_PREFIX);
}
