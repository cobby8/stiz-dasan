// 학부모 쪽 정규 셔틀 계산 — 순수 함수(DB·React·시계 없음). 실행 테스트: tests/parent-child-profile-shuttle.test.mjs
// ─────────────────────────────────────────────────────────────────────────────
// 왜 만들었나(2026-11-14 원장 «셔틀 관련 기능도 정확하게»):
//   관리자 명단(RegularShuttleStop)에는 이번 달 60명이 있는데, 학부모 홈·수업 탭은 옛 노선 승객 표
//   (ShuttleRoutePassenger, 운영 0행)를 목록 기준으로 읽어 정규 셔틀이 아무에게도 안 보였다.
//   기사님·관리자 운행표는 이미 «명단이 유일한 정본»(5단계, 2026-11-09)이다 → 학부모도 같은 명단을 읽는다.
//
// 같은 출처·같은 규칙(기사님 화면 getRegularDriverClasses 와 대조):
//   - 명단 달: 그날이 속한 달 «이하»의 가장 최근 명단 달(pickServiceMonthFor 와 같은 기준) — 호출부가 고른다
//   - 승차·하차 시각: 명단 행 arriveTime(BOARD=승차, ALIGHT=하차), 정리 함수 hhmm 은 regularRosterEtaLogic 것
//   - 같은 요일·방향 행이 여럿이면 명단 순서(sortOrder) 첫 행(buildRosterEtas 와 같은 규칙)
//   - 결석: RegularAbsence(REPORTED·CONFIRMED) · «오늘만» 변경: ShuttleDayException(취소 안 된 것), 방향은 appliesToDirection
// 기사님 화면에 없는 판정(학부모에게 «운행 없음»을 정확히 알리려고 더한 것):
//   - 휴무: 연간일정 수업일이 아니면(공휴일·방학) 운행 없음 — 수업 탭 «다음 수업»과 같은 수업일 계산
//   - 휴원·퇴원·첫 수업 전: 그 반 수강 상태로 판정
// 날짜는 전부 "YYYY-MM-DD" 문자열, 요일은 공용 kstDow(시간대 개입 없음).

import { addDaysKst, kstDow } from "@/lib/datetime/kst";
import { dowToRosterWeekday, hhmm } from "@/lib/shuttle/regularRosterEtaLogic";
import { appliesToDirection, describeException } from "@/lib/shuttle/dayExceptionRules";

/** 명단 한 행에서 쓰는 칸만 */
export type RosterStopRow = {
  id: string;
  weekday: number; // 0=일 … 6=토
  direction: string; // BOARD | ALIGHT (PIVOT·RETURN 은 학생 행이 아니라 무시)
  stopName: string | null;
  arriveTime: string | null;
  classTime: string | null; // "18:00~19:20"
  sortOrder?: number | null;
};

/** 아이의 정규 반(수강 중·휴원 중) — 수강 상태로 운행 여부를 판정한다 */
export type ShuttleClassRef = {
  classId: string;
  className: string;
  dayOfWeek: string; // Mon … Sun
  startTime: string; // "18:00"
  status: string; // ACTIVE | PAUSED
  startsOn: string | null; // 첫 수업일(그 전엔 운행 없음)
  /** 승인됐지만 아직 반영 전인 휴원·퇴원(가장 이른 1건) */
  scheduled: { kind: string; effectiveFrom: string; resumeOn: string | null } | null;
  /** 휴원 중이면 복귀 예정일 */
  pausedResumeOn: string | null;
};

export type ShuttleLeg = { stopName: string; time: string | null };

/** 요일별 승하차 한 줄 — 관리자 원생 상세 «셔틀 배차»와 같은 묶음(요일 × 수업시간) */
export type WeeklyShuttleRow = {
  weekday: number;
  dayLabel: string; // "월"
  classTime: string | null;
  classId: string | null;
  className: string | null;
  board: ShuttleLeg | null;
  alight: ShuttleLeg | null;
};

export type ShuttleDayStatus = "RUN" | "HOLIDAY" | "PAUSED" | "ENDED" | "NOT_STARTED" | "ABSENT";
export type ShuttleDayLeg = ShuttleLeg & {
  /** RUN 운행 · SKIP 안 탐(«오늘만» 신청) · CHANGED 다른 곳에서 탐 */
  state: "RUN" | "SKIP" | "CHANGED";
  /** 기사님 화면과 같은 문구(describeException) */
  note: string | null;
  /** 다른 곳에서 탈 때 그 장소 */
  changedTo: string | null;
};

export type ShuttleDayRow = {
  ymd: string;
  weekday: number;
  dayLabel: string;
  classId: string | null;
  className: string | null;
  classTime: string | null;
  status: ShuttleDayStatus;
  statusText: string;
  board: ShuttleDayLeg | null;
  alight: ShuttleDayLeg | null;
  /** 연간일정이 아직 없어 휴무 여부를 모른다(명단대로 운행으로 본다) */
  planMissing: boolean;
};

export const SHUTTLE_DAY_STATUS_TEXT: Record<ShuttleDayStatus, string> = {
  RUN: "운행",
  HOLIDAY: "휴무",
  PAUSED: "휴원",
  ENDED: "퇴원",
  NOT_STARTED: "첫 수업 전",
  ABSENT: "결석",
};

const DAY_KO = ["일", "월", "화", "수", "목", "금", "토"];
/** 월요일부터 보이게(일요일은 맨 뒤) */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

/** "18:00~19:20" → "18:00" (앞 시각). 못 읽으면 null */
export function rosterClassStart(classTime: string | null | undefined): string | null {
  return hhmm(String(classTime ?? "").split(/[~\-–]/)[0]);
}

/**
 * 명단 행(요일·수업시간)이 아이의 어느 반인지. 요일이 같고 시작 시각이 같은 반,
 * 시작 시각이 안 맞으면 그 요일 반이 하나뿐일 때만 그 반. 못 고르면 null(명단대로 운행으로 본다).
 */
export function matchRosterClass(weekday: number, classTime: string | null, classes: readonly ShuttleClassRef[]): ShuttleClassRef | null {
  const sameDay = classes.filter((c) => dowToRosterWeekday(c.dayOfWeek) === weekday);
  const start = rosterClassStart(classTime);
  const exact = start ? sameDay.find((c) => hhmm(c.startTime) === start) : undefined;
  if (exact) return exact;
  return sameDay.length === 1 ? sameDay[0] : null;
}

function legOf(row: RosterStopRow | undefined): ShuttleLeg | null {
  if (!row) return null;
  const stopName = String(row.stopName ?? "").trim();
  return { stopName: stopName || "정류장 미정", time: hhmm(row.arriveTime) };
}

/**
 * 요일별 승하차(요일 × 수업시간 묶음). 같은 요일·수업시간·방향 행이 여럿이면 명단 순서 첫 행.
 * 학생 행(BOARD·ALIGHT)만 본다.
 */
export function weeklyShuttlePlan(rows: readonly RosterStopRow[], classes: readonly ShuttleClassRef[]): WeeklyShuttleRow[] {
  const ordered = [...rows]
    .filter((r) => (r.direction === "BOARD" || r.direction === "ALIGHT") && r.weekday >= 0 && r.weekday <= 6)
    .sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
  const groups = new Map<string, { weekday: number; classTime: string | null; board?: RosterStopRow; alight?: RosterStopRow }>();
  for (const r of ordered) {
    const classTime = String(r.classTime ?? "").trim() || null;
    const key = `${r.weekday}|${classTime ?? ""}`;
    const g = groups.get(key) ?? { weekday: r.weekday, classTime };
    if (r.direction === "BOARD" && !g.board) g.board = r;
    if (r.direction === "ALIGHT" && !g.alight) g.alight = r;
    groups.set(key, g);
  }
  return [...groups.values()]
    .map((g) => {
      const cls = matchRosterClass(g.weekday, g.classTime, classes);
      return {
        weekday: g.weekday,
        dayLabel: DAY_KO[g.weekday],
        classTime: g.classTime,
        classId: cls?.classId ?? null,
        className: cls?.className ?? null,
        board: legOf(g.board),
        alight: legOf(g.alight),
      };
    })
    .sort((a, b) => WEEK_ORDER.indexOf(a.weekday) - WEEK_ORDER.indexOf(b.weekday) || String(a.classTime).localeCompare(String(b.classTime)));
}

/** 그날 그 반의 수강 상태 — 첫 수업 전 · 퇴원(승인된 퇴원 적용일부터) · 휴원(승인된 휴원 기간 또는 휴원 중) · 수강 */
export function enrollmentStateOn(c: ShuttleClassRef, ymd: string): "ACTIVE" | "PAUSED" | "ENDED" | "NOT_STARTED" {
  if (c.startsOn && ymd < c.startsOn) return "NOT_STARTED";
  const s = c.scheduled;
  if (s?.kind === "WITHDRAW" && s.effectiveFrom && ymd >= s.effectiveFrom) return "ENDED";
  if (s?.kind === "PAUSE" && s.effectiveFrom && ymd >= s.effectiveFrom && (!s.resumeOn || ymd < s.resumeOn)) return "PAUSED";
  if (c.status === "PAUSED" && (!c.pausedResumeOn || ymd < c.pausedResumeOn)) return "PAUSED";
  return "ACTIVE";
}

export type ShuttleAbsence = { ymd: string; classId: string | null };
export type ShuttleException = { ymd: string; direction: string; kind: string; location: string | null };

/**
 * 오늘부터 n일(기본 7일) 운행 일정 — 명단에 있는 요일만 한 줄씩.
 * rowsForDate: 그날이 속한 명단 달의 이 아이 행(호출부가 달을 고른다)
 * isClassDay: 그 반 그날이 연간일정 수업일인가(true/false), 연간일정이 없어 모르면 null
 * 판정 순서: 수강 상태(첫 수업 전·퇴원·휴원) → 휴무(수업일 아님) → 결석 → «오늘만» 변경(방향별)
 */
export function buildShuttleDays(input: {
  today: string;
  days?: number;
  rowsForDate: (ymd: string) => readonly RosterStopRow[];
  classes: readonly ShuttleClassRef[];
  isClassDay: (c: ShuttleClassRef, ymd: string) => boolean | null;
  absences: readonly ShuttleAbsence[];
  exceptions: readonly ShuttleException[];
}): ShuttleDayRow[] {
  const out: ShuttleDayRow[] = [];
  const n = input.days ?? 7;
  for (let i = 0; i < n; i++) {
    const ymd = addDaysKst(input.today, i);
    if (!ymd) continue;
    const weekday = kstDow(ymd);
    const plans = weeklyShuttlePlan(input.rowsForDate(ymd), input.classes).filter((p) => p.weekday === weekday);
    for (const p of plans) {
      const cls = p.classId ? input.classes.find((c) => c.classId === p.classId) ?? null : null;
      let status: ShuttleDayStatus = "RUN";
      let planMissing = false;
      const state = cls ? enrollmentStateOn(cls, ymd) : "ACTIVE";
      if (state !== "ACTIVE") {
        status = state;
      } else {
        const classDay = cls ? input.isClassDay(cls, ymd) : null;
        if (classDay === false) status = "HOLIDAY";
        else {
          planMissing = classDay === null;
          const absent = input.absences.some((a) => a.ymd === ymd && (!a.classId || !cls || a.classId === cls.classId));
          if (absent) status = "ABSENT";
        }
      }
      // 운행하는 날만 방향별 «오늘만» 변경을 붙인다(운행 없는 날은 다리 칸을 그대로 두고 상태로 말한다)
      const leg = (base: ShuttleLeg | null, dir: "PICKUP" | "DROPOFF"): ShuttleDayLeg | null => {
        if (!base) return null;
        if (status !== "RUN") return { ...base, state: "RUN", note: null, changedTo: null };
        const ex = input.exceptions.find((e) => e.ymd === ymd && appliesToDirection(e.direction, dir));
        if (!ex) return { ...base, state: "RUN", note: null, changedTo: null };
        if (ex.kind === "SKIP") return { ...base, state: "SKIP", note: describeException(ex), changedTo: null };
        return { ...base, state: "CHANGED", note: describeException(ex), changedTo: ex.location ?? null };
      };
      const board = leg(p.board, "PICKUP");
      const alight = leg(p.alight, "DROPOFF");
      const allSkipped = status === "RUN" && [board, alight].filter(Boolean).every((l) => l!.state === "SKIP");
      out.push({
        ymd,
        weekday,
        dayLabel: p.dayLabel,
        classId: p.classId,
        className: p.className,
        classTime: p.classTime,
        status,
        statusText: allSkipped ? "안 탐(신청)" : SHUTTLE_DAY_STATUS_TEXT[status],
        board,
        alight,
        planMissing,
      });
    }
  }
  return out;
}

/** 학부모 홈·수업·일정 탭이 쓰는 셔틀 항목 모양(ParentShuttleOverviewItem 과 같은 칸) */
export type RosterOverviewItem = {
  id: string;
  studentId: string;
  sourceType: "REGULAR_CLASS";
  classId: string | null;
  direction: "PICKUP" | "DROPOFF";
  status: "CONFIRMED";
  label: string;
  title: string;
  serviceDate: string;
  routeName: null;
  stopName: string;
  stopAddress: null;
  plannedAt: null;
  vehicleName: null;
  rideStatus: null;
  pickupEtaLabel: string | null;
  dropoffEtaLabel: string | null;
};

/**
 * 운행 일정 → 홈·수업 탭 셔틀 항목. 실제로 타는 칸만(운행 날 + 안 탐 신청이 아닌 방향).
 * 시각 라벨은 저장 노선 시절과 같은 «HH:MM 승차»·«HH:MM 하차»(buildRosterEtas 와 같은 글자).
 */
export function rosterOverviewItems(studentId: string, studentName: string, days: readonly ShuttleDayRow[]): RosterOverviewItem[] {
  const items: RosterOverviewItem[] = [];
  for (const d of days) {
    if (d.status !== "RUN") continue;
    for (const [direction, leg] of [["PICKUP", d.board], ["DROPOFF", d.alight]] as const) {
      if (!leg || leg.state === "SKIP") continue;
      items.push({
        id: `roster:${studentId}:${d.ymd}:${direction}:${d.classTime ?? ""}`,
        studentId,
        sourceType: "REGULAR_CLASS",
        classId: d.classId,
        direction,
        status: "CONFIRMED",
        label: studentName,
        title: d.className ?? "정규 수업",
        serviceDate: d.ymd,
        routeName: null,
        stopName: leg.state === "CHANGED" && leg.changedTo ? leg.changedTo : leg.stopName,
        stopAddress: null,
        plannedAt: null,
        vehicleName: null,
        rideStatus: null,
        pickupEtaLabel: direction === "PICKUP" && leg.time ? `${leg.time} 승차` : null,
        dropoffEtaLabel: direction === "DROPOFF" && leg.time ? `${leg.time} 하차` : null,
      });
    }
  }
  return items;
}
