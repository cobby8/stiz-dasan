// 셔틀 «탔어요·내렸어요» 학부모 알림 규칙(2026-11-14 원장 결정표).
//
// 왜 바로 안 보내고 «1분 뒤»에 보내나:
//   기사님이 줄을 잘못 눌러 «탑승»을 찍었다가 곧바로 되돌리거나 «미탑승»으로 고치는 일이 있다.
//   즉시 보내면 학부모는 타지도 않은 아이의 «셔틀에 탔어요»를 받는다.
//   → 매분 도는 push-outbox 크론이 «탑승으로 찍힌 지 1분이 지났고, 지금도 탑승인» 줄만 골라 보낸다.
//     (ShuttleBoarding.checkedAt 이 마지막으로 찍은 시각이다. 되돌리면 줄이 지워지고, 다시 찍으면 시계가 새로 돈다.)
//
// 보내는 것은 두 가지뿐:
//   - 등원(집 앞에서 타는 줄)의 탑승 → «셔틀에 탔어요»
//   - 하원(집 앞에서 내리는 줄)의 탑승 체크 → «셔틀에서 내렸어요»
// 보내지 않는 것: 미탑승(NOSHOW)·자차(SELF) · 한 번 보낸 뒤의 정정 · 오늘(KST)이 아닌 날짜의 체크 ·
//   찍은 지 너무 오래된 체크(크론이 멈췄다 살아나거나 배포 직후에 아침 탑승이 오후에 몰려 나가지 않게).
// 같은 아이·같은 날·같은 방향은 한 번만(dedupeKey).
//
// 유료 문자·알림톡은 쓰지 않는다 — 출석 알림과 같은 길(앱 알림함 + 푸시, deliverParentNotification)만 쓴다.
// 이벤트 이름이 SHUTTLE 로 시작해 학부모 설정의 «셔틀» 스위치로 휴대폰 울림을 끌 수 있다(pushCategoryOf).
//
// ⚠️ prisma·next import 금지(테스트가 이 파일을 그대로 실행한다).

import { kstHm } from "@/lib/datetime/kst";

/** 탑승으로 찍힌 뒤 이만큼 지나도 여전히 탑승이면 보낸다(초). */
export const BOARDING_NOTICE_DELAY_SECONDS = 60;
/** 찍은 지 이만큼 넘은 체크는 보내지 않는다(초) — 뒤늦은 «방금 탔어요»를 막는다. */
export const BOARDING_NOTICE_MAX_AGE_SECONDS = 30 * 60;

export type BoardingLeg = "PICKUP" | "DROPOFF";

/** 알림 장부의 이벤트 종류 — 둘 다 SHUTTLE 로 시작한다(«셔틀» 스위치). */
export const BOARDING_NOTICE_EVENT: Record<BoardingLeg, string> = {
  PICKUP: "SHUTTLE_BOARDED",
  DROPOFF: "SHUTTLE_ALIGHTED",
};
export const BOARDING_NOTICE_EVENTS: readonly string[] = [BOARDING_NOTICE_EVENT.PICKUP, BOARDING_NOTICE_EVENT.DROPOFF];

/** DB 에서 읽은 탑승 체크 한 줄(정규·방학특강 공통 모양). */
export type BoardingRow = {
  /** 'REGULAR'(정규) | 'PICKUP' | 'DROPOFF'(방학특강) */
  direction: string;
  /** 정규 = 셔틀 명단 줄(RegularShuttleStop.id) / 방학특강 = 셔틀 신청 id */
  shuttleRequestId: string;
  status: string;
  /** 정규 줄일 때 그 명단 줄의 학생 id · 방향('BOARD' | 'ALIGHT') */
  rosterStudentId: string | null;
  stopDirection: string | null;
  /** checkedAt 을 초(epoch)로 — 칼럼이 timestamp 든 timestamptz 든 같은 값이 나온다(EXTRACT(EPOCH …)) */
  checkedEpoch: number | string | null;
};

export type ResolvedBoarding = { studentId: string; leg: BoardingLeg; checkedAtMs: number };

/**
 * 체크 한 줄 → «어느 아이의 등원/하원 탑승인가». 탑승(BOARDED)이 아니거나 아이를 못 찾으면 null.
 * seasonalStudentByRequest: 방학특강 셔틀 신청 id → 학생 id(확정 명단 게이트웨이가 준 값)
 */
export function resolveBoarding(
  row: BoardingRow,
  seasonalStudentByRequest: ReadonlyMap<string, string | null>,
): ResolvedBoarding | null {
  if (row.status !== "BOARDED") return null;
  const checkedAtMs = Math.round(Number(row.checkedEpoch) * 1000);
  if (!Number.isFinite(checkedAtMs) || checkedAtMs <= 0) return null;
  if (row.direction === "REGULAR") {
    // 정규: 명단 줄의 방향이 등원(BOARD)·하원(ALIGHT)을 정한다. 회차·복귀 줄(PIVOT·RETURN)은 아이 줄이 아니다.
    const leg: BoardingLeg | null = row.stopDirection === "BOARD" ? "PICKUP" : row.stopDirection === "ALIGHT" ? "DROPOFF" : null;
    if (!leg || !row.rosterStudentId) return null;
    return { studentId: row.rosterStudentId, leg, checkedAtMs };
  }
  if (row.direction === "PICKUP" || row.direction === "DROPOFF") {
    const studentId = seasonalStudentByRequest.get(row.shuttleRequestId) ?? null;
    if (!studentId) return null;
    return { studentId, leg: row.direction, checkedAtMs };
  }
  return null;
}

/**
 * 지금 보낼 탑승 알림 고르기 — 1분이 지났고 30분이 안 된 «탑승» 체크, 아이·방향마다 하나(먼저 찍힌 것).
 * 1분 안에 되돌린 줄은 DB 에서 지워져 rows 에 없고, «미탑승»으로 고친 줄은 status 로 걸러진다.
 */
export function pickBoardingNotices(
  rows: readonly BoardingRow[],
  seasonalStudentByRequest: ReadonlyMap<string, string | null>,
  nowMs: number,
): ResolvedBoarding[] {
  const byKey = new Map<string, ResolvedBoarding>();
  for (const row of rows) {
    const resolved = resolveBoarding(row, seasonalStudentByRequest);
    if (!resolved) continue;
    const ageSeconds = (nowMs - resolved.checkedAtMs) / 1000;
    if (ageSeconds < BOARDING_NOTICE_DELAY_SECONDS || ageSeconds > BOARDING_NOTICE_MAX_AGE_SECONDS) continue;
    const key = `${resolved.studentId}:${resolved.leg}`;
    const current = byKey.get(key);
    if (!current || resolved.checkedAtMs < current.checkedAtMs) byKey.set(key, resolved);
  }
  return [...byKey.values()].sort((a, b) => a.checkedAtMs - b.checkedAtMs);
}

/** 같은 아이·같은 날·같은 방향·같은 학부모는 한 번만. */
export function boardingNoticeDedupeKey(input: { dateYmd: string; leg: BoardingLeg; studentId: string; userId: string }): string {
  return `shuttle-boarding:${input.dateYmd}:${input.leg}:student:${input.studentId}:user:${input.userId}`;
}

/** 웹푸시 장부 키 — deliverParentNotification 이 앱 알림 키 뒤에 «:push» 를 붙여 따로 남긴다. */
export const BOARDING_PUSH_KEY_SUFFIX = ":push";

/** 학부모가 받는 문구 — 짧게. 찍힌 시각(KST)을 끝에 붙여 알림이 조금 늦게 와도 언제 일인지 알 수 있게 한다. */
export function boardingNoticeTitle(leg: BoardingLeg): string {
  return leg === "PICKUP" ? "셔틀 탑승 안내" : "셔틀 하차 안내";
}
export function boardingNoticeMessage(leg: BoardingLeg, studentName: string, checkedAtMs: number): string {
  const time = kstHm(checkedAtMs);
  const body = leg === "PICKUP" ? `${studentName} 학생이 셔틀에 탔어요.` : `${studentName} 학생이 셔틀에서 내렸어요.`;
  return time ? `${body} (${time})` : body;
}

// ── 학부모 홈 «오늘 셔틀» 줄의 실제 시각 ─────────────────────────────────────

/** 홈 표시용 키 — 아이 + 방향 */
export function boardingTimeKey(studentId: string, leg: BoardingLeg): string {
  return `${studentId}:${leg}`;
}

/**
 * 오늘 탑승 체크 → «아이:방향 → "08:52"»(KST). 탑승(BOARDED)만.
 * 같은 아이·같은 방향에 줄이 둘이면 등원은 먼저 탄 시각, 하원은 마지막에 내린 시각.
 */
export function boardingTimeLabels(
  rows: readonly BoardingRow[],
  seasonalStudentByRequest: ReadonlyMap<string, string | null>,
): Map<string, string> {
  const best = new Map<string, ResolvedBoarding>();
  for (const row of rows) {
    const resolved = resolveBoarding(row, seasonalStudentByRequest);
    if (!resolved) continue;
    const key = boardingTimeKey(resolved.studentId, resolved.leg);
    const current = best.get(key);
    const better = !current
      || (resolved.leg === "PICKUP" ? resolved.checkedAtMs < current.checkedAtMs : resolved.checkedAtMs > current.checkedAtMs);
    if (better) best.set(key, resolved);
  }
  const out = new Map<string, string>();
  for (const [key, value] of best) {
    const label = kstHm(value.checkedAtMs);
    if (label) out.set(key, label);
  }
  return out;
}
