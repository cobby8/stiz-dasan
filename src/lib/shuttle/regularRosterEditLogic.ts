// 셔틀 명단(RegularShuttleStop) 앱 편집 — 입력 검증·행 생성 규칙(순수 함수, DB 접근 없음).
// 서버(regularRosterEdit.ts)와 화면(RegularShuttleClient)이 같은 규칙을 쓰고, node --test 로 고정한다.
// ⚠️ node 타입 제거 실행으로 테스트하므로 '@/' 경로 import·enum 을 쓰지 않는다.

export type RosterDirection = "BOARD" | "ALIGHT";

export const WEEKDAY_LABELS = ["일", "월", "화", "수", "목", "금", "토"] as const;
export const DIRECTION_LABEL: Record<RosterDirection, string> = { BOARD: "등원", ALIGHT: "하원" };

/** 사용자에게 그대로 보여줄 입력 오류(한국어). API 가 400 으로 돌려준다. */
export class RosterInputError extends Error {}

export type RosterStopInput = {
  stopName: string;
  arriveTime: string | null;
  latitude: number | null;
  longitude: number | null;
};

/**
 * 편집 적용 범위. 명단은 달별 스냅샷이라 이번 달을 고쳐도 이미 만들어진 다음 달엔 남는다.
 * - FROM_THIS_MONTH(기본): 이 달 + 이후 이미 만들어진 달 모두
 * - THIS_MONTH: 이 달만
 */
export type RosterScope = "THIS_MONTH" | "FROM_THIS_MONTH";

/** 학생 추가의 수업 한 칸 — 요일마다 수업시간이 다를 수 있어(월 17시·수 18시) 요일과 수업시간을 짝으로 받는다. */
export type RosterClassSlot = { weekday: number; classTime: string };

/**
 * 새 행을 운행 순서 어디에 넣을지(요일·수업·방향 칸마다 하나).
 * - END   : 그 칸 맨 뒤(예전 동작)
 * - BEFORE: rowId 행(그 칸 어떤 정차의 첫 행) 바로 앞 — 기사님 화면에서 그 정차 앞에 새 정차가 생긴다
 * - JOIN  : rowId 행의 정차에 합류 — 그 행과 같은 정류장 이름·좌표·시각을 쓰고 바로 뒤 순서
 */
export type RosterPlacementMode = "END" | "BEFORE" | "JOIN";
export type RosterPlacementInput = {
  weekday: number;
  classTime: string;
  direction: RosterDirection;
  mode: RosterPlacementMode;
  rowId: string | null;
  /** 이 칸 새 행의 시각. undefined = 정류장 입력값의 시각을 그대로(합류는 늘 대상 정차 시각). */
  arriveTime?: string | null;
  /** 이후 달에서 기준 행을 못 찾아 맨 뒤로 바뀐 경우(결과 표시용, 서버 내부에서만 채운다). */
  fellBack?: boolean;
  /** 맨 뒤로 바뀐 합류의 정류장 값(이 달 합류 대상 정차) — 그 달에서도 같은 정류장으로 넣는다. */
  fallbackStop?: RosterStopInput;
};

export type RosterAddInput = {
  serviceMonth: string;
  scope?: RosterScope;
  studentId: string | null;
  studentName: string;
  weekdays: number[];
  classTime: string;
  /** 요일·수업시간 짝. 없으면 weekdays × classTime 으로 본다(예전 요청 형식). */
  slots?: RosterClassSlot[];
  /** 칸별 삽입 위치. 없는 칸은 맨 뒤(END). */
  placements?: RosterPlacementInput[];
  board: RosterStopInput | null; // null = 등원 셔틀 안 탐
  alight: RosterStopInput | null; // null = 하원 셔틀 안 탐
};

/** 편집 판단에 필요한 기존 행 정보(그 달 전체). */
export type RosterExistingRow = {
  id: string;
  weekday: number;
  direction: string;
  classTime: string | null;
  sortOrder: number;
  studentId: string | null;
  studentName: string | null;
  /** 반이동 시 "같은 학생" 판정용(studentId 없는 이름만 등록 행). 없으면 빈 값으로 본다. */
  parentPhone?: string | null;
};

export type RosterNewRow = {
  weekday: number;
  classTime: string;
  direction: RosterDirection;
  stopName: string;
  arriveTime: string | null;
  latitude: number | null;
  longitude: number | null;
  sortOrder: number;
};

const MAX_IDS = 100;

function obj(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new RosterInputError("요청 형식이 올바르지 않습니다.");
  return raw as Record<string, unknown>;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export function normalizeRosterMonth(v: unknown): string {
  const month = text(v);
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw new RosterInputError("월은 YYYY-MM 형식이어야 합니다.");
  return month;
}

/** 'YYYY-MM' 다음 달. Date 를 쓰지 않고 문자열 계산만 한다(시간대 무관). */
export function nextServiceMonth(month: string): string {
  const [y, m] = normalizeRosterMonth(month).split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

/** 적용 범위 — 비어 있으면 기본값 FROM_THIS_MONTH(이후 달까지). 그 외 값은 거부한다. */
export function normalizeRosterScope(v: unknown): RosterScope {
  if (v == null || v === "") return "FROM_THIS_MONTH";
  if (v === "THIS_MONTH" || v === "FROM_THIS_MONTH") return v;
  throw new RosterInputError("적용 범위가 올바르지 않습니다.");
}

/**
 * 월 자동 생성 계획 — 이번 달과 다음 달이 항상 있게 한다.
 * 없는 달은 그 달 직전의 가장 최근 달을 복사한다(앞 단계에서 만든 달도 원본이 될 수 있다: 09→10, 10→11).
 * 명단이 아예 없거나 직전 달이 없으면 그 달은 만들지 않는다.
 */
export function planEnsureMonths(existing: readonly string[], currentMonth: string): { sourceMonth: string; targetMonth: string }[] {
  const isMonth = (m: unknown): m is string => typeof m === "string" && /^20\d{2}-(0[1-9]|1[0-2])$/.test(m);
  const have = new Set(existing.filter(isMonth));
  const steps: { sourceMonth: string; targetMonth: string }[] = [];
  for (const target of [currentMonth, nextServiceMonth(currentMonth)]) {
    if (have.has(target)) continue; // 이미 있으면 손대지 않는다(멱등)
    // 'YYYY-MM' 은 사전순 = 시간순이라 문자열 비교로 직전 달을 고른다.
    const source = [...have].filter((m) => m < target).sort().pop();
    if (!source) continue;
    steps.push({ sourceMonth: source, targetMonth: target });
    have.add(target);
  }
  return steps;
}

/** 'YYYY-MM' 목록 → "10월·11월" (저장 결과 문구용). */
export function formatRosterMonths(months: readonly string[]): string {
  return months.map((m) => `${Number(m.slice(5, 7))}월`).join("·");
}

export function normalizeWeekday(v: unknown): number {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > 6) throw new RosterInputError("요일이 올바르지 않습니다.");
  return n;
}

/** 요일 여러 개 → 중복 제거·정렬. 하나 이상 필요. */
export function normalizeWeekdays(v: unknown): number[] {
  if (!Array.isArray(v) || v.length === 0) throw new RosterInputError("요일을 하나 이상 선택해 주세요.");
  return [...new Set(v.map(normalizeWeekday))].sort((a, b) => a - b);
}

/** 수업시간 텍스트('17:00~18:00'). 기존 명단과 같은 글자여야 같은 수업으로 묶이므로 공백만 정리한다. */
export function normalizeClassTime(v: unknown): string {
  const t = text(v).replace(/\s*~\s*/g, "~").replace(/\s+/g, " ");
  if (!t) throw new RosterInputError("수업시간을 입력해 주세요.");
  if (t.length > 40) throw new RosterInputError("수업시간이 너무 깁니다.");
  return t;
}

/** 도착 예정시각. 비우면 null, 있으면 'HH:MM' 으로 맞춘다. */
export function normalizeArriveTime(v: unknown): string | null {
  const t = text(v);
  if (!t) return null;
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new RosterInputError("도착시각은 17:05 처럼 입력해 주세요.");
  return `${m[1].padStart(2, "0")}:${m[2]}`;
}

/** 좌표는 둘 다 있거나 둘 다 없어야 한다. 한국 범위를 벗어나면 잘못 찍은 것으로 본다. */
export function normalizeCoords(lat: unknown, lng: unknown): { latitude: number | null; longitude: number | null } {
  const empty = (x: unknown) => x == null || x === "";
  if (empty(lat) && empty(lng)) return { latitude: null, longitude: null };
  const la = Number(lat), lo = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(lo) || la < 33 || la > 39 || lo < 124 || lo > 132) {
    throw new RosterInputError("정류장 좌표가 올바르지 않습니다. 지도에서 다시 지정해 주세요.");
  }
  return { latitude: la, longitude: lo };
}

export function normalizeStopInput(raw: unknown, label = "정류장"): RosterStopInput {
  const o = obj(raw);
  const stopName = text(o.stopName);
  if (!stopName) throw new RosterInputError(`${label} 이름을 입력해 주세요.`);
  if (stopName.length > 100) throw new RosterInputError(`${label} 이름이 너무 깁니다.`);
  return { stopName, arriveTime: normalizeArriveTime(o.arriveTime), ...normalizeCoords(o.latitude, o.longitude) };
}

export function validateAddInput(raw: unknown): RosterAddInput {
  const o = obj(raw);
  const studentId = text(o.studentId) || null;
  const studentName = text(o.studentName);
  if (!studentId && !studentName) throw new RosterInputError("학생을 선택하거나 이름을 입력해 주세요.");
  if (studentName.length > 40) throw new RosterInputError("학생 이름이 너무 깁니다.");
  const board = o.board == null ? null : normalizeStopInput(o.board, "등원 정류장");
  const alight = o.alight == null ? null : normalizeStopInput(o.alight, "하원 정류장");
  if (!board && !alight) throw new RosterInputError("등원·하원 중 하나 이상 선택해 주세요.");
  // 새 형식(slots: 요일별 수업시간)이 오면 그것을, 아니면 예전 형식(요일 여러 개 × 수업시간 하나)을 쓴다.
  let slots: RosterClassSlot[];
  if (o.slots != null) {
    slots = normalizeClassSlots(o.slots);
  } else {
    const weekdays = normalizeWeekdays(o.weekdays);
    const classTime = normalizeClassTime(o.classTime);
    slots = weekdays.map((weekday) => ({ weekday, classTime }));
  }
  const directions: RosterDirection[] = [...(board ? ["BOARD" as const] : []), ...(alight ? ["ALIGHT" as const] : [])];
  return {
    serviceMonth: normalizeRosterMonth(o.serviceMonth),
    scope: normalizeRosterScope(o.scope),
    studentId,
    studentName,
    weekdays: [...new Set(slots.map((s) => s.weekday))].sort((a, b) => a - b),
    classTime: slots[0].classTime,
    slots,
    placements: normalizePlacements(o.placements, slots, directions),
    board,
    alight,
  };
}

const MAX_SLOTS = 14;

/** 수업 칸 목록 — 중복 제거, 요일·수업시간 순 정렬. 하나 이상 필요. */
export function normalizeClassSlots(v: unknown): RosterClassSlot[] {
  if (!Array.isArray(v) || v.length === 0) throw new RosterInputError("수업(요일·수업시간)을 하나 이상 선택해 주세요.");
  if (v.length > MAX_SLOTS) throw new RosterInputError("수업이 너무 많습니다.");
  const seen = new Set<string>();
  const out: RosterClassSlot[] = [];
  for (const raw of v) {
    const so = obj(raw);
    const slot = { weekday: normalizeWeekday(so.weekday), classTime: normalizeClassTime(so.classTime) };
    const key = `${slot.weekday}|${slot.classTime}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }
  return out.sort((a, b) => a.weekday - b.weekday || a.classTime.localeCompare(b.classTime));
}

/** 공백만 다른 수업시간('17:00 ~ 18:00' vs '17:00~18:00')을 같은 수업으로 보기 위한 비교값(오류 없이). */
export function classTimeKey(v: string | null | undefined): string {
  return String(v ?? "").trim().replace(/\s*~\s*/g, "~").replace(/\s+/g, " ");
}

/** 칸 식별키(요일·수업·방향). 화면과 서버가 같은 키로 삽입 위치를 맞춘다. */
export function placementKey(weekday: number, classTime: string, direction: string): string {
  return `${weekday}|${classTimeKey(classTime)}|${direction}`;
}

/**
 * 삽입 위치 목록 검증. 각 항목은 고른 수업 칸·방향 중 하나여야 하고 칸마다 하나만.
 * BEFORE·JOIN 은 기준 행 id 가 필요하다(행이 실제로 그 칸에 있는지는 planRosterInsert 가 DB 행으로 확인).
 */
export function normalizePlacements(v: unknown, slots: readonly RosterClassSlot[], directions: readonly RosterDirection[]): RosterPlacementInput[] {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new RosterInputError("넣을 위치 형식이 올바르지 않습니다.");
  if (v.length > MAX_SLOTS * 2) throw new RosterInputError("넣을 위치가 너무 많습니다.");
  const allowed = new Set(slots.flatMap((s) => directions.map((d) => placementKey(s.weekday, s.classTime, d))));
  const seen = new Set<string>();
  return v.map((raw) => {
    const po = obj(raw);
    const weekday = normalizeWeekday(po.weekday);
    const classTime = normalizeClassTime(po.classTime);
    const direction = po.direction === "BOARD" || po.direction === "ALIGHT" ? po.direction : null;
    if (!direction) throw new RosterInputError("넣을 위치의 방향이 올바르지 않습니다.");
    const mode = po.mode === "END" || po.mode === "BEFORE" || po.mode === "JOIN" ? po.mode : null;
    if (!mode) throw new RosterInputError("넣을 위치 방식이 올바르지 않습니다.");
    const key = placementKey(weekday, classTime, direction);
    if (!allowed.has(key)) throw new RosterInputError("고르지 않은 수업·방향의 넣을 위치가 있습니다. 화면을 새로고침해 주세요.");
    if (seen.has(key)) throw new RosterInputError("같은 수업·방향의 넣을 위치가 두 번 들어 있습니다.");
    seen.add(key);
    const rowId = text(po.rowId) || null;
    if (mode !== "END" && !rowId) throw new RosterInputError("넣을 위치의 기준 정차가 없습니다. 운행표에서 다시 골라 주세요.");
    const out: RosterPlacementInput = { weekday, classTime, direction, mode, rowId: mode === "END" ? null : rowId };
    // 합류는 시각을 받지 않는다 — 서버가 대상 정차 시각을 그대로 복사한다(옛 비정형 시각 때문에 저장이 막히지 않게).
    if (mode !== "JOIN" && "arriveTime" in po) out.arriveTime = normalizeArriveTime(po.arriveTime);
    return out;
  });
}

/** 행 id 목록(삭제·반이동 대상). 중복 제거, 비어 있거나 너무 많으면 거부. */
export function normalizeIds(v: unknown): string[] {
  if (!Array.isArray(v)) throw new RosterInputError("대상 행이 없습니다.");
  const ids = [...new Set(v.map(text).filter(Boolean))];
  if (ids.length === 0) throw new RosterInputError("대상 행이 없습니다.");
  if (ids.length > MAX_IDS) throw new RosterInputError("한 번에 처리할 수 있는 행이 너무 많습니다.");
  return ids;
}

export function validateRemoveInput(raw: unknown): { serviceMonth: string; ids: string[]; scope: RosterScope } {
  const o = obj(raw);
  return { serviceMonth: normalizeRosterMonth(o.serviceMonth), ids: normalizeIds(o.ids), scope: normalizeRosterScope(o.scope) };
}

export function validateMoveInput(raw: unknown): { serviceMonth: string; ids: string[]; weekday: number; classTime: string; scope: RosterScope } {
  const o = obj(raw);
  return {
    serviceMonth: normalizeRosterMonth(o.serviceMonth),
    scope: normalizeRosterScope(o.scope),
    ids: normalizeIds(o.ids),
    weekday: normalizeWeekday(o.weekday),
    classTime: normalizeClassTime(o.classTime),
  };
}

export function validateStopEditInput(raw: unknown): { serviceMonth: string; id: string; stop: RosterStopInput; applyToAll: boolean; scope: RosterScope } {
  const o = obj(raw);
  const id = text(o.id);
  if (!id) throw new RosterInputError("대상 행이 없습니다.");
  return { serviceMonth: normalizeRosterMonth(o.serviceMonth), id, stop: normalizeStopInput(o.stop), applyToAll: o.applyToAll === true, scope: normalizeRosterScope(o.scope) };
}

export function validateCopyInput(raw: unknown): { sourceMonth: string; targetMonth: string } {
  const o = obj(raw);
  const sourceMonth = normalizeRosterMonth(o.sourceMonth);
  const targetMonth = normalizeRosterMonth(o.targetMonth);
  if (sourceMonth === targetMonth) throw new RosterInputError("원본 월과 대상 월이 같습니다.");
  return { sourceMonth, targetMonth };
}

function normName(v: string | null | undefined): string {
  return String(v ?? "").replace(/\s/g, "").toLowerCase();
}

/** 학부모 전화 끝 4자리(숫자만). 없으면 빈 값. */
function phoneTail(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "").slice(-4);
}

/** 같은 학생의 행인지. studentId 가 있으면 id 로, 없으면(이름만 등록) 이름으로 비교한다. */
export function isSameStudent(row: Pick<RosterExistingRow, "studentId" | "studentName">, studentId: string | null, studentName: string | null): boolean {
  if (studentId) return row.studentId === studentId;
  return !row.studentId && normName(row.studentName) !== "" && normName(row.studentName) === normName(studentName);
}

/**
 * 새 행의 정렬순서 — 그 요일·방향·수업의 마지막 뒤. 그 묶음이 없으면 그 요일 맨 뒤.
 * (가져오기 시 sortOrder 는 요일 안의 시간순 번호다. 뒤 행과 번호가 겹칠 수 있으나 정렬만 동률일 뿐 무해하다.)
 */
export function nextSortOrder(rows: RosterExistingRow[], weekday: number, direction: string, classTime: string): number {
  const day = rows.filter((r) => r.weekday === weekday);
  const group = day.filter((r) => r.direction === direction && (r.classTime ?? "") === classTime);
  const base = group.length > 0 ? group : day;
  return base.length > 0 ? Math.max(...base.map((r) => r.sortOrder)) + 1 : 0;
}

/**
 * 학생 추가 → 생성할 행 목록. 같은 요일·방향·수업에 이미 있으면 중복으로 거부한다.
 * skipDuplicates=true(이후 달에 함께 추가할 때)면 거부 대신 그 행만 건너뛴다.
 */
export function buildAddRows(
  input: RosterAddInput,
  existing: RosterExistingRow[],
  studentName: string,
  opts: { skipDuplicates?: boolean } = {},
): RosterNewRow[] {
  const work: RosterExistingRow[] = [...existing];
  const out: RosterNewRow[] = [];
  // weekdays 는 slots 의 요일 목록이다 — 요일만 바꿔 넘긴 호출({ ...input, weekdays: [1] })도 그대로 따르게 한 번 거른다.
  const slots = (input.slots ?? input.weekdays.map((weekday) => ({ weekday, classTime: input.classTime })))
    .filter((s) => input.weekdays.includes(s.weekday));
  for (const slot of slots) {
    const { weekday } = slot;
    // 그 요일 명단에 공백만 다른 같은 수업시간('17:00 ~ 18:00')이 있으면 그 글자를 그대로 쓴다.
    // 기사님 화면은 수업시간 글자가 같은 행끼리 한 섹션으로 묶으므로, 글자가 다르면 새 학생만 다른 섹션에 뜬다.
    const classTime = existingClassTimeVariant(work, weekday, slot.classTime);
    for (const [direction, stop] of [["BOARD", input.board], ["ALIGHT", input.alight]] as const) {
      if (!stop) continue;
      const dup = work.some((r) => r.weekday === weekday && r.direction === direction && (r.classTime ?? "") === classTime
        && isSameStudent(r, input.studentId, studentName));
      if (dup && opts.skipDuplicates) continue;
      if (dup) {
        throw new RosterInputError(`${studentName} 학생은 ${WEEKDAY_LABELS[weekday]}요일 ${classTime} ${DIRECTION_LABEL[direction]}이 이미 명단에 있습니다.`);
      }
      const sortOrder = nextSortOrder(work, weekday, direction, classTime);
      out.push({ weekday, classTime, direction, ...stop, sortOrder });
      // 같은 요청 안에서 다음 행이 이 행 뒤로 가도록 작업 목록에도 넣는다.
      work.push({ id: `new-${out.length}`, weekday, direction, classTime, sortOrder, studentId: input.studentId, studentName });
    }
  }
  return out;
}

/** 그 요일 행 중 공백만 다른 같은 수업시간 글자가 있으면 그 글자(가장 많이 쓰인 것), 없으면 입력 그대로. */
export function existingClassTimeVariant(rows: readonly Pick<RosterExistingRow, "weekday" | "classTime">[], weekday: number, classTime: string): string {
  const key = classTimeKey(classTime);
  const count = new Map<string, number>();
  for (const r of rows) {
    if (r.weekday !== weekday || !r.classTime || classTimeKey(r.classTime) !== key) continue;
    count.set(r.classTime, (count.get(r.classTime) ?? 0) + 1);
  }
  if (count.has(classTime) || count.size === 0) return classTime;
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// ── 운행 순서 중간에 넣기(학생 추가) ─────────────────────────────

/** 삽입 계획에 필요한 기존 행 — 합류 시 대상 정차의 정류장 이름·좌표·시각을 복사한다. */
export type RosterPlacementRow = RosterExistingRow & {
  stopName?: string | null;
  arriveTime?: string | null;
  latitude?: number | null;
  longitude?: number | null;
};

/**
 * 삽입 한 단계 — 순서대로 실행한다.
 * shiftFrom 이 있으면 먼저 「그 요일에서 sortOrder ≥ shiftFrom 인 모든 행 +1」을 하고 row 를 넣는다.
 * 요일 전체를 같이 밀기 때문에 다른 수업·방향·운영정차(PIVOT/RETURN)의 서로 간 순서는 그대로다.
 */
export type RosterInsertStep = { shiftFrom: number | null; row: RosterNewRow; mode: RosterPlacementMode; fellBack: boolean };

/**
 * 삽입 계획 = ① 겹침 벌리기(spread: 기존 행 번호 바꾸기, 먼저 실행) → ② 단계(steps) 순서대로.
 * spread 는 BEFORE 로 넣을 칸 안에서 번호가 겹친 학생 행이 있을 때만 생긴다.
 */
export type RosterInsertPlan = { spread: { id: string; sortOrder: number }[]; steps: RosterInsertStep[] };

const PLACEMENT_STALE = "그사이 명단이 바뀌어 넣을 위치를 찾지 못했습니다. 화면을 새로고침한 뒤 다시 골라 주세요.";

/** 그 칸(같은 요일·방향·수업시간)의 학생 행인지. */
function inCell(r: RosterPlacementRow, weekday: number, direction: string, classTime: string | null): boolean {
  return r.weekday === weekday && r.direction === direction && classTimeKey(r.classTime) === classTimeKey(classTime) && !!r.studentName;
}

/** 기사님 화면 순서 — sortOrder, 겹치면 id(명단 조회 ORDER BY "id" COLLATE "C" 와 같은 바이트 순). */
function rowOrder(a: RosterPlacementRow, b: RosterPlacementRow): number {
  return a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * 칸 안에서 번호가 겹친 학생 행을 기사님 화면 순서대로 벌린다(work 를 직접 고친다).
 * 왜: A(5)·B(5) 에서 「B 앞」에 넣으려고 5 를 주면 A 앞에 가 버린다. 먼저 A=5·B=6 으로 벌려야 정확히 그 사이에 간다.
 * 벌릴 때 그 요일에서 겹친 번호보다 큰 행은 모두 함께 밀어(+k-1) 다른 칸·운영 정차의 상대 순서를 지킨다.
 * 칸 밖 행과의 겹침(예: 운영 하차행과 학생 행이 같은 번호)은 칸 순서와 무관하므로 건드리지 않는다.
 */
function spreadCellTies(work: RosterPlacementRow[], weekday: number, direction: string, classTime: string | null) {
  for (let guard = 0; guard < 500; guard++) {
    const cell = work.filter((r) => inCell(r, weekday, direction, classTime)).sort(rowOrder);
    const i = cell.findIndex((r, j) => j > 0 && r.sortOrder === cell[j - 1].sortOrder);
    if (i < 0) return;
    const v = cell[i].sortOrder;
    const tied = cell.filter((r) => r.sortOrder === v);
    for (const r of work) if (r.weekday === weekday && r.sortOrder > v) r.sortOrder += tied.length - 1;
    tied.forEach((r, j) => { r.sortOrder = v + j; });
  }
  throw new RosterInputError("명단 순서를 정리하지 못했습니다. 잠시 후 다시 시도해 주세요.");
}

/**
 * buildAddRows 가 만든 새 행(맨 뒤 기준)에 칸별 삽입 위치를 적용해 실행 계획을 만든다(순수 함수).
 * - END(또는 위치 없음): 예전과 똑같이 그 칸 맨 뒤 번호(밀기 없음).
 * - BEFORE: 칸 겹침을 벌린 뒤, 기준 행 번호를 새 행이 갖고 그 요일의 그 번호 이상을 +1.
 * - JOIN : 밀지 않고 칸 맨 뒤 + 대상 정차의 정류장 이름(글자 그대로)·좌표·시각 복사.
 *          기사님 화면은 같은 이름을 처음 나온 위치에 한 정차로 묶으므로 결과는 합류와 같다.
 * 기준 행이 그 칸(같은 요일·방향·수업시간의 학생 행)이 아니면 거부한다 — 화면과 DB 가 어긋난 상태라서.
 */
export function planRosterInsert(
  rows: readonly RosterNewRow[],
  placements: readonly RosterPlacementInput[] | undefined,
  existing: readonly RosterPlacementRow[],
): RosterInsertPlan {
  const work: RosterPlacementRow[] = existing.map((r) => ({ ...r }));
  const placementOf = (base: RosterNewRow) => (placements ?? []).find((x) => x.weekday === base.weekday && x.direction === base.direction
    && classTimeKey(x.classTime) === classTimeKey(base.classTime));
  const refOf = (base: RosterNewRow, rowId: string) => {
    const ref = work.find((r) => r.id === rowId);
    if (!ref || ref.id.startsWith("new-") || !inCell(ref, base.weekday, base.direction, base.classTime)) throw new RosterInputError(PLACEMENT_STALE);
    return ref;
  };

  // ① BEFORE 로 넣을 칸의 번호 겹침을 먼저 벌린다(기존 행만 대상, 바뀐 행은 spread 로 돌려준다).
  const original = new Map(existing.map((r) => [r.id, r.sortOrder]));
  for (const base of rows) {
    const p = placementOf(base);
    if (p?.mode === "BEFORE" && p.rowId) {
      refOf(base, p.rowId); // 칸 확인
      spreadCellTies(work, base.weekday, base.direction, base.classTime);
    }
  }
  const spread = work.filter((r) => original.get(r.id) !== r.sortOrder).map((r) => ({ id: r.id, sortOrder: r.sortOrder }));

  // ② 새 행을 차례로 넣는다(앞 단계의 밀기를 work 에 반영해 다음 행 계산에 쓴다).
  const steps: RosterInsertStep[] = [];
  rows.forEach((base, i) => {
    const p = placementOf(base);
    const mode: RosterPlacementMode = p?.mode ?? "END";
    let row: RosterNewRow = { ...base };
    let shiftFrom: number | null = null;
    let used: RosterPlacementMode = "END";
    if (mode === "BEFORE" && p?.rowId) {
      const ref = refOf(base, p.rowId);
      shiftFrom = ref.sortOrder;
      for (const r of work) if (r.weekday === base.weekday && r.sortOrder >= shiftFrom) r.sortOrder += 1;
      row = { ...row, classTime: ref.classTime ?? row.classTime, sortOrder: shiftFrom, ...(p.arriveTime !== undefined ? { arriveTime: p.arriveTime } : {}) };
      used = "BEFORE";
    } else if (mode === "JOIN" && p?.rowId) {
      const ref = refOf(base, p.rowId);
      const classTime = ref.classTime ?? row.classTime;
      // 좌표: 대상 정차 좌표, 없으면 원장이 지정한 학생 좌표로 보강(위·경도는 한 쌍으로).
      const coord = ref.latitude != null && ref.longitude != null
        ? { latitude: ref.latitude, longitude: ref.longitude }
        : { latitude: row.latitude, longitude: row.longitude };
      // 시각은 검증 없이 대상 정차 값을 그대로 복사한다('16:40:00' 같은 옛 표기도 그대로).
      row = { ...row, classTime, stopName: ref.stopName || row.stopName, ...coord, arriveTime: ref.arriveTime ?? null,
        sortOrder: nextSortOrder(work, base.weekday, base.direction, classTime) };
      used = "JOIN";
    } else {
      const stop = p?.fallbackStop;
      row = {
        ...row,
        ...(stop ? { stopName: stop.stopName, arriveTime: stop.arriveTime,
          ...(stop.latitude != null && stop.longitude != null ? { latitude: stop.latitude, longitude: stop.longitude } : {}) } : {}),
        ...(p && p.arriveTime !== undefined && !stop ? { arriveTime: p.arriveTime } : {}),
        sortOrder: nextSortOrder(work, base.weekday, base.direction, base.classTime),
      };
    }
    work.push({ id: `new-${i}`, weekday: row.weekday, direction: row.direction, classTime: row.classTime, sortOrder: row.sortOrder,
      studentId: null, studentName: "(새 학생)", stopName: row.stopName, arriveTime: row.arriveTime, latitude: row.latitude, longitude: row.longitude });
    steps.push({ shiftFrom, row, mode: used, fellBack: Boolean(p?.fellBack) });
  });
  return { spread, steps };
}

/**
 * 이후 달(FROM_THIS_MONTH)용 삽입 위치.
 * - BEFORE: 이 달 기준 행의 대응 행(findCounterpartRows: 같은 학생·요일·방향·수업시간)으로 바꾼다. 없으면 맨 뒤 + fellBack.
 * - JOIN  : 그 달도 칸 맨 뒤 + 이 달 합류 정차의 정류장 값. 그 달 그 칸에 같은 이름 정차가 없으면(묶이지 않으면) fellBack.
 */
export function mapPlacementsToMonth(
  placements: readonly RosterPlacementInput[] | undefined,
  sourceRows: readonly RosterPlacementRow[],
  targetRows: readonly RosterPlacementRow[],
): RosterPlacementInput[] {
  return (placements ?? []).map((p) => {
    if (p.mode === "END" || !p.rowId) return { ...p };
    const src = sourceRows.find((r) => r.id === p.rowId);
    if (p.mode === "JOIN") {
      if (!src?.stopName) return { ...p, mode: "END", rowId: null, fellBack: true };
      const fallbackStop = { stopName: src.stopName, arriveTime: src.arriveTime ?? null, latitude: src.latitude ?? null, longitude: src.longitude ?? null };
      const grouped = targetRows.some((r) => inCell(r, p.weekday, p.direction, p.classTime) && r.stopName === src.stopName);
      return { ...p, mode: "END", rowId: null, fallbackStop, ...(grouped ? {} : { fellBack: true }) };
    }
    const hit = src ? findCounterpartRows(src, targetRows)[0] : undefined;
    if (hit) return { ...p, rowId: hit.id };
    return { ...p, mode: "END", rowId: null, fellBack: true };
  });
}

/**
 * 반이동 → 각 행의 새 요일·수업·정렬순서. 대상 행은 모두 이 달의 학생 등·하원 행이어야 하고,
 * 옮겨 갈 자리에 같은 학생의 같은 방향 행이 이미 있으면 거부한다.
 */
export function buildMoveUpdates(
  ids: string[],
  weekday: number,
  classTime: string,
  existing: RosterExistingRow[],
): { id: string; weekday: number; classTime: string; sortOrder: number }[] {
  const byId = new Map(existing.map((r) => [r.id, r]));
  const moving = ids.map((id) => byId.get(id));
  if (moving.some((r) => !r || (r.direction !== "BOARD" && r.direction !== "ALIGHT"))) {
    throw new RosterInputError("일부 행을 이 달 명단에서 찾지 못했습니다. 화면을 새로고침해 주세요.");
  }
  const rows = moving as RosterExistingRow[];
  // 한 번의 반이동은 한 학생의 등·하원 행만 옮긴다. 화면이 행을 모을 때 쓰는 키(그 달 전체로 만든 resolver)와 같은
  // 기준으로 확인해, 조작된 요청이 다른 학생 행을 섞어 옮기는 것을 막는다.
  const keyOf = rosterStudentKeyResolver(existing.map((r) => ({ ...r, parentPhone: r.parentPhone ?? null })));
  if (new Set(rows.map((r) => keyOf({ ...r, parentPhone: r.parentPhone ?? null }))).size !== 1) {
    throw new RosterInputError("한 번에 한 학생의 행만 옮길 수 있습니다. 화면을 새로고침해 주세요.");
  }
  if (new Set(rows.map((r) => r.direction)).size !== rows.length) throw new RosterInputError("같은 방향 행을 한꺼번에 옮길 수 없습니다.");
  const idSet = new Set(ids);
  const others = existing.filter((r) => !idSet.has(r.id));
  const work = [...others];
  return rows.map((r) => {
    const clash = others.some((o) => o.weekday === weekday && o.direction === r.direction && (o.classTime ?? "") === classTime
      && isSameStudent(o, r.studentId, r.studentName));
    if (clash) {
      throw new RosterInputError(`${r.studentName ?? "학생"}은 ${WEEKDAY_LABELS[weekday]}요일 ${classTime} ${DIRECTION_LABEL[r.direction as RosterDirection]}이 이미 있습니다.`);
    }
    const sortOrder = nextSortOrder(work, weekday, r.direction, classTime);
    work.push({ ...r, weekday, classTime, sortOrder });
    return { id: r.id, weekday, classTime, sortOrder };
  });
}

// ── 화면 묶음(요일 → 수업시간 → 학생) ─────────────────────────────

export type RosterStopRow = {
  id?: string;
  weekday: number;
  classTime: string | null;
  arriveTime: string | null;
  stopName: string;
  direction: string;
  studentName: string | null;
  studentId?: string | null;
  studentPhone: string | null;
  parentPhone: string | null;
  note: string | null;
  sortOrder: number;
  latitude?: number | null;
  longitude?: number | null;
};

export type RosterStudentEntry<T extends RosterStopRow = RosterStopRow> = {
  key: string;
  studentId: string | null;
  studentName: string;
  parentPhone: string | null;
  studentPhone: string | null;
  board: T | null;
  alight: T | null;
};

/** 학생 식별키(행 하나만 보고): 학생 id 가 있으면 id, 없으면 이름+학부모 전화 끝 4자리. */
export function rosterStudentKey(row: Pick<RosterStopRow, "studentId" | "studentName" | "parentPhone">): string {
  if (row.studentId) return `id:${row.studentId}`;
  return `name:${normName(row.studentName)}|${phoneTail(row.parentPhone)}`;
}

type RosterKeyRow = Pick<RosterStopRow, "studentId" | "studentName" | "parentPhone">;

/**
 * 그 달 전체 행을 보고 학생 식별키를 정하는 함수를 만든다.
 * 왜: 같은 학생이 등원 행엔 studentId 가 있고 하원 행엔 없으면(시트 이관 잔재) 행 하나만 보는 키로는
 * 두 사람으로 갈려 화면에 두 줄로 나온다. 같은 이름+학부모전화 끝4자리 행 중 studentId 가 딱 하나로 정해지면
 * studentId 없는 행도 그 학생으로 묶는다(둘 이상이면 판단하지 않고 기존 키를 쓴다).
 */
export function rosterStudentKeyResolver(rows: readonly RosterKeyRow[]): (row: RosterKeyRow) => string {
  const idsByNamePhone = new Map<string, Set<string>>();
  for (const r of rows) {
    // 전화 끝자리가 없으면 이름만으로는 묶지 않는다(동명이인을 한 학생으로 묶어 「이 달 전체 빼기」에 남의 행이 섞이는 것 방지).
    if (!r.studentId || !normName(r.studentName) || !phoneTail(r.parentPhone)) continue;
    const np = `${normName(r.studentName)}|${phoneTail(r.parentPhone)}`;
    const set = idsByNamePhone.get(np) ?? new Set<string>();
    set.add(r.studentId);
    idsByNamePhone.set(np, set);
  }
  return (row) => {
    if (row.studentId) return `id:${row.studentId}`;
    if (!phoneTail(row.parentPhone)) return rosterStudentKey(row);
    const ids = idsByNamePhone.get(`${normName(row.studentName)}|${phoneTail(row.parentPhone)}`);
    if (ids && ids.size === 1) return `id:${[...ids][0]}`;
    return rosterStudentKey(row);
  };
}

// ── 이후 달 대응 행 찾기(적용 범위 FROM_THIS_MONTH) ─────────────────

/** 다른 달에서 같은 행을 찾을 때 쓰는 정보 — 학생 + 요일·방향·수업시간. */
export type RosterRowIdentity = {
  weekday: number;
  direction: string;
  classTime: string | null;
  studentId: string | null;
  studentName: string | null;
  parentPhone?: string | null;
};

/**
 * 같은 학생인지(달을 건너 비교). 둘 다 studentId 가 있으면 id 로만,
 * 한쪽이라도 없으면 이름+학부모전화 끝4자리로 비교한다(studentId 가 한쪽에만 있는 행도 이어지게).
 */
export function isSameRosterStudent(a: Omit<RosterRowIdentity, "weekday" | "direction" | "classTime">, b: Omit<RosterRowIdentity, "weekday" | "direction" | "classTime">): boolean {
  if (a.studentId && b.studentId) return a.studentId === b.studentId;
  // 한쪽만 studentId 가 있으면 전화 끝자리까지 있어야 같은 학생으로 본다(이름만으로는 동명이인 위험).
  // 둘 다 없으면(이름만 등록 행끼리 = 복사된 같은 행) 기존 키와 같이 이름+끝자리(빈 값 포함)로 비교한다.
  if ((a.studentId || b.studentId) && !phoneTail(a.parentPhone)) return false;
  const name = normName(a.studentName);
  return name !== "" && name === normName(b.studentName) && phoneTail(a.parentPhone) === phoneTail(b.parentPhone);
}

/** 다른 달 행 목록에서 원본 행에 대응하는 행(같은 학생·요일·방향·수업시간). 없으면 빈 배열. */
export function findCounterpartRows<T extends RosterRowIdentity>(source: RosterRowIdentity, rows: readonly T[]): T[] {
  return rows.filter((r) => r.weekday === source.weekday && r.direction === source.direction
    && (r.classTime ?? "") === (source.classTime ?? "") && isSameRosterStudent(source, r));
}

/**
 * 월 복사 시 저장 노선(payload) 안의 'stop:<행id>' 학생 식별값을 새 달 행 id 로 바꾼다.
 * 왜: 학생 계정과 연결되지 않은 이름만 등록 행은 배차 식별키가 'stop:'+행id 라서, 행을 복사해 id 가 바뀌면
 * 새 달 저장 노선에서 그 학생이 빠진 것으로(reconcile) 처리된다. 값이 정확히 일치하는 문자열만 바꾼다.
 */
export function remapStopRowIds(payload: unknown, idMap: ReadonlyMap<string, string>): unknown {
  if (typeof payload === "string") {
    if (!payload.startsWith("stop:")) return payload;
    const next = idMap.get(payload.slice(5));
    return next ? `stop:${next}` : payload;
  }
  if (Array.isArray(payload)) return payload.map((v) => remapStopRowIds(v, idMap));
  if (payload && typeof payload === "object") {
    return Object.fromEntries(Object.entries(payload as Record<string, unknown>).map(([k, v]) => [k, remapStopRowIds(v, idMap)]));
  }
  return payload;
}

/** 한 요일의 학생 등·하원 행을 수업시간별 학생 목록으로 묶는다(PIVOT·RETURN 같은 운영 정차는 제외). */
export function groupRosterDay<T extends RosterStopRow>(stops: T[], weekday: number): { classTime: string; students: RosterStudentEntry<T>[] }[] {
  const classes = new Map<string, Map<string, RosterStudentEntry<T>>>();
  const keyOf = rosterStudentKeyResolver(stops); // 그 달 전체로 키를 정한다(studentId 섞인 행 한 줄로)
  for (const s of stops) {
    if (s.weekday !== weekday || !s.studentName || (s.direction !== "BOARD" && s.direction !== "ALIGHT")) continue;
    const ct = s.classTime ?? "";
    const students = classes.get(ct) ?? new Map<string, RosterStudentEntry<T>>();
    classes.set(ct, students);
    const key = keyOf(s);
    const entry = students.get(key) ?? {
      key, studentId: s.studentId ?? null, studentName: s.studentName, parentPhone: s.parentPhone, studentPhone: s.studentPhone, board: null, alight: null,
    };
    if (s.direction === "BOARD") entry.board = entry.board ?? s;
    else entry.alight = entry.alight ?? s;
    entry.studentId = entry.studentId ?? s.studentId ?? null; // 묶인 행 중 하나라도 id 가 있으면 그 학생
    entry.parentPhone = entry.parentPhone ?? s.parentPhone;
    entry.studentPhone = entry.studentPhone ?? s.studentPhone;
    students.set(key, entry);
  }
  return [...classes.entries()]
    .sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)))
    .map(([classTime, students]) => ({
      classTime,
      students: [...students.values()].sort((a, b) => a.studentName.localeCompare(b.studentName, "ko")),
    }));
}

/** 그 달 명단에서 한 학생의 모든 등·하원 행 id(「이 달 전체 빼기」용). */
export function rosterRowIdsForStudent(stops: RosterStopRow[], key: string): string[] {
  const keyOf = rosterStudentKeyResolver(stops);
  return stops
    .filter((s) => s.id && s.studentName && (s.direction === "BOARD" || s.direction === "ALIGHT") && keyOf(s) === key)
    .map((s) => s.id as string);
}

// ── 월 복사 후 탑승체크·기사 요청 식별값 옮기기 ─────────────────────

/**
 * 따라잡기 생성(이미 시작된 달을 뒤늦게 만든 경우)일 때만, 그 달 날짜 범위를 돌려준다.
 * 왜: 그 달 명단이 없던 동안 기사님 화면은 직전 달 행 id 로 탑승체크(ShuttleBoarding)·제외 요청(DriverRequest)을 남겼다.
 * 새 달이 생기면 화면이 새 행 id 로 바뀌므로, 그 달 날짜에 찍힌 기록을 새 id 로 옮겨야 체크가 사라지거나 중복되지 않는다.
 * 미래 달(대상 달 > 이번 달)은 아직 기록이 없으므로 null. 범위는 'YYYY-MM-DD' 문자열 비교용 [from, to).
 */
export function catchUpDateRange(targetMonth: string, currentMonth: string): { from: string; to: string } | null {
  if (normalizeRosterMonth(targetMonth) > normalizeRosterMonth(currentMonth)) return null;
  return { from: `${targetMonth}-01`, to: `${nextServiceMonth(targetMonth)}-01` };
}

/** (옛 행 id → 새 행 id) 짝을 SQL unnest 용 두 배열로. 빈 값·중복 옛 id 는 뺀다. */
export function idPairArrays(pairs: readonly { oldId: string; newId: string }[]): { oldIds: string[]; newIds: string[] } {
  const seen = new Set<string>();
  const oldIds: string[] = [];
  const newIds: string[] = [];
  for (const p of pairs) {
    const o = String(p.oldId ?? ""), n = String(p.newId ?? "");
    if (!o || !n || seen.has(o)) continue;
    seen.add(o); oldIds.push(o); newIds.push(n);
  }
  return { oldIds, newIds };
}

// ── 기사님 화면 순서·시각 편집(정차 단위) ───────────────────────────

/** 한 정차 = 같은 정류장에 묶인 명단 행들 + 그 정차의 시각. 기사님 화면(groupSheetStops)과 같은 묶음이다. */
export type RosterReorderStop = { rowIds: string[]; arriveTime: string | null };

export type RosterReorderInput = {
  serviceMonth: string;
  scope: RosterScope;
  weekday: number;
  classTime: string;
  direction: RosterDirection;
  /** 새 운행 순서대로의 정차 목록. 그 수업·방향의 모든 학생 행이 정확히 한 번씩 들어 있어야 한다. */
  stops: RosterReorderStop[];
};

const MAX_REORDER_STOPS = 100;
const MAX_REORDER_ROWS = 300;

/**
 * 순서 편집의 수업시간은 **글자 그대로** 비교한다(공백 정리 안 함).
 * 왜: 기사님 화면은 classTime 글자가 같은 행끼리 한 섹션으로 묶는다. 여기서 공백을 정리하면
 *     '17:00 ~ 18:00'(가져오기 잔재) 행을 못 찾아 저장이 막힌다.
 */
function exactClassTime(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new RosterInputError("수업시간을 입력해 주세요.");
  if (v.length > 40) throw new RosterInputError("수업시간이 너무 깁니다.");
  return v;
}

export function validateReorderInput(raw: unknown): RosterReorderInput {
  const o = obj(raw);
  const direction = o.direction === "BOARD" || o.direction === "ALIGHT" ? o.direction : null;
  if (!direction) throw new RosterInputError("방향(등원·하원)이 올바르지 않습니다.");
  if (!Array.isArray(o.stops) || o.stops.length === 0) throw new RosterInputError("저장할 정차가 없습니다.");
  if (o.stops.length > MAX_REORDER_STOPS) throw new RosterInputError("정차가 너무 많습니다.");
  const seen = new Set<string>();
  const stops = o.stops.map((s) => {
    const so = obj(s);
    const rowIds = normalizeIds(so.rowIds);
    // 한 행이 두 정차에 들어 있으면 순서가 모호하다 → 화면과 서버가 어긋난 상태로 본다.
    for (const id of rowIds) {
      if (seen.has(id)) throw new RosterInputError("같은 학생 행이 두 정차에 들어 있습니다. 화면을 새로고침해 주세요.");
      seen.add(id);
    }
    return { rowIds, arriveTime: normalizeArriveTime(so.arriveTime) };
  });
  if (seen.size > MAX_REORDER_ROWS) throw new RosterInputError("한 번에 처리할 수 있는 행이 너무 많습니다.");
  return {
    serviceMonth: normalizeRosterMonth(o.serviceMonth),
    scope: normalizeRosterScope(o.scope),
    weekday: normalizeWeekday(o.weekday),
    classTime: exactClassTime(o.classTime),
    direction,
    stops,
  };
}

/** 그 요일·수업·방향의 학생 행(기사님 화면 한 칸에 들어가는 행들). */
export function reorderGroupRows<T extends Pick<RosterExistingRow, "weekday" | "direction" | "classTime" | "studentName">>(
  rows: readonly T[], weekday: number, classTime: string, direction: RosterDirection,
): T[] {
  return rows.filter((r) => r.weekday === weekday && r.direction === direction && (r.classTime ?? "") === classTime && !!r.studentName);
}

export type RosterReorderUpdate = { id: string; sortOrder: number; arriveTime: string | null };

/**
 * 「슬롯 재배정」 — 대상 행들이 원래 갖고 있던 sortOrder 값(오름차순)을 새 순서대로 다시 나눠 준다.
 * 왜: sortOrder 는 요일 안의 번호라 다른 수업·방향 행과 섞여 있다. 우리 행들이 쓰던 번호만 돌려 쓰면
 *     다른 수업·방향의 순서는 전혀 바뀌지 않는다(정규 배차 RegularRouteSection 과 같은 방식).
 * 같은 번호가 겹쳐 있으면(가져오기 잔재) 정렬이 흔들리므로, 앞 번호보다 반드시 1 이상 크게 맞춘다.
 * ordered: 새 순서의 (행 id, 시각). sortOrderById: 그 행들의 현재 sortOrder.
 */
export function reassignSortSlots(
  ordered: readonly { id: string; arriveTime: string | null }[],
  sortOrderById: ReadonlyMap<string, number>,
): RosterReorderUpdate[] {
  const slots = ordered.map((o) => {
    const v = sortOrderById.get(o.id);
    if (v == null) throw new RosterInputError("일부 행을 이 달 명단에서 찾지 못했습니다. 화면을 새로고침해 주세요.");
    return v;
  }).sort((a, b) => a - b);
  for (let i = 1; i < slots.length; i++) if (slots[i] <= slots[i - 1]) slots[i] = slots[i - 1] + 1;
  return ordered.map((o, i) => ({ id: o.id, sortOrder: slots[i], arriveTime: o.arriveTime }));
}

/** 정차 목록 → (행 id, 그 정차 시각) 을 운행 순서대로 펼친다. */
export function flattenReorderStops(stops: readonly RosterReorderStop[]): { id: string; arriveTime: string | null }[] {
  return stops.flatMap((s) => s.rowIds.map((id) => ({ id, arriveTime: s.arriveTime })));
}

/**
 * 이 달(고른 달) 순서 저장 계획. 보낸 행 집합이 그 수업·방향의 현재 학생 행 집합과 **정확히 같아야** 한다
 * (다른 사람이 그사이 학생을 추가·삭제했으면 순서가 어긋나므로 저장을 막고 새로고침을 안내).
 */
export function buildReorderUpdates(input: Pick<RosterReorderInput, "weekday" | "classTime" | "direction" | "stops">, existing: readonly RosterExistingRow[]): RosterReorderUpdate[] {
  const group = reorderGroupRows(existing, input.weekday, input.classTime, input.direction);
  const ordered = flattenReorderStops(input.stops);
  const groupIds = new Set(group.map((r) => r.id));
  if (ordered.length !== groupIds.size || ordered.some((o) => !groupIds.has(o.id))) {
    throw new RosterInputError("그사이 명단이 바뀌었습니다. 화면을 새로고침한 뒤 다시 맞춰 주세요.");
  }
  return reassignSortSlots(ordered, new Map(group.map((r) => [r.id, r.sortOrder])));
}

/**
 * 이후 달 순서 반영 계획(적용 범위 FROM_THIS_MONTH).
 * 이 달 행마다 그 달의 대응 행(같은 학생·요일·방향·수업시간 = findCounterpartRows)을 찾아 같은 순서·시각으로 맞춘다.
 * 대응 행끼리만 그들이 쓰던 번호를 돌려 쓰고, 그 달에만 있는 학생 행은 손대지 않는다. 대응 행이 없으면 빈 배열(건너뜀).
 */
export function buildCounterpartReorderUpdates(
  orderedSource: readonly (RosterRowIdentity & { arriveTime: string | null })[],
  laterRows: readonly RosterExistingRow[],
): RosterReorderUpdate[] {
  const used = new Set<string>();
  const ordered: { id: string; arriveTime: string | null }[] = [];
  for (const src of orderedSource) {
    const hit = findCounterpartRows(src, laterRows).find((r) => !used.has(r.id));
    if (!hit) continue;
    used.add(hit.id);
    ordered.push({ id: hit.id, arriveTime: src.arriveTime });
  }
  if (ordered.length === 0) return [];
  return reassignSortSlots(ordered, new Map(laterRows.map((r) => [r.id, r.sortOrder])));
}
