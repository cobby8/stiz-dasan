// 반 이동 → 셔틀 «재배정 필요» 판정(순수 함수, DB 접근 없음) — 2026-11-09 원장 결정 D4.
// ─────────────────────────────────────────────────────────────────────────────
// 왜 «사건»이 아니라 «데이터 비교»인가:
//   반이 바뀌는 길이 여러 개(학생 상세 반 추가+퇴원, 수강 변경 승인, 랠리즈 반영, 원생 등록, 엑셀 가져오기)라
//   각 길에 알림을 심으면 반드시 하나가 빠진다(같은 규칙 두 경로 사고 2회). 그래서 «그 달 명단 행 ↔ 지금 수강»을
//   비교해 어느 길로 바뀌었든 같은 답이 나오게 한다.
//
// 판정 규칙(원장 D4 «옛 칸과 새 칸이 둘 다 생긴 학생만»):
//   ① 옛 칸 = 이 학생의 명단 행인데, 그 요일에 같은 시작 시각의 수업(다님·휴원)이 없다
//      (요일이 바뀜 = 기존 «수업 없는 요일», 같은 요일인데 시각만 바뀜 = 새로 잡는 경우).
//   ② 새 칸 = 셔틀 운행 반(다님)의 요일 × 등원/하원 중, 옛 칸이 아닌 명단 행이 하나도 없는 칸.
//      등원은 그 요일 가장 이른 수업, 하원은 가장 늦은 수업 칸(기사님 새 학생 배정 openLegsFor 와 같은 규칙).
//   ③ 재배정 = 같은 방향끼리 옛 칸 ↔ 새 칸 짝(같은 요일 먼저 = 시각만 바뀐 반, 그다음 요일 순서대로).
//      옛 칸만 남으면 «명단에서 빼기 필요»(removeOnly), 새 칸만 남으면 띄우지 않는다(일부러 안 타는 칸일 수 있음 — 오탐 방지).
//   휴원(PAUSED)만 있는 요일은 옛 칸으로 보지 않는다(복귀하면 그대로 탄다).
//   수강의 셔틀 운행 여부(classRunsShuttle)·개시월 필터는 서버가 읽을 때 이미 걸렀다(driverAssign.loadStudents).
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로 import·enum 을 쓰지 않는다(런타임 import 는 .ts 확장자).

// @ts-expect-error -- TypeScript runtime test compatibility
import { enrolledClassSlots, studentRosterRows, type EnrolledClass } from "./regularRosterPlacementLogic.ts";
// @ts-expect-error -- TypeScript runtime test compatibility
import { classTimeKey, WEEKDAY_LABELS, type RosterDirection } from "./regularRosterEditLogic.ts";
// @ts-expect-error -- TypeScript runtime test compatibility
import { parseClassTimeRange } from "./regularRosterCheckLogic.ts";
import type { RegularShuttleStop } from "./regularSheet";

/** 판정에 쓰는 학생 재료 — driverAssignLogic.AssignStudentInput 의 일부와 같은 모양. */
export type ReassignStudent = {
  studentId: string;
  name: string;
  parentPhone: string | null;
  /** 다님(ACTIVE)·휴원(PAUSED) 수강. 셔틀 미운행 반·개시월 이후 반은 서버가 이미 뺐다. */
  enrolled: readonly EnrolledClass[];
};

/** 옛 칸 하나 = 같은 요일·방향·수업시간의 이 학생 명단 행들(보통 1행). */
export type ReassignFromCell = {
  weekday: number;
  direction: RosterDirection;
  classTime: string;
  rowIds: string[];
  /** 옛 칸 정류장 — 새 칸 배정 화면의 기본값(같은 정류장 그대로가 가장 흔함). */
  stopName: string;
  arriveTime: string | null;
  latitude: number | null;
  longitude: number | null;
};

/** 새 칸 하나 — driverAssignLogic.OpenLeg 와 같은 모양(그대로 planLeg 에 넘긴다). */
export type ReassignToCell = { weekday: number; direction: RosterDirection; classTime: string; startTime: string; label: string };

export type ReassignPair = {
  direction: RosterDirection;
  from: ReassignFromCell;
  to: ReassignToCell;
  /** 짧은 안내 — «화→목 등원 (반 이동)», 같은 요일이면 «화 17:00→18:00 등원 (반 이동)». */
  label: string;
};

export type ReassignPlan = {
  pairs: ReassignPair[];
  /** 새 칸이 없는 옛 칸 — 퇴원·요일 줄임. 재배정이 아니라 «명단에서 빼기 필요». */
  removeOnly: ReassignFromCell[];
};

const DIR_KO: Record<RosterDirection, string> = { BOARD: "등원", ALIGHT: "하원" };
const rank = (w: number) => (w === 0 ? 7 : w); // 월 → 일 순서

/** 수업시간 글자의 시작(분). '17:00~18:00' → 1020. 형식이 아니면 null. */
function startMinute(classTime: string | null | undefined): number | null {
  return parseClassTimeRange(classTime)?.start ?? null;
}

/** 'HH:MM' 시작 시각 → 분. */
function hhmmMinute(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v ?? "").trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 그 요일에 이 시작 시각(분)의 수업(다님·휴원)이 있는가. */
function hasClassAt(enrolled: readonly EnrolledClass[], weekday: number, start: number): boolean {
  return enrolled.some((c) => c.weekday === weekday && hhmmMinute(c.startTime) === start);
}

/**
 * 한 학생의 재배정 판정. stops = 그 달 명단 전체(다른 학생 행 포함 — 수업시간 글자 맞춤에 쓴다).
 * 학생 행을 찾는 규칙은 기사님 새 학생 배정·관리자 명단과 같은 studentRosterRows(학생 id, 또는 이름+학부모 전화).
 */
export function planStudentReassign(student: ReassignStudent, stops: readonly RegularShuttleStop[]): ReassignPlan {
  const rows = studentRosterRows(stops, { id: student.studentId, name: student.name, parentPhone: student.parentPhone }) as RegularShuttleStop[];
  const enrolled = student.enrolled ?? [];
  // 다니는 반이 하나도 없으면(전부 휴원 또는 수강 없음) 재배정이 아니다. 휴원은 그대로 두고, 수강 없음은 빼기 필요.
  const active = enrolled.filter((c) => c.status !== "PAUSED");

  // ① 옛 칸 — 요일·방향·수업시간 묶음. 시작 시각을 못 읽는 수업시간 글자는 판단하지 않는다(옛 칸 아님).
  const fromMap = new Map<string, ReassignFromCell>();
  const keptCells = new Set<string>(); // 옛 칸이 아닌 행이 있는 (요일|방향)
  for (const r of rows) {
    const direction = r.direction as RosterDirection;
    const start = startMinute(r.classTime);
    const stale = start != null && !hasClassAt(enrolled, r.weekday, start);
    // 휴원만 있는 학생(다니는 반 0, 휴원 1+)은 모든 칸을 그대로 둔다.
    const pausedOnly = active.length === 0 && enrolled.length > 0;
    if (!stale || pausedOnly) { keptCells.add(`${r.weekday}|${direction}`); continue; }
    const key = `${r.weekday}|${direction}|${classTimeKey(r.classTime)}`;
    const cell = fromMap.get(key) ?? {
      weekday: r.weekday, direction, classTime: r.classTime ?? "", rowIds: [],
      stopName: r.stopName, arriveTime: r.arriveTime ?? null,
      latitude: r.latitude ?? null, longitude: r.longitude ?? null,
    };
    if (r.id) cell.rowIds.push(r.id);
    fromMap.set(key, cell);
  }
  const froms = [...fromMap.values()].filter((c) => c.rowIds.length > 0)
    .sort((a, b) => rank(a.weekday) - rank(b.weekday) || a.classTime.localeCompare(b.classTime));

  // ② 새 칸 — 다니는 반의 명단 칸 글자(같은 시작 시각 글자에 맞춤) × 방향, 옛 칸 아닌 행이 없는 칸.
  const slots = enrolledClassSlots(active, stops.map((s) => ({ weekday: s.weekday, classTime: s.classTime })))
    .filter((s: { paused: boolean }) => !s.paused) as { weekday: number; classTime: string; enrolledTime: string }[];
  const tos: ReassignToCell[] = [];
  for (const weekday of [...new Set(slots.map((s) => s.weekday))]) {
    const daySlots = slots.filter((s) => s.weekday === weekday); // 시각 순(enrolledClassSlots 가 정렬)
    for (const direction of ["BOARD", "ALIGHT"] as const) {
      if (keptCells.has(`${weekday}|${direction}`)) continue; // 이미 그 요일·방향을 탄다
      const slot = direction === "BOARD" ? daySlots[0] : daySlots[daySlots.length - 1];
      tos.push({
        weekday, direction, classTime: slot.classTime,
        startTime: slot.enrolledTime.split("~")[0] ?? slot.classTime,
        label: `${WEEKDAY_LABELS[weekday]} ${DIR_KO[direction]}`,
      });
    }
  }
  tos.sort((a, b) => rank(a.weekday) - rank(b.weekday));

  // ③ 같은 방향끼리 짝 — 같은 요일(시각만 바뀐 반) 먼저, 남은 것은 요일 순서대로.
  const pairs: ReassignPair[] = [];
  const removeOnly: ReassignFromCell[] = [];
  for (const direction of ["BOARD", "ALIGHT"] as const) {
    const fs = froms.filter((f) => f.direction === direction);
    const ts = tos.filter((t) => t.direction === direction);
    const usedTo = new Set<ReassignToCell>();
    const matched = new Map<ReassignFromCell, ReassignToCell>();
    for (const f of fs) {
      const same = ts.find((t) => !usedTo.has(t) && t.weekday === f.weekday);
      if (same) { usedTo.add(same); matched.set(f, same); }
    }
    for (const f of fs) {
      if (matched.has(f)) continue;
      const next = ts.find((t) => !usedTo.has(t));
      if (next) { usedTo.add(next); matched.set(f, next); }
    }
    for (const f of fs) {
      const t = matched.get(f);
      if (!t) { removeOnly.push(f); continue; }
      pairs.push({ direction, from: f, to: t, label: reassignLabel(f, t) });
    }
  }
  pairs.sort((a, b) => rank(a.to.weekday) - rank(b.to.weekday) || (a.direction === b.direction ? 0 : a.direction === "BOARD" ? -1 : 1));
  return { pairs, removeOnly };
}

/** «화→목 등원 (반 이동)» / 같은 요일이면 «화 17:00→18:00 등원 (반 이동)». */
export function reassignLabel(from: Pick<ReassignFromCell, "weekday" | "classTime" | "direction">, to: Pick<ReassignToCell, "weekday" | "classTime">): string {
  const dir = DIR_KO[from.direction];
  if (from.weekday === to.weekday) {
    const a = String(from.classTime).split("~")[0];
    const b = String(to.classTime).split("~")[0];
    return `${WEEKDAY_LABELS[from.weekday]} ${a}→${b} ${dir} (반 이동)`;
  }
  return `${WEEKDAY_LABELS[from.weekday]}→${WEEKDAY_LABELS[to.weekday]} ${dir} (반 이동)`;
}
