// 셔틀 명단 점검 — 기사님 화면에서 빠지거나 어긋나게 보일 행을 미리 찾아 경고한다(순수 함수, DB 접근 없음).
// ─────────────────────────────────────────────────────────────────────────────
// 왜 필요한가?
//   기사님 화면(폴백)은 명단 행을 그대로 묶어 보여 주므로, 명단의 작은 실수가 운행 화면에 바로 드러난다.
//   2026-10-02 실제 사례: 수요일 하원 행 2건이 '승차(BOARD)'로 잘못 들어가 기사님 화면 하원 칸에서 빠져 있었다.
//   이런 실수를 「셔틀 명단」 화면 상단에서 먼저 보이게 한다. 자동으로 고치지는 않는다(판단은 원장).
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로 import·enum 을 쓰지 않는다.

// Node 타입 제거 테스트는 확장자가 필요하고, Next 빌드는 같은 파일을 그대로 해석한다(dispatchIncrement.ts 와 같은 방식).
// @ts-expect-error -- TypeScript runtime test compatibility
import { rosterStudentKeyResolver, WEEKDAY_LABELS, type RosterStopRow } from "./regularRosterEditLogic.ts";

export type RosterCheckKind =
  | "DUPLICATE_STUDENT" // 같은 요일·수업·방향에 같은 학생 행이 2개 이상
  | "BOARD_AFTER_START" // 등원 시각이 수업 시작보다 늦음(하원 행이 승차로 잘못 들어간 경우가 대표적)
  | "ALIGHT_BEFORE_END" // 하원 시각이 수업 종료보다 이른 경우(등원 행이 하차로 잘못 들어간 경우)
  | "NO_CLASS_TIME" // 수업시간이 비어 기사님 화면에서 아예 빠짐
  | "STOP_TIME_CONFLICT"; // 같은 정류장 이름이 시각이 다르게 두 번 → 기사님 화면에서 하나로 합쳐져 한 시각만 보임

export type RosterCheckIssue = {
  kind: RosterCheckKind;
  weekday: number;
  classTime: string;
  direction: "BOARD" | "ALIGHT";
  message: string;
  rowIds: string[];
};

const DIR_LABEL = { BOARD: "등원", ALIGHT: "하원" } as const;
/** 학생 정차행만 남긴 뒤라 BOARD 가 아니면 ALIGHT 다(타입 좁히기용). */
const dirOf = (d: string): "BOARD" | "ALIGHT" => (d === "BOARD" ? "BOARD" : "ALIGHT");

/** 'HH:MM' → 분. 형식이 아니면 null. */
function toMinutes(v: string | null | undefined): number | null {
  const m = String(v ?? "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]), mm = Number(m[2]);
  return h <= 23 && mm <= 59 ? h * 60 + mm : null;
}

/** 수업시간 '17:00~18:00' → 시작·종료(분). 못 읽으면 null(점검 생략). */
export function parseClassTimeRange(classTime: string | null | undefined): { start: number; end: number } | null {
  const m = String(classTime ?? "").replace(/\s/g, "").match(/^(\d{1,2}:\d{2})[~\-–](\d{1,2}:\d{2})$/);
  if (!m) return null;
  const start = toMinutes(m[1]), end = toMinutes(m[2]);
  return start != null && end != null ? { start, end } : null;
}

/**
 * 한 달 명단 전체를 점검한다. 학생 정차행(BOARD/ALIGHT, 학생 이름 있음)만 본다.
 * 결과는 요일(월→일) · 수업시간 · 방향 순으로 정렬해 돌려준다.
 */
export function checkRosterRows<T extends RosterStopRow>(rows: readonly T[]): RosterCheckIssue[] {
  const student = rows.filter((r) => !!r.studentName && (r.direction === "BOARD" || r.direction === "ALIGHT"));
  const keyOf = rosterStudentKeyResolver(student); // 셔틀 명단 화면이 학생을 묶는 기준과 같다
  const issues: RosterCheckIssue[] = [];
  const idsOf = (list: readonly T[]) => list.map((r) => r.id).filter((id): id is string => !!id);
  const wd = (w: number) => `${WEEKDAY_LABELS[w] ?? "?"}요일`;

  // 1) 수업시간이 비어 기사님 화면에서 빠지는 행 — 요일·방향별로 묶어 한 줄씩.
  const noClass = new Map<string, T[]>();
  for (const r of student) {
    if ((r.classTime ?? "").trim()) continue;
    const k = `${r.weekday}|${r.direction}`;
    noClass.set(k, [...(noClass.get(k) ?? []), r]);
  }
  for (const list of noClass.values()) {
    const r0 = list[0];
    const dir0 = dirOf(r0.direction);
    issues.push({
      kind: "NO_CLASS_TIME", weekday: r0.weekday, classTime: "", direction: dir0,
      message: `${wd(r0.weekday)} ${DIR_LABEL[dir0]} — 수업시간이 비어 기사님 화면에 안 나옵니다: ${list.map((r) => r.studentName).join(", ")}`,
      rowIds: idsOf(list),
    });
  }

  // 요일·수업·방향 칸별로 나머지를 점검한다(수업시간 있는 행만 = 기사님 화면에 나오는 행).
  const cells = new Map<string, T[]>();
  for (const r of student) {
    const ct = (r.classTime ?? "").trim();
    if (!ct) continue;
    const k = `${r.weekday}|${ct}|${r.direction}`;
    cells.set(k, [...(cells.get(k) ?? []), r]);
  }
  for (const list of cells.values()) {
    const weekday = list[0].weekday;
    const direction = dirOf(list[0].direction);
    const classTime = (list[0].classTime ?? "").trim();
    const where = `${wd(weekday)} ${classTime} ${DIR_LABEL[direction]}`;

    // 2) 같은 학생 행이 2개 이상
    const byStudent = new Map<string, T[]>();
    for (const r of list) byStudent.set(keyOf(r), [...(byStudent.get(keyOf(r)) ?? []), r]);
    for (const dup of byStudent.values()) {
      if (dup.length < 2) continue;
      issues.push({
        kind: "DUPLICATE_STUDENT", weekday, classTime, direction,
        message: `${where} — ${dup[0].studentName} 학생 행이 ${dup.length}개입니다(기사님 화면에 ${dup.length}번 나옵니다).`,
        rowIds: idsOf(dup),
      });
    }

    // 3) 시각이 수업시간과 맞지 않는 행(등원이 수업 시작보다 늦음 / 하원이 수업 종료보다 이른 경우).
    //    같은 시각(정각)은 경고하지 않는다 — 시각 표기 관행에 따라 정상일 수 있어 오탐을 줄인다.
    const range = parseClassTimeRange(classTime);
    if (range) {
      const off = list.filter((r) => {
        const t = toMinutes(r.arriveTime);
        if (t == null) return false;
        return direction === "BOARD" ? t > range.start : t < range.end;
      });
      if (off.length > 0) {
        const kind: RosterCheckKind = direction === "BOARD" ? "BOARD_AFTER_START" : "ALIGHT_BEFORE_END";
        const why = direction === "BOARD" ? "등원 시각이 수업 시작보다 늦습니다" : "하원 시각이 수업 종료보다 이릅니다";
        issues.push({
          kind, weekday, classTime, direction,
          message: `${where} — ${why}(방향이 잘못 들어갔을 수 있습니다): ${off.map((r) => `${r.studentName} ${r.arriveTime}`).join(", ")}`,
          rowIds: idsOf(off),
        });
      }
    }

    // 4) 같은 정류장 이름인데 시각이 다른 행 — 기사님 화면은 정류장 이름(그대로)으로 묶어 첫 시각 하나만 보여 준다.
    const byStop = new Map<string, T[]>();
    for (const r of list) byStop.set(r.stopName, [...(byStop.get(r.stopName) ?? []), r]);
    for (const [stopName, same] of byStop) {
      const times = [...new Set(same.map((r) => (r.arriveTime ?? "").trim()).filter(Boolean))];
      if (times.length < 2) continue;
      issues.push({
        kind: "STOP_TIME_CONFLICT", weekday, classTime, direction,
        message: `${where} — 「${stopName}」 시각이 ${times.join(" / ")} 로 다릅니다. 기사님 화면에는 한 정차로 합쳐져 한 시각만 보입니다.`,
        rowIds: idsOf(same),
      });
    }
  }

  // 월→일, 수업시간, 등원→하원 순.
  const dayRank = (w: number) => (w === 0 ? 7 : w);
  return issues.sort((a, b) => dayRank(a.weekday) - dayRank(b.weekday)
    || (a.classTime === "" ? 1 : b.classTime === "" ? -1 : a.classTime.localeCompare(b.classTime))
    || (a.direction === b.direction ? 0 : a.direction === "BOARD" ? -1 : 1));
}
