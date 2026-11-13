// 정규 셔틀 «확정 승/하차 시각»을 셔틀 명단(RegularShuttleStop) 행에서 만드는 순수 로직 — prisma·서버 의존성 금지.
// ─────────────────────────────────────────────────────────────────────────────
// 왜 명단인가(6단계, 2026-11-09):
//   기사님 화면은 이미 명단만 읽고 관리자도 명단을 직접 고친다(5단계). 학부모 화면만 옛 저장 노선
//   (RegularDispatchRoute)을 읽으면, 명단을 고쳐도 학부모에게 옛 시각이 보인다 → 같은 정본(명단)을 본다.
// 규칙:
//   - 등원(BOARD) 행의 arriveTime → «HH:MM 승차», 하원(ALIGHT) 행의 arriveTime → «HH:MM 하차».
//     (저장 노선 시절 라벨 모양과 글자 그대로 같다 — 학부모 화면 문구 유지)
//   - 시각이 비었거나 HH:MM 이 아니면 null(미정). 같은 학생·요일·방향이 여러 행이면 명단 순서상 첫 행.
//   - 학생이 실제로 다니는 요일만 반영한다(요청한 쌍에 없는 요일 행은 무시 — 요일 오염 방지).

export type ConfirmedRosterEta = { pickupEtaLabel: string | null; dropoffEtaLabel: string | null };

/** 명단 행 중 시각 계산에 필요한 칸만. */
export type RosterEtaRow = {
  studentId: string | null;
  weekday: number;
  direction: string;
  arriveTime: string | null;
  sortOrder?: number | null;
};

// 요일 문자열(Class.dayOfWeek) ↔ 명단 weekday(0=일 … 6=토).
const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Class.dayOfWeek 를 명단 weekday 로. 모르는 값이면 -1. */
export function dowToRosterWeekday(dayOfWeek: string): number {
  return DOW.indexOf(String(dayOfWeek ?? "").trim());
}

/** 학부모 화면 맵 키 — `${studentId}::${dayOfWeek}::${serviceMonth}` (저장 노선 시절과 같은 모양). */
export function regularEtaKey(studentId: string, dayOfWeek: string, serviceMonth?: string): string {
  return `${studentId}::${dayOfWeek}${serviceMonth ? `::${serviceMonth}` : ""}`;
}

// «8:05»·«08:05» → «08:05». 형식이 아니면 null.
// 학부모 «아이 기록» 셔틀 칸(childShuttleRules)도 이 함수로 시각을 정리한다 — 같은 명단 칸을 두 방식으로 읽지 않게.
export function hhmm(value: string | null | undefined): string | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(String(value ?? ""));
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/**
 * (학생 × 요일) 쌍마다 확정 승/하차 시각 라벨을 만든다. 쌍은 모두 결과에 들어간다(없으면 둘 다 null).
 * rows 는 그 달 명단 행(다른 학생 행이 섞여 있어도 된다 — 여기서 걸러낸다).
 */
export function buildRosterEtas(
  pairs: readonly { studentId: string; dayOfWeek: string }[],
  rows: readonly RosterEtaRow[],
  serviceMonth: string,
): Map<string, ConfirmedRosterEta> {
  const result = new Map<string, ConfirmedRosterEta>();
  for (const p of pairs) {
    if (!p.studentId || dowToRosterWeekday(p.dayOfWeek) < 0) continue;
    result.set(regularEtaKey(p.studentId, p.dayOfWeek, serviceMonth), { pickupEtaLabel: null, dropoffEtaLabel: null });
  }
  // 명단 순서(sortOrder) 그대로 훑어 «첫 행»이 이기게 한다. 원본 배열은 건드리지 않는다.
  const ordered = [...rows].sort((a, b) => (Number(a.sortOrder) || 0) - (Number(b.sortOrder) || 0));
  for (const row of ordered) {
    if (!row.studentId || (row.direction !== "BOARD" && row.direction !== "ALIGHT")) continue;
    const dayOfWeek = DOW[row.weekday];
    if (!dayOfWeek) continue;
    const cur = result.get(regularEtaKey(row.studentId, dayOfWeek, serviceMonth));
    if (!cur) continue; // 요청하지 않은 학생·요일
    const time = hhmm(row.arriveTime);
    if (!time) continue;
    if (row.direction === "BOARD" && cur.pickupEtaLabel == null) cur.pickupEtaLabel = `${time} 승차`;
    if (row.direction === "ALIGHT" && cur.dropoffEtaLabel == null) cur.dropoffEtaLabel = `${time} 하차`;
  }
  return result;
}
