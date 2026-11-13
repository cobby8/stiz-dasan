// 정규 셔틀 «운행표 한 장»을 만드는 순수 조립 함수 — prisma·React 등 서버/화면 의존성 절대 금지.
// ─────────────────────────────────────────────────────────────────────────────
// 왜 따로 떼는가?
//   기사님 화면(서버)과 관리자 운행표(브라우저, 다음 단계)가 **같은 함수**로 운행표를 만들어야
//   «원장이 보는 순서 = 기사님이 보는 순서»가 보장된다. 화면마다 조립을 따로 하면 한쪽만 고쳐진다.
//
// 조립 순서:
//   selectDriverDayRows(그 요일 학생 정차행) → buildFallbackClasses(수업시간별 묶음 · 명단 순서 그대로)
//   → attachAbsenceLabels(결석 뱃지) → attachShuttleDayNotes(«오늘만» 변경) → buildRegularRows(카드 한 줄씩)
//
// 5단계(2026-11-09 원장 결정): 셔틀 명단(RegularShuttleStop)이 유일한 운행 정본이다.
//   저장 노선(RegularDispatchRoute)은 더 읽지 않는다 — 1건(11월 목 등원)은 배포 직전 SQL 로 명단에 흡수한다.
//   명단이 곧 확정 순서이므로 «순서 확인 필요»(pending) 표시도 붙이지 않는다.
// ⚠️ 결석·«오늘만» 판정(이름·전화 매칭)은 호출부가 주입한다 — 이 모듈이 DB·매칭 모듈에 묶이지 않게.

import {
  attachAbsenceLabels,
  attachRiderBlocks,
  buildFallbackClasses,
  attachShuttleDayNotes,
  selectDriverDayRows,
  type AbsentPredicate,
  type DriverClass,
  type ShuttleDayExceptionEntry,
} from "./regularDriverRouteLogic";
import { buildRegularRows, sortUnifiedRows, type UnifiedRow } from "./unifiedDriverRunLogic";
import type { RegularShuttleStop } from "./regularSheet";

/** 결석·«오늘만» 변경을 끈 기본값(관리자 «월+요일» 기본형이 쓸 값). */
const NOBODY_ABSENT: AbsentPredicate = () => false;
const NO_LABEL = () => null;

export type RegularRunInput = {
  /** 그 달 셔틀 명단 전체(요일 고르기는 이 함수가 한다). */
  stops: RegularShuttleStop[];
  /** 0=일 … 6=토 */
  weekday: number;
  /** 그날 결석 판정(없으면 아무도 결석 아님). */
  isAbsent?: AbsentPredicate;
  /** 결석 행의 뱃지 문구(null → «결석»). */
  absentLabelOf?: (row: { name: string | null; phone: string | null }) => string | null;
  /** 그날 «오늘만» 셔틀 변경(없으면 덧붙이지 않음). */
  dayNotes?: {
    exceptions: ShuttleDayExceptionEntry[];
    matches: (row: { name: string | null; phone: string | null }, entry: ShuttleDayExceptionEntry) => boolean;
    describe: (entry: { kind: string; location: string | null }) => string;
  };
  /** 잠긴 줄 뱃지(휴원·퇴원·첫 수업 전·휴무 — regularRunDayRules 판정). 명단 정차행 id → 글자, 없으면 null. */
  blockOf?: (rowId: string) => string | null;
};

/**
 * 그 요일 정규 운행의 섹션 목록(DriverClass[]).
 * 기사님 서버는 이걸 방학특강과 섞어야 하므로(buildUnifiedRun) 섹션 단계 결과도 내보낸다.
 */
export function buildRegularRunClasses(input: RegularRunInput): DriverClass[] {
  const isAbsent = input.isAbsent ?? NOBODY_ABSENT;
  const absentLabelOf = input.absentLabelOf ?? NO_LABEL;

  // 그 요일의 학생 정차행만, 명단 순서(sortOrder) 그대로 — 폴백 화면은 이 순서가 곧 운행 순서다.
  const dayRows = selectDriverDayRows(input.stops, input.weekday);

  // 수업시간 × 등/하원 묶음 — 명단 순서(sortOrder) 그대로. 명단이 정본이라 «확정 전»(pending) 표시는 끈다.
  const classes = buildFallbackClasses(dayRows, isAbsent).map((c) => ({ ...c, pending: false }));

  // 결석 뱃지·«오늘만» 변경은 묶음을 다 만든 뒤 덧붙인다.
  const labeled = attachAbsenceLabels(classes, absentLabelOf);
  // 잠긴 줄(휴원·휴무 등) 뱃지 — 줄은 그대로 두고 표시만 붙인다(없으면 종전 결과와 글자 그대로 같다).
  const blocked = input.blockOf ? attachRiderBlocks(labeled, input.blockOf) : labeled;
  if (!input.dayNotes) return blocked;
  return attachShuttleDayNotes(blocked, input.dayNotes.exceptions, input.dayNotes.matches, input.dayNotes.describe);
}

/**
 * 정규 운행표 카드 목록(UnifiedRow[]) — 기사님 화면과 같은 정렬(시각순, 시간 미정은 맨 뒤).
 * 방학특강이 없는 날 기사님이 보는 목록과 글자 그대로 같다(테스트로 고정).
 */
export function buildRegularRunRows(input: RegularRunInput): UnifiedRow[] {
  return sortUnifiedRows(buildRegularRows(buildRegularRunClasses(input)));
}
