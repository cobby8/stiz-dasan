// 셔틀 명단 ↔ 수강 등록 점검 — 휴원·퇴원·반 변경 뒤에도 명단에 남은 학생을 찾는다(순수 함수, DB 접근 없음).
// ─────────────────────────────────────────────────────────────────────────────
// 왜 필요한가?
//   휴원·퇴원·반 변경을 해도 정규 셔틀 명단(RegularShuttleStop)은 그대로이고, 매달 다음 달로 그대로 복사된다.
//   그래서 «다니는 반이 없는데 셔틀 명단에 남은 학생», «수업이 없는 요일에 타는 학생»이 계속 이어진다.
//   이 모듈은 그런 학생에게 경고만 붙인다. ⚠️ 자동으로 빼지 않는다 — 판단과 정리는 원장이 한다.
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로 import·enum 을 쓰지 않는다.

// Node 타입 제거 테스트는 확장자가 필요하고, Next 빌드는 같은 파일을 그대로 해석한다(regularRosterCheckLogic.ts 와 같은 방식).
// @ts-expect-error -- TypeScript runtime test compatibility
import { groupRosterDay, WEEKDAY_LABELS, type RosterStopRow } from "./regularRosterEditLogic.ts";

/** 서버가 내려주는 수강 한 줄(학생·요일·상태). 퇴원(WITHDRAWN)은 서버가 아예 보내지 않는다. */
export type RosterEnrollment = { studentId: string; weekday: number; status: "ACTIVE" | "PAUSED" };

export type RosterEnrollmentFlagKind =
  | "NO_ACTIVE_CLASS" // 다니는(ACTIVE) 반이 하나도 없음 = 휴원 중이거나 퇴원·미등록
  | "NO_CLASS_ON_DAY" // 다니는 반은 있지만 그 요일엔 수업이 없음(반 변경 뒤 남은 행이 대표적)
  | "ONE_DIRECTION"; // 그 수업에 등원·하원 중 한쪽만 있음(정상일 수도 있어 «참고»로만 본다)

export type RosterEnrollmentFlag = {
  kind: RosterEnrollmentFlagKind;
  /** 배지 글자(짧게). */
  label: string;
  /** 마우스를 올리거나 목록에서 보이는 설명. */
  detail: string;
};

/** 학생 한 칸(요일·수업시간·학생)의 등·하원 행 — 화면의 RosterStudentEntry 와 같은 모양이면 된다. */
export type RosterEntryLike = {
  studentId: string | null;
  board: unknown | null;
  alight: unknown | null;
};

/** 학생별 수강을 미리 묶어 둔 것(id → 수강 목록). 여러 칸을 볼 때 매번 거르지 않으려고. */
export type RosterEnrollmentIndex = ReadonlyMap<string, readonly RosterEnrollment[]>;

export function indexRosterEnrollments(enrollments: readonly RosterEnrollment[]): Map<string, RosterEnrollment[]> {
  const map = new Map<string, RosterEnrollment[]>();
  for (const e of enrollments) {
    if (!e || typeof e.studentId !== "string" || !e.studentId) continue;
    map.set(e.studentId, [...(map.get(e.studentId) ?? []), e]);
  }
  return map;
}

/**
 * 한 학생의 수강 상태 경고(요일과 무관). 학생 연결(studentId)이 없으면 판단하지 않는다(null).
 * - 다니는 반이 없으면: 휴원 수강이 있으면 «다니는 반 없음(휴원)», 아예 없으면 «다니는 반 없음(퇴원·미등록)».
 */
export function studentEnrollmentFlag(studentId: string | null, index: RosterEnrollmentIndex): RosterEnrollmentFlag | null {
  if (!studentId) return null;
  const list = index.get(studentId) ?? [];
  if (list.some((e) => e.status === "ACTIVE")) return null;
  const paused = list.some((e) => e.status === "PAUSED");
  return paused
    ? { kind: "NO_ACTIVE_CLASS", label: "다니는 반 없음(휴원)", detail: "모든 수업이 휴원 중입니다. 휴원 기간에는 셔틀을 타지 않습니다." }
    : { kind: "NO_ACTIVE_CLASS", label: "다니는 반 없음", detail: "다니는 수업이 없습니다(퇴원했거나 수강 등록이 없음)." };
}

/**
 * 한 칸(요일·수업시간·학생)의 경고 목록. 순서 = 다니는 반 없음 → 수업 없는 요일 → 한쪽만.
 * - 다니는 반이 아예 없으면 «수업 없는 요일»은 붙이지 않는다(같은 원인을 두 번 말하지 않게).
 * - 학생 연결이 없는 행(이름만 등록)은 수강을 알 수 없어 «한쪽만»만 본다.
 */
export function rosterEntryFlags(entry: RosterEntryLike, weekday: number, index: RosterEnrollmentIndex): RosterEnrollmentFlag[] {
  const flags: RosterEnrollmentFlag[] = [];
  const noClass = studentEnrollmentFlag(entry.studentId, index);
  if (noClass) flags.push(noClass);
  else if (entry.studentId) {
    const onDay = (index.get(entry.studentId) ?? []).some((e) => e.status === "ACTIVE" && e.weekday === weekday);
    if (!onDay) {
      const days = activeWeekdays(index.get(entry.studentId) ?? []);
      flags.push({
        kind: "NO_CLASS_ON_DAY",
        label: "수업 없는 요일",
        detail: `${WEEKDAY_LABELS[weekday] ?? "?"}요일에 다니는 수업이 없습니다${days.length ? `(다니는 요일: ${days.map((d) => WEEKDAY_LABELS[d]).join("·")})` : ""}. 반을 옮겼다면 셔틀 명단도 옮겨 주세요.`,
      });
    }
  }
  if (!!entry.board !== !!entry.alight) {
    flags.push(entry.board
      ? { kind: "ONE_DIRECTION", label: "등원만", detail: "이 수업은 등원만 있고 하원이 없습니다. 하원을 직접 데려가는 경우라면 정상입니다." }
      : { kind: "ONE_DIRECTION", label: "하원만", detail: "이 수업은 하원만 있고 등원이 없습니다. 등원을 직접 데려오는 경우라면 정상입니다." });
  }
  return flags;
}

/** 다니는(ACTIVE) 수업 요일 — 월→일 순. */
function activeWeekdays(list: readonly RosterEnrollment[]): number[] {
  const rank = (w: number) => (w === 0 ? 7 : w);
  return [...new Set(list.filter((e) => e.status === "ACTIVE").map((e) => e.weekday))].sort((a, b) => rank(a) - rank(b));
}

/** 한 달 점검 결과의 학생 한 줄. 같은 학생의 여러 칸 경고를 모은다. */
export type RosterEnrollmentStudentReport = {
  key: string;
  studentId: string | null;
  studentName: string;
  /** 경고 종류별 요약(예: «수업 없는 요일 · 월·수»). */
  flags: { kind: RosterEnrollmentFlagKind; label: string; where: string[] }[];
};

export type RosterEnrollmentReport = {
  /** 확인이 필요한 학생(다니는 반 없음·수업 없는 요일). 정리할 대상. */
  problems: RosterEnrollmentStudentReport[];
  /** 참고(한쪽만) — 정상일 수 있어 따로 센다. */
  notes: RosterEnrollmentStudentReport[];
  /** 학생 연결이 없어 수강을 볼 수 없는 학생 수(이름만 등록된 행). */
  unlinkedCount: number;
  /** 종류별 학생 수(요약 한 줄용). */
  counts: Record<RosterEnrollmentFlagKind, number>;
};

/**
 * 한 달 명단 전체를 학생 단위로 점검한다(화면 요약 한 줄 · 월 넘김 확인 목록에 같이 쓴다).
 * 묶음 기준은 명단 화면과 같은 groupRosterDay(요일 → 수업시간 → 학생).
 */
export function buildRosterEnrollmentReport<T extends RosterStopRow>(rows: readonly T[], enrollments: readonly RosterEnrollment[]): RosterEnrollmentReport {
  const index = indexRosterEnrollments(enrollments);
  const byStudent = new Map<string, RosterEnrollmentStudentReport>();
  const unlinked = new Set<string>();
  const order = [1, 2, 3, 4, 5, 6, 0]; // 월→일
  const list = [...rows];
  for (const weekday of order) {
    for (const group of groupRosterDay(list, weekday)) {
      for (const entry of group.students) {
        if (!entry.studentId) unlinked.add(entry.key);
        const flags = rosterEntryFlags(entry, weekday, index);
        if (flags.length === 0) continue;
        const report = byStudent.get(entry.key) ?? { key: entry.key, studentId: entry.studentId, studentName: entry.studentName, flags: [] };
        for (const f of flags) {
          // «다니는 반 없음»은 요일과 무관 → 위치 없이 한 번. 나머지는 「월 17:00~18:00」처럼 칸을 모은다.
          const where = f.kind === "NO_ACTIVE_CLASS" ? "" : `${WEEKDAY_LABELS[weekday]} ${group.classTime || "수업시간 미지정"}`;
          const same = report.flags.find((x) => x.kind === f.kind && x.label === f.label);
          if (same) { if (where && !same.where.includes(where)) same.where.push(where); }
          else report.flags.push({ kind: f.kind, label: f.label, where: where ? [where] : [] });
        }
        byStudent.set(entry.key, report);
      }
    }
  }
  const all = [...byStudent.values()].sort((a, b) => a.studentName.localeCompare(b.studentName, "ko"));
  const isProblem = (r: RosterEnrollmentStudentReport) => r.flags.some((f) => f.kind !== "ONE_DIRECTION");
  const counts: Record<RosterEnrollmentFlagKind, number> = { NO_ACTIVE_CLASS: 0, NO_CLASS_ON_DAY: 0, ONE_DIRECTION: 0 };
  for (const r of all) for (const kind of new Set(r.flags.map((f) => f.kind))) counts[kind] += 1;
  return {
    problems: all.filter(isProblem),
    notes: all.filter((r) => !isProblem(r)),
    unlinkedCount: unlinked.size,
    counts,
  };
}

/** 학생 한 줄을 사람이 읽는 문장으로(「홍길동 — 수업 없는 요일(월 17:00~18:00)」). 확인 창·목록에 쓴다. */
export function describeRosterEnrollmentStudent(r: RosterEnrollmentStudentReport): string {
  return `${r.studentName} — ${r.flags.map((f) => (f.where.length ? `${f.label}(${f.where.join(", ")})` : f.label)).join(" · ")}`;
}

/**
 * 요약 한 줄(「다니는 반 없음 2명 · 수업 없는 요일 3명 · 한쪽만 5명」). 0명 항목은 뺀다. 아무것도 없으면 빈 문자열.
 */
export function summarizeRosterEnrollmentReport(report: RosterEnrollmentReport): string {
  const parts: string[] = [];
  if (report.counts.NO_ACTIVE_CLASS) parts.push(`다니는 반 없음 ${report.counts.NO_ACTIVE_CLASS}명`);
  if (report.counts.NO_CLASS_ON_DAY) parts.push(`수업 없는 요일 ${report.counts.NO_CLASS_ON_DAY}명`);
  if (report.counts.ONE_DIRECTION) parts.push(`한쪽만 ${report.counts.ONE_DIRECTION}명`);
  return parts.join(" · ");
}

/**
 * 월 넘김(명단 복사) 확인 창 문구. 확인할 학생이 없으면 빈 문자열(= 경고 없이 진행).
 * 너무 길면 확인 창이 화면을 넘으므로 앞 limit 명만 적고 나머지는 «외 N명».
 */
export function rosterCopyWarningText(report: RosterEnrollmentReport, limit = 12): string {
  if (report.problems.length === 0) return "";
  const shown = report.problems.slice(0, limit).map((r) => `· ${describeRosterEnrollmentStudent(r)}`);
  const more = report.problems.length > limit ? [`· 외 ${report.problems.length - limit}명`] : [];
  return [
    `확인이 필요한 학생 ${report.problems.length}명이 그대로 복사됩니다(자동으로 빼지 않습니다):`,
    ...shown,
    ...more,
  ].join("\n");
}
