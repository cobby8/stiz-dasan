// 정규 셔틀 «운행표 한 장»을 만드는 순수 조립 함수 — prisma·React 등 서버/화면 의존성 절대 금지.
// ─────────────────────────────────────────────────────────────────────────────
// 왜 따로 떼는가?
//   기사님 화면(서버)과 관리자 운행표(브라우저, 다음 단계)가 **같은 함수**로 운행표를 만들어야
//   «원장이 보는 순서 = 기사님이 보는 순서»가 보장된다. 화면마다 조립을 따로 하면 한쪽만 고쳐진다.
//
// 조립 순서(종전 기사님 서버 코드 getRegularDriverClasses 와 글자 그대로 같은 순서):
//   selectDriverDayRows(그 요일 학생 정차행) → assembleRegularDriverClasses(수업시간별 묶음 · 저장 노선 우선)
//   → attachAbsenceLabels(결석 뱃지) → attachShuttleDayNotes(«오늘만» 변경) → buildRegularRows(카드 한 줄씩)
//
// ⚠️ 1단계(리팩터)에서는 저장 노선(saved) 우선 동작을 **그대로** 유지한다(기사님 화면 무변화).
//    저장 노선 입력을 없애는 것은 설계 5단계 일이다.
// ⚠️ 결석·«오늘만» 판정(이름·전화 매칭)은 호출부가 주입한다 — 이 모듈이 DB·매칭 모듈에 묶이지 않게.

import {
  assembleRegularDriverClasses,
  attachAbsenceLabels,
  attachShuttleDayNotes,
  selectDriverDayRows,
  type AbsentPredicate,
  type DriverClass,
  type RouteDirection,
  type ShuttleDayExceptionEntry,
} from "./regularDriverRouteLogic";
import { buildRegularRows, sortUnifiedRows, type UnifiedRow } from "./unifiedDriverRunLogic";
import type { RegularShuttleStop } from "./regularSheet";

/** 결석·저장 노선·«오늘만» 변경을 끈 기본값(관리자 «월+요일» 기본형이 쓸 값). */
const NOBODY_ABSENT: AbsentPredicate = () => false;
const NO_LABEL = () => null;
const EMPTY_IDS = new Map<string, string[]>();

export type RegularRunInput = {
  /** 그 달 셔틀 명단 전체(요일 고르기는 이 함수가 한다). */
  stops: RegularShuttleStop[];
  /** 0=일 … 6=토 */
  weekday: number;
  /** 그날 결석 판정(없으면 아무도 결석 아님). */
  isAbsent?: AbsentPredicate;
  /** 결석 행의 뱃지 문구(null → «결석»). */
  absentLabelOf?: (row: { name: string | null; phone: string | null }) => string | null;
  /** 요일·방향별 저장 노선(1단계 보존용 — 없으면 명단 그대로). */
  saved?: Record<RouteDirection, { vehicles?: unknown } | null>;
  /** 저장 노선 학생(studentId) → 명단 정차행 id(탑승 체크 키) 다리. */
  rowIdsByStudentId?: Record<RouteDirection, Map<string, string[]>>;
  /** 그날 «오늘만» 셔틀 변경(없으면 덧붙이지 않음). */
  dayNotes?: {
    exceptions: ShuttleDayExceptionEntry[];
    matches: (row: { name: string | null; phone: string | null }, entry: ShuttleDayExceptionEntry) => boolean;
    describe: (entry: { kind: string; location: string | null }) => string;
  };
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

  const classes = assembleRegularDriverClasses({
    dayRows,
    isAbsent,
    saved: input.saved ?? { PICKUP: null, DROPOFF: null },
    rowIdsByStudentId: input.rowIdsByStudentId ?? { PICKUP: EMPTY_IDS, DROPOFF: EMPTY_IDS },
  });

  // 결석 뱃지·«오늘만» 변경은 묶음을 다 만든 뒤 덧붙인다(저장 노선·폴백 두 경로에 똑같이 적용되도록).
  const labeled = attachAbsenceLabels(classes, absentLabelOf);
  if (!input.dayNotes) return labeled;
  return attachShuttleDayNotes(labeled, input.dayNotes.exceptions, input.dayNotes.matches, input.dayNotes.describe);
}

/**
 * 정규 운행표 카드 목록(UnifiedRow[]) — 기사님 화면과 같은 정렬(시각순, 시간 미정은 맨 뒤).
 * 방학특강이 없는 날 기사님이 보는 목록과 글자 그대로 같다(테스트로 고정).
 */
export function buildRegularRunRows(input: RegularRunInput): UnifiedRow[] {
  return sortUnifiedRows(buildRegularRows(buildRegularRunClasses(input)));
}
