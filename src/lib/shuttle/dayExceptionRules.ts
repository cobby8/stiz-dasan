/**
 * "오늘만" 셔틀 변경 규칙.
 *
 * 결석과 다르다 — 아이는 수업에 온다. 셔틀만 안 타거나, 다른 곳에서 탄다.
 * 그래서 기사님 화면에서도 "결석"이 아닌 다른 배지로 보여야 한다.
 *
 * 화면·서버가 각자 판단하면 "화면에선 되는데 저장이 안 되는" 어긋남이 생긴다.
 */

export const SHUTTLE_DIRECTIONS = ["PICKUP", "DROPOFF", "BOTH"] as const;
export type ShuttleDirection = (typeof SHUTTLE_DIRECTIONS)[number];

export const SHUTTLE_DIRECTION_LABEL: Record<ShuttleDirection, string> = {
  PICKUP: "등원(타러 갈 때)",
  DROPOFF: "하원(데려다줄 때)",
  BOTH: "등원·하원 모두",
};

export const SHUTTLE_EXCEPTION_KINDS = ["SKIP", "LOCATION"] as const;
export type ShuttleExceptionKind = (typeof SHUTTLE_EXCEPTION_KINDS)[number];

export const SHUTTLE_EXCEPTION_KIND_LABEL: Record<ShuttleExceptionKind, string> = {
  SKIP: "오늘 안 타요",
  LOCATION: "다른 곳에서 타요",
};

// 학부모 화면 전용 짧은 라벨(2026-11-14 문구 정리) — «등원(타러 갈 때)»→«등원», «오늘 안 타요»→«안 타요»(오늘이 아닌 날도 고른다).
// 위 SHUTTLE_*_LABEL 은 관리자 화면·카카오 대화·기사님 알림 글이 그대로 쓰므로 건드리지 않는다.
export const PARENT_SHUTTLE_DIRECTION_LABEL: Record<ShuttleDirection, string> = {
  PICKUP: "등원",
  DROPOFF: "하원",
  BOTH: "등원·하원 모두",
};

export const PARENT_SHUTTLE_EXCEPTION_KIND_LABEL: Record<ShuttleExceptionKind, string> = {
  SKIP: "안 타요",
  LOCATION: "다른 곳에서 타요",
};

// «안 타요»를 학부모 말로(2026-11-14 원장 결정표 묶음 B): 셔틀을 안 타는 날은 보호자가 직접 데려다주거나 데리러 온다 —
// 방향에 맞춰 «직접 데려다줘요 / 직접 데리러 가요(자차)»로 보인다. 저장 값(kind=SKIP)은 그대로다.
// 기사님 화면에는 «자차»로 보이고 그 방향 탑승·미탑승 버튼이 잠긴다(arrivalNoticeRules.shuttleSkipLabel).
export const PARENT_SHUTTLE_SKIP_LABEL: Record<ShuttleDirection, string> = {
  PICKUP: "직접 데려다줘요(자차)",
  DROPOFF: "직접 데리러 가요(자차)",
  BOTH: "등원·하원 모두 자차",
};

/** 학부모 화면에 보이는 변경 내용 한마디 — SKIP 은 방향에 맞춘 자차 글자, LOCATION 은 «다른 곳에서 타요». 모르는 값이면 null */
export function parentShuttleChangeLabel(kind: string, direction: string): string | null {
  if (kind === "SKIP") return PARENT_SHUTTLE_SKIP_LABEL[direction as ShuttleDirection] ?? PARENT_SHUTTLE_EXCEPTION_KIND_LABEL.SKIP;
  return PARENT_SHUTTLE_EXCEPTION_KIND_LABEL[kind as ShuttleExceptionKind] ?? null;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export function isYmd(value: unknown): value is string {
  if (typeof value !== "string" || !YMD.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** 오늘부터 이 일수 안쪽만 신청할 수 있다. 너무 먼 날은 배차가 정해지지 않았다. */
export const MAX_DAYS_AHEAD = 14;

export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

export type ShuttleExceptionError =
  | "INVALID_DATE"
  | "DATE_IN_PAST"
  | "DATE_TOO_FAR"
  | "INVALID_DIRECTION"
  | "INVALID_KIND"
  | "LOCATION_REQUIRED"
  | "LOCATION_NOT_ALLOWED"
  | "NOTE_TOO_LONG";

export const SHUTTLE_EXCEPTION_MESSAGE: Record<ShuttleExceptionError, string> = {
  INVALID_DATE: "날짜를 다시 확인해 주세요.",
  DATE_IN_PAST: "지난 날짜는 바꿀 수 없습니다.",
  DATE_TOO_FAR: `${MAX_DAYS_AHEAD}일 이내로 선택해 주세요.`,
  INVALID_DIRECTION: "등원·하원 중 어느 쪽인지 선택해 주세요.",
  INVALID_KIND: "무엇을 바꾸실지 선택해 주세요.",
  LOCATION_REQUIRED: "어디에서 타실지 적어 주세요.",
  LOCATION_NOT_ALLOWED: "안 타는 날은 장소를 적지 않습니다.",
  NOTE_TOO_LONG: "남기실 말씀은 300자 이내로 적어 주세요.",
};

export type ShuttleExceptionInput = {
  serviceDate?: unknown;
  direction?: unknown;
  kind?: unknown;
  location?: unknown;
  note?: unknown;
};

export function validateShuttleException(
  input: ShuttleExceptionInput,
  context: { today: string },
): { ok: true; direction: ShuttleDirection; kind: ShuttleExceptionKind } | { ok: false; error: ShuttleExceptionError } {
  if (!isYmd(input.serviceDate)) return { ok: false, error: "INVALID_DATE" };
  // 지난 날은 기사님이 이미 운행을 마쳤다. 바꿔봐야 아무 일도 일어나지 않는다.
  if (input.serviceDate < context.today) return { ok: false, error: "DATE_IN_PAST" };
  if (input.serviceDate > addDays(context.today, MAX_DAYS_AHEAD)) return { ok: false, error: "DATE_TOO_FAR" };

  if (
    typeof input.direction !== "string" ||
    !(SHUTTLE_DIRECTIONS as readonly string[]).includes(input.direction)
  ) {
    return { ok: false, error: "INVALID_DIRECTION" };
  }
  if (
    typeof input.kind !== "string" ||
    !(SHUTTLE_EXCEPTION_KINDS as readonly string[]).includes(input.kind)
  ) {
    return { ok: false, error: "INVALID_KIND" };
  }

  if (typeof input.note === "string" && input.note.length > 300) {
    return { ok: false, error: "NOTE_TOO_LONG" };
  }

  const hasLocation = typeof input.location === "string" && input.location.trim().length > 0;
  if (input.kind === "LOCATION" && !hasLocation) return { ok: false, error: "LOCATION_REQUIRED" };
  // 안 타는데 장소가 붙어 오면 화면과 서버가 어긋난 것이다. 조용히 버리지 않는다.
  if (input.kind === "SKIP" && hasLocation) return { ok: false, error: "LOCATION_NOT_ALLOWED" };

  return { ok: true, direction: input.direction as ShuttleDirection, kind: input.kind as ShuttleExceptionKind };
}

/** 기사님 화면에 찍을 한 줄. 결석과 헷갈리지 않게 "셔틀"을 앞에 둔다. */
export function describeException(input: {
  kind: string;
  location?: string | null;
}): string {
  if (input.kind === "SKIP") return "오늘 셔틀 안 탐";
  return `오늘 탑승 장소: ${input.location ?? "-"}`;
}

/** 그 예외가 이 방향(등원/하원)에 적용되는지. BOTH 는 양쪽 모두. */
export function appliesToDirection(exceptionDirection: string, runDirection: "PICKUP" | "DROPOFF"): boolean {
  return exceptionDirection === "BOTH" || exceptionDirection === runDirection;
}
