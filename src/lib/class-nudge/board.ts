// 수업 미처리 장치(2026-11-17) — «사실»에 «지금 시각»을 넣어 화면 자료를 만드는 순수 조립부.
//
// 사실(DB 에서 읽은 것)은 30초 캐시해도 되지만 판정은 매번 새 시각으로 다시 한다 —
// 그래서 캐시된 «시작 전»이 늦게 «미시작»으로 바뀌는 일이 없다.
// ⚠️ prisma·next import 금지, 시계를 읽지 않는다(nowMs 는 인자).
import { kstLabel } from "@/lib/datetime/kst";
import type { ClassDayDbFacts } from "./boardQuery";
import {
  DEFAULT_THRESHOLDS,
  classDayStatus,
  compareClassDayRows,
  lessonWindowMs,
  summarizeClassDay,
  type ClassDayKind,
  type ClassDayStatus,
  type ClassDaySummary,
  type ClassDayThresholds,
} from "./rules";

/** 그날의 사실 전부 — DB 사실 + 휴무 판정. 시계와 무관하다. */
export type ClassDayFacts = ClassDayDbFacts & {
  dateYmd: string;
  /** 연간일정 휴무(정규 수업만 해당). 휴무가 아니거나 모르면 null */
  holiday: { title: string } | null;
  /** 연간일정을 읽었는가 — false 면 휴무 판정 없이 평소대로 보인다(화면에 한 줄 안내, 2단계 알림은 이 표식을 본다) */
  holidayKnown: boolean;
};

export type ClassDayBoardAssignee = {
  name: string;
  /** 그날 대타 */
  substitute: boolean;
  /** 앱 계정이 연결돼 있는가 — false 면 «(앱 미연결)» 꼬리표 */
  linked: boolean;
};

export type ClassDayBoardRow = {
  /** "regular:<classId>" | "seasonal:<sessionDateId>" — 출결 화면이 쓰는 열쇠와 같다 */
  key: string;
  kind: ClassDayKind;
  classId: string;
  name: string;
  startTime: string | null;
  endTime: string | null;
  capacity: number | null;
  rosterCount: number;
  assignees: ClassDayBoardAssignee[];
  status: ClassDayStatus;
  /** 휴강 표시가 있으면(진행 중이라 힘을 잃은 표시도 그대로 싣는다) */
  cancel: { reason: string | null } | null;
  href: string;
};

export type ClassDayBoard = {
  dateYmd: string;
  /** "11/17(화)" */
  todayLabel: string;
  holiday: { title: string } | null;
  holidayKnown: boolean;
  summary: ClassDaySummary;
  rows: ClassDayBoardRow[];
};

/**
 * 줄을 누르면 가는 출결 화면 주소(관리자 화면 세션과 공유하는 형식).
 * 출결 화면이 이 쿼리를 읽어 그 날짜·그 수업을 연다(해석 = src/lib/attendance/lessonQuery.ts — 형식을 바꾸면 그쪽도 같이).
 */
export function classDayHref(dateYmd: string, key: string): string {
  return `/admin/attendance?date=${dateYmd}&lesson=${key}`;
}

function boardAssignees(facts: ClassDayFacts, classId: string): ClassDayBoardAssignee[] {
  const seen = new Set<string>();
  const out: ClassDayBoardAssignee[] = [];
  // 원래 담당 먼저, 대타는 뒤에. 같은 사람이 두 갈래로 나오면 한 번만 보인다
  const mine = facts.assignees
    .filter((a) => a.classId === classId)
    .sort((a, b) => Number(a.role === "SUBSTITUTE") - Number(b.role === "SUBSTITUTE") || a.name.localeCompare(b.name, "ko"));
  for (const a of mine) {
    const id = a.userId ? `u:${a.userId}` : `n:${a.name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ name: a.name, substitute: a.role === "SUBSTITUTE", linked: Boolean(a.userId) });
  }
  return out;
}

/**
 * 사실 + 지금 시각 → 화면 자료. 휴무·대상 없음 줄은 목록에서 빼고(요약에만), 휴강 줄은 «휴강 취소» 버튼이 있어야 해서 남긴다.
 */
export function buildClassDayBoard(
  facts: ClassDayFacts,
  nowMs: number,
  thresholds: ClassDayThresholds = DEFAULT_THRESHOLDS,
): ClassDayBoard {
  type Draft = ClassDayBoardRow & { startMs: number | null };
  const drafts: Draft[] = [];

  for (const fact of facts.regular) {
    const window = lessonWindowMs(facts.dateYmd, fact.startTime, fact.endTime);
    // 정규 휴강 표시는 시작 시각 칸이 '' 인 행이다
    const cancel = facts.cancels.find((c) => c.kind === "REGULAR" && c.classId === fact.classId && c.startTime === "") ?? null;
    const status = classDayStatus({
      kind: "REGULAR",
      startMs: window.startMs,
      endMs: window.endMs,
      nowMs,
      holiday: facts.holiday !== null,
      cancelled: cancel !== null,
      session: fact.sessionStatus ? { status: fact.sessionStatus } : null,
      rosterCount: fact.rosterCount,
      unmarkedCount: fact.unmarkedCount,
    }, thresholds);
    const key = `regular:${fact.classId}`;
    drafts.push({
      key, kind: "REGULAR", classId: fact.classId, name: fact.name,
      startTime: fact.startTime, endTime: fact.endTime, capacity: fact.capacity, rosterCount: fact.rosterCount,
      assignees: boardAssignees(facts, fact.classId),
      status, cancel: cancel ? { reason: cancel.reason } : null,
      href: classDayHref(facts.dateYmd, key), startMs: window.startMs,
    });
  }

  for (const fact of facts.seasonal) {
    // 특강 휴강 표시의 열쇠는 (반, 시작 시각) — 대표 회차 id 는 형제 회차 사이에서 바뀔 수 있다
    const cancel = fact.startTime
      ? facts.cancels.find((c) => c.kind === "SEASONAL" && c.classId === fact.classId && c.startTime === fact.startTime) ?? null
      : null;
    const status = classDayStatus({
      kind: "SEASONAL",
      startMs: fact.startMs,
      endMs: fact.endMs,
      nowMs,
      holiday: false, // 특강 회차는 날짜가 명시된 일정이라 연간일정 휴무를 걸지 않는다
      cancelled: cancel !== null,
      session: fact.sessionStatus ? { status: fact.sessionStatus } : null,
      rosterCount: fact.rosterCount,
      unmarkedCount: fact.unmarkedCount,
    }, thresholds);
    const key = `seasonal:${fact.sessionDateId}`;
    drafts.push({
      key, kind: "SEASONAL", classId: fact.classId, name: fact.name,
      startTime: fact.startTime, endTime: fact.endTime, capacity: null, rosterCount: fact.rosterCount,
      assignees: fact.coachName ? [{ name: fact.coachName, substitute: false, linked: Boolean(fact.coachUserId) }] : [],
      status, cancel: cancel ? { reason: cancel.reason } : null,
      href: classDayHref(facts.dateYmd, key), startMs: fact.startMs,
    });
  }

  const summary = summarizeClassDay(drafts);
  const rows = drafts
    .filter((row) => row.status.state !== "HOLIDAY" && row.status.state !== "NO_STUDENTS")
    .sort(compareClassDayRows)
    // startMs 는 정렬에만 쓴다 — 화면 자료에는 싣지 않는다
    .map((draft): ClassDayBoardRow => {
      const { startMs, ...row } = draft;
      void startMs;
      return row;
    });

  return {
    dateYmd: facts.dateYmd,
    todayLabel: kstLabel(facts.dateYmd),
    holiday: facts.holiday,
    holidayKnown: facts.holidayKnown,
    summary,
    rows,
  };
}
