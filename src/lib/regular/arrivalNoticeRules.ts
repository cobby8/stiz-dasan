// 학부모 «지각·조퇴 알리기»의 순수 규칙(2026-11-14 원장 결정표 묶음 B) — DB·React·시계 없음.
// 실행 테스트: tests/arrival-notice.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 결석과 다른 점
//   · 아이는 수업에 온다 → 보강권이 나가지 않는다(이 기능은 보강권·결석 표를 건드리지 않는다).
//   · 알릴 수 있는 시간이 다르다: 지각은 «수업 시작 전»까지, 조퇴는 «수업이 끝나기 전»까지.
//     (결석·셔틀의 «1시간 전» 규칙이 아니다 — 늦는 것은 직전에야 알게 된다)
// ★ 입력은 전부 KST 로 바꾼 «글자»다(날짜 "YYYY-MM-DD", 시각 "HH:mm"). 이 파일은 시간대를 모른다 —
//   «지금»은 호출부가 kst.ts 로 만들어 넘긴다. 화면·서버가 같은 함수로 판정한다.
import { hmToMinutes, isChangeOpen } from "@/lib/parent/changeDeadline";

export const ARRIVAL_KINDS = ["LATE", "EARLY"] as const;
export type ArrivalKind = (typeof ARRIVAL_KINDS)[number];

export function isArrivalKind(value: unknown): value is ArrivalKind {
  return typeof value === "string" && (ARRIVAL_KINDS as readonly string[]).includes(value);
}

/** 학부모 화면의 고르는 글자 */
export const ARRIVAL_KIND_LABEL: Record<ArrivalKind, string> = { LATE: "늦어요", EARLY: "일찍 가요" };
/** 알린 뒤 보이는 이름(학부모 줄·선생님 출석부·알림 글 공용) */
export const ARRIVAL_NOTICE_NAME: Record<ArrivalKind, string> = { LATE: "지각 예정", EARLY: "조퇴 예정" };
/** 예상 시각을 묻는 글 */
export const ARRIVAL_TIME_QUESTION: Record<ArrivalKind, string> = { LATE: "몇 시쯤 도착하나요?", EARLY: "몇 시쯤 나가나요?" };

/** «지각 예정 17:20» · «조퇴 예정 18:00» — 선생님 출석부와 학부모 줄이 같은 글자를 쓴다 */
export function arrivalNoticeLabel(kind: string, expectedTime: string | null | undefined): string {
  const name = isArrivalKind(kind) ? ARRIVAL_NOTICE_NAME[kind] : "";
  return [name, normalizeHm(expectedTime)].filter(Boolean).join(" ");
}

/** "H:mm"·"HH:mm"(뒤에 초가 붙어도 됨) → "HH:mm". 읽을 수 없으면 null */
export function normalizeHm(value: unknown): string | null {
  const minutes = hmToMinutes(value);
  if (minutes == null) return null;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * 지금 이 수업의 지각·조퇴를 알리거나·바꾸거나·취소할 수 있는가.
 *   · 지각(LATE): 수업 시작 «전»까지(시작 시각 정각부터 닫힘 — 시작 1분 전은 열림)
 *   · 조퇴(EARLY): 수업 끝나기 «전»까지(끝 시각 정각부터 닫힘). 끝 시각을 모르면 시작 시각으로 본다.
 *   · 기준 시각을 모르면 «전날까지»(당일 닫힘). 지난 날짜는 항상 닫힘. 입력이 틀리면 닫힘.
 * 판정 본문은 결석·셔틀·보강과 같은 공용 함수(isChangeOpen)에 «마감 0분»을 넣은 것이다.
 */
export function isArrivalNoticeOpen(
  kind: ArrivalKind,
  classYmd: string,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  nowYmd: string,
  nowHm: string,
): boolean {
  const base = kind === "LATE" ? startTime : hmToMinutes(endTime) != null ? endTime : startTime;
  return isChangeOpen(classYmd, base, nowYmd, nowHm, 0);
}

/**
 * 예상 시각이 그 수업 시간 «안»인가 — 시작보다 늦고 끝보다 이르다(둘 다 정각은 안 됨: 정각 도착은 지각이 아니고, 끝 시각에 가는 것은 조퇴가 아니다).
 * 끝 시각을 모르는 반은 시작보다 늦기만 하면 받는다.
 */
export function isValidExpectedTime(
  expectedTime: unknown,
  startTime: string | null | undefined,
  endTime: string | null | undefined,
): boolean {
  if (typeof expectedTime !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(expectedTime)) return false;
  const value = hmToMinutes(expectedTime);
  const start = hmToMinutes(startTime);
  if (value == null || start == null || value <= start) return false;
  const end = hmToMinutes(endTime);
  return end == null || end <= start ? true : value < end;
}

/** 지각과 조퇴를 함께 알린 날: 도착(지각)이 나가는 시각(조퇴)보다 일러야 한다 */
export function arrivalTimesConsistent(lateTime: string | null | undefined, earlyTime: string | null | undefined): boolean {
  const late = hmToMinutes(lateTime);
  const early = hmToMinutes(earlyTime);
  if (late == null || early == null) return true;
  return late < early;
}

/** 화면에서 고를 예상 시각 목록 — 시작과 끝 사이를 stepMinutes 간격으로(양 끝 제외). 끝을 모르면 시작 뒤 2시간까지 */
export function expectedTimeOptions(
  startTime: string | null | undefined,
  endTime: string | null | undefined,
  stepMinutes = 10,
): string[] {
  const start = hmToMinutes(startTime);
  if (start == null || !(stepMinutes > 0)) return [];
  const rawEnd = hmToMinutes(endTime);
  const end = rawEnd != null && rawEnd > start ? rawEnd : Math.min(start + 120, 24 * 60);
  const out: string[] = [];
  for (let minutes = start + stepMinutes; minutes < end; minutes += stepMinutes) {
    out.push(`${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`);
  }
  return out;
}

// ── 셔틀 연결 ───────────────────────────────────────────────────────────────
// 조퇴로 알린 날, 그 아이가 하원 셔틀을 타는 아이면 «하원 셔틀도 안 타나요?»를 한 번 묻는다(지각 → 등원 셔틀도 같은 방식).
// 안 탄다고 하면 «셔틀 변경 › 자차»와 같은 기록(ShuttleDayException · SKIP)을 만들어 기사님 화면에도 반영한다.

/** 이 알림이 닿는 셔틀 방향: 조퇴 → 하원, 지각 → 등원 */
export function shuttleDirectionOf(kind: ArrivalKind): "PICKUP" | "DROPOFF" {
  return kind === "LATE" ? "PICKUP" : "DROPOFF";
}

/** 셔틀 방향의 학부모 말 */
export const ARRIVAL_SHUTTLE_WORD: Record<ArrivalKind, string> = { LATE: "등원", EARLY: "하원" };

/**
 * 셔틀을 물어볼 날인가.
 *   rosterDirections: 그 날짜(요일)의 셔틀 명단에 있는 방향들('BOARD'=등원·'ALIGHT'=하원)
 *   exceptions: 그 날짜의 살아 있는 셔틀 변경(방향·종류)
 *   withinShuttleWindow: 셔틀 변경을 받을 수 있는 날짜 범위(오늘부터 14일) 안인가
 * 명단에 그 방향이 없거나, 이미 그 방향을 안 탄다고 해 두었으면(SKIP) 묻지 않는다.
 */
export function shuttleAskNeeded(input: {
  kind: ArrivalKind;
  rosterDirections: readonly string[];
  exceptions: readonly { direction: string; kind: string }[];
  withinShuttleWindow: boolean;
}): boolean {
  if (!input.withinShuttleWindow) return false;
  const direction = shuttleDirectionOf(input.kind);
  const rosterDirection = direction === "PICKUP" ? "BOARD" : "ALIGHT";
  if (!input.rosterDirections.includes(rosterDirection)) return false;
  return !input.exceptions.some((x) => x.kind === "SKIP" && (x.direction === "BOTH" || x.direction === direction));
}

// ── 기사님 화면의 «안 타는 사유» 글자 ─────────────────────────────────────────
// «그 방향 셔틀을 안 탄다고 기록된 아이»(ShuttleDayException · SKIP)는 탑승·미탑승 버튼을 잠그고 사유를 글자로 보인다.
// 사유는 그 기록이 어디서 왔는지로 정한다: 지각·조퇴 알림과 함께 만든 기록이면 «지각»·«조퇴», 그 밖은 «자차».
// 지각 «예정»만 알리고 셔틀은 그대로 타는 아이는 SKIP 기록이 없으므로 잠기지 않는다.
export const SHUTTLE_SKIP_SELF_LABEL = "자차";
export const SHUTTLE_SKIP_LABEL: Record<ArrivalKind, string> = { LATE: "지각", EARLY: "조퇴" };

export function shuttleSkipLabel(noticeKind: string | null | undefined): string {
  return isArrivalKind(noticeKind) ? SHUTTLE_SKIP_LABEL[noticeKind] : SHUTTLE_SKIP_SELF_LABEL;
}
