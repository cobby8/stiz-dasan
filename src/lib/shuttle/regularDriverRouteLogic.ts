// 정규 셔틀 "기사님 화면"이 무엇을 보여 줄지 정하는 순수 로직 — prisma 등 서버 의존성 절대 금지.
// ─────────────────────────────────────────────────────────────────────────────
// 왜 순수 모듈로 떼는가?
//   기사님 화면은 두 가지 소스를 갖는다.
//     1) 원장이 /admin/shuttle/regular-dispatch 에서 저장한 배차 노선(RegularDispatchRoute.payload)
//     2) 셔틀 명단(RegularShuttleStop) — 저장 노선이 없는 요일의 폴백
//   "어느 쪽을 쓸지"와 "저장 노선의 학생을 명단 정차행(=탑승체크 키)에 어떻게 이어 붙일지"는
//   조용히 어긋나면 기사님이 이미 체크한 학생을 미체크로 보게 되는 위험한 판정이라,
//   DB 없이 테스트로 못박아 두려고 순수 모듈로 분리한다.
//
// ⚠️ 탑승 체크 저장 키는 예전과 똑같이 **명단 정차행 id(RegularShuttleStop.id)** 다.
//    저장 노선 payload 안의 학생 식별자는 studentId(= Student.id 또는 'stop:'+행id)로 **다르다**.
//    그래서 여기서 studentId → 정차행 id 로 되돌려 매핑한다(기록 연속성 보존).

import type { RegularShuttleStop } from "./regularSheet";

// ── 기사님 화면이 소비하는 표시 계약(RegularDriverClient 가 그대로 import 해서 쓴다) ──────────
export type DriverRow = { rowId: string; name: string; parentPhone: string | null; studentPhone: string | null; absent?: boolean;
  /** "오늘만" 셔틀 변경(안 탐·다른 곳에서 탐). 결석과 다르다 — 아이는 수업에 온다. */
  shuttleNote?: string | null };
export type DriverStop = { label: string; arriveTime: string | null; lat: number | null; lng: number | null; direction: "BOARD" | "ALIGHT"; rows: DriverRow[] };
/** classTime: 섹션 구분 키(=React key). title 이 있으면 화면 제목으로 그것을 쓴다. pending=확정 전(임시 순서). */
export type DriverClass = { classTime: string; title?: string; pending?: boolean; board: DriverStop[]; alight: DriverStop[] };

/** 결석 판정은 호출부(서버)가 주입한다 — 순수 모듈이 DB/이름매칭 모듈에 묶이지 않게. */
export type AbsentPredicate = (p: { name: string | null; phone: string | null }) => boolean;

export type RouteDirection = "PICKUP" | "DROPOFF";

/** 그날 셔틀 예외 한 건. 정규 명단 행엔 학생 id 가 없을 수 있어 이름·전화로 잇는다. */
export type ShuttleDayExceptionEntry = {
  name: string;
  phone: string | null;
  direction: string; // PICKUP | DROPOFF | BOTH
  kind: string; // SKIP | LOCATION
  location: string | null;
};

/**
 * 다 만들어진 운행 명단에 "오늘만" 셔틀 변경을 덧붙인다.
 *
 * 조립 과정에 끼워 넣지 않고 **뒤에서 덧붙이는** 이유: 명단을 만드는 경로가
 * 저장 노선·폴백 두 갈래라, 양쪽에 같은 로직을 심으면 한쪽만 고쳐지기 쉽다.
 * 여기 한 곳에서 붙이면 어느 경로로 만들어졌든 똑같이 적용된다.
 */
export function attachShuttleDayNotes(
  classes: DriverClass[],
  exceptions: ShuttleDayExceptionEntry[],
  matches: (row: { name: string | null; phone: string | null }, entry: ShuttleDayExceptionEntry) => boolean,
  describe: (entry: { kind: string; location: string | null }) => string,
): DriverClass[] {
  if (exceptions.length === 0) return classes;

  const noteFor = (row: DriverRow, runDirection: "PICKUP" | "DROPOFF"): string | null => {
    const hit = exceptions.find(
      (entry) =>
        (entry.direction === "BOTH" || entry.direction === runDirection) &&
        matches({ name: row.name, phone: row.parentPhone }, entry),
    );
    return hit ? describe(hit) : null;
  };

  const withNotes = (stops: DriverStop[], runDirection: "PICKUP" | "DROPOFF"): DriverStop[] =>
    stops.map((stop) => ({
      ...stop,
      rows: stop.rows.map((row) => {
        const note = noteFor(row, runDirection);
        return note ? { ...row, shuttleNote: note } : row;
      }),
    }));

  return classes.map((item) => ({
    ...item,
    board: withNotes(item.board, "PICKUP"),
    alight: withNotes(item.alight, "DROPOFF"),
  }));
}


// 저장 payload 는 JSON 이라 타입이 없다. 읽는 필드만 느슨하게 선언한다(없어도 안전하게 동작).
type SavedStudent = { requestId?: unknown; name?: unknown; parentPhone?: unknown; childPhone?: unknown };
type SavedStop = { label?: unknown; lat?: unknown; lng?: unknown; etaLabel?: unknown; etaMinutes?: unknown; etaManual?: unknown; students?: unknown };
type SavedVehicle = { vehicleName?: unknown; tripLabel?: unknown; stops?: unknown };

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | null {
  if (v == null) return null;
  const t = String(v).trim();
  return t ? t : null;
}
function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 정류장 이름 비교용 정규화 — 공백 제거 + 소문자('다산푸르지오 정문' vs '다산푸르지오정문' 흡수). */
export function normalizeStopName(v: string | null | undefined): string {
  return (v ?? "").replace(/\s+/g, "").toLowerCase();
}

/**
 * 저장 노선을 쓸지, 셔틀 명단으로 폴백할지 결정한다.
 *   SAVED    = 저장본에 "학생이 실제로 들어 있는 정차"가 하나라도 있을 때만.
 *   FALLBACK = 저장본이 없거나 비어 있을 때(빈 저장본을 쓰면 기사님 화면이 통째로 비어 버린다).
 */
export function pickRegularRouteSource(saved: { vehicles?: unknown } | null | undefined): "SAVED" | "FALLBACK" {
  for (const v of asArray(saved?.vehicles) as SavedVehicle[]) {
    for (const s of asArray(v?.stops) as SavedStop[]) {
      if (asArray(s?.students).length > 0) return "SAVED";
    }
  }
  return "FALLBACK";
}

/** 저장 정차의 표시 시각('HH:MM'). etaLabel('08:53 승차') 우선 → etaManual(수동확정) → etaMinutes(자동). */
export function savedStopTimeLabel(stop: { etaLabel?: unknown; etaMinutes?: unknown; etaManual?: unknown }): string | null {
  const label = typeof stop?.etaLabel === "string" ? stop.etaLabel.match(/(\d{1,2}):(\d{2})/) : null;
  if (label) return `${label[1].padStart(2, "0")}:${label[2]}`;
  const min = typeof stop?.etaManual === "number" ? stop.etaManual
    : typeof stop?.etaMinutes === "number" ? stop.etaMinutes : null;
  if (min == null) return null;
  const v = ((Math.round(min) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/**
 * 셔틀 명단 행을 정류장별로 묶어 기사님 화면 정차로 만든다(= 종전 폴백 동작 그대로).
 * 같은 정류장 이름끼리 묶고, 명단 순서(sortOrder)를 유지한다.
 */
export function groupSheetStops(
  rows: RegularShuttleStop[],
  direction: "BOARD" | "ALIGHT",
  isAbsent: AbsentPredicate,
): DriverStop[] {
  const order: string[] = [];
  const map = new Map<string, DriverStop>();
  for (const r of rows) {
    if (r.direction !== direction || !r.studentName || !r.id) continue;
    let g = map.get(r.stopName);
    if (!g) {
      g = { label: r.stopName, arriveTime: r.arriveTime, lat: r.latitude ?? null, lng: r.longitude ?? null, direction, rows: [] };
      map.set(r.stopName, g);
      order.push(r.stopName);
    }
    if (g.lat == null && r.latitude != null) { g.lat = r.latitude; g.lng = r.longitude ?? null; }
    if (!g.arriveTime && r.arriveTime) g.arriveTime = r.arriveTime;
    g.rows.push({
      rowId: r.id,
      name: r.studentName,
      parentPhone: r.parentPhone,
      studentPhone: r.studentPhone,
      absent: isAbsent({ name: r.studentName, phone: r.parentPhone }),
    });
  }
  return order.map((k) => map.get(k)!);
}

/**
 * 저장 노선(payload.vehicles)을 기사님 화면 섹션으로 바꾼다.
 *
 * 핵심: 저장본의 학생 식별자(requestId = studentId)를 **명단 정차행 id 로 되돌려** 탑승 체크 키를 보존한다.
 *   - 한 학생이 같은 요일·방향에 여러 행을 가질 수 있어(명단 중복·오분류 실측 8건) 큐로 관리하고,
 *     정류장 이름이 같은 행을 먼저 소비한다. 그래야 같은 사람의 두 정차가 서로 뒤바뀌지 않는다.
 *   - 명단 행을 못 찾은 학생도 **절대 숨기지 않는다**(조용히 사라지는 것이 가장 위험).
 *     이때만 `route:<studentId>` 라는 고정 키를 쓴다(재접속해도 같은 키라 체크가 유지된다).
 *   - 노선에 안 실린 명단 행은 leftoverRows 로 돌려줘 호출부가 '확정 전' 섹션으로 따로 보여 준다.
 */
export function buildSavedDriverSections(input: {
  vehicles: unknown;
  direction: RouteDirection;
  /** 라이더 studentId → 그 요일·방향 명단 정차행 id 목록(sortOrder 순). */
  rowIdsByStudentId: Map<string, string[]>;
  /** 그 요일·방향의 명단 행(이름·전화·좌표 보강 + leftover 계산용). */
  sheetRows: RegularShuttleStop[];
  isAbsent: AbsentPredicate;
}): { sections: DriverClass[]; leftoverRows: RegularShuttleStop[] } {
  const stopDir: "BOARD" | "ALIGHT" = input.direction === "PICKUP" ? "BOARD" : "ALIGHT";
  const dirLabel = input.direction === "PICKUP" ? "등원" : "하원";
  const rowById = new Map<string, RegularShuttleStop>();
  for (const r of input.sheetRows) if (r.id) rowById.set(r.id, r);

  // 소비 큐(원본 Map 을 건드리지 않도록 복사).
  const pool = new Map<string, string[]>();
  for (const [k, v] of input.rowIdsByStudentId) pool.set(k, [...v]);
  const used = new Set<string>();

  const sections: DriverClass[] = [];
  const vehicles = asArray(input.vehicles) as SavedVehicle[];
  vehicles.forEach((v, vi) => {
    const stops: DriverStop[] = [];
    for (const s of asArray(v?.stops) as SavedStop[]) {
      const label = str(s?.label) ?? "(위치 미지정)";
      const rows: DriverRow[] = [];
      for (const st of asArray(s?.students) as SavedStudent[]) {
        const studentId = str(st?.requestId);
        if (!studentId) continue;
        const queue = pool.get(studentId) ?? [];
        let idx = queue.findIndex((id) => normalizeStopName(rowById.get(id)?.stopName) === normalizeStopName(label));
        if (idx < 0) idx = 0;
        const rowId = queue.length > 0 ? queue.splice(idx, 1)[0] : null;
        if (rowId) used.add(rowId);
        const sheet = rowId ? rowById.get(rowId) : undefined;
        const name = sheet?.studentName ?? str(st?.name) ?? "";
        const parentPhone = sheet?.parentPhone ?? str(st?.parentPhone) ?? null;
        rows.push({
          // 탑승 체크 키 = 명단 정차행 id(종전과 동일). 못 찾은 예외만 고정 대체키.
          rowId: rowId ?? `route:${studentId}`,
          name,
          parentPhone,
          studentPhone: sheet?.studentPhone ?? str(st?.childPhone) ?? null,
          absent: input.isAbsent({ name, phone: parentPhone }),
        });
      }
      if (rows.length === 0) continue; // 학생 없는 정차(차고지 경유 등)는 기사 화면에 띄우지 않는다.
      stops.push({
        label,
        arriveTime: savedStopTimeLabel(s),
        lat: numOrNull(s?.lat),
        lng: numOrNull(s?.lng),
        direction: stopDir,
        rows,
      });
    }
    if (stops.length === 0) return;
    const vehicleName = str(v?.vehicleName) ?? `${vi + 1}호차`;
    const trip = str(v?.tripLabel);
    sections.push({
      classTime: `${input.direction}#${vi}`,
      title: `🚐 ${vehicleName}${trip ? ` · ${trip}` : ""} · ${dirLabel}`,
      pending: false,
      board: stopDir === "BOARD" ? stops : [],
      alight: stopDir === "ALIGHT" ? stops : [],
    });
  });

  const leftoverRows = input.sheetRows.filter((r) => r.direction === stopDir && r.studentName && r.id && !used.has(r.id));
  return { sections, leftoverRows };
}

/** 폴백(셔틀 명단) 섹션 — 한 방향만 채운다. '확정 전'을 알리려고 pending=true. */
export function buildFallbackDirectionSections(
  dayRows: RegularShuttleStop[],
  direction: RouteDirection,
  isAbsent: AbsentPredicate,
): DriverClass[] {
  const stopDir: "BOARD" | "ALIGHT" = direction === "PICKUP" ? "BOARD" : "ALIGHT";
  const dirLabel = direction === "PICKUP" ? "등원" : "하원";
  const classTimes = [...new Set(dayRows.filter((s) => s.direction === stopDir).map((s) => s.classTime).filter((c): c is string => !!c))]
    .sort((a, b) => a.localeCompare(b));
  const out: DriverClass[] = [];
  for (const ct of classTimes) {
    const stops = groupSheetStops(dayRows.filter((s) => s.classTime === ct), stopDir, isAbsent);
    if (stops.length === 0) continue;
    out.push({
      classTime: `${direction}@${ct}`,
      title: `🕒 ${ct} 수업 · ${dirLabel}`,
      pending: true,
      board: stopDir === "BOARD" ? stops : [],
      alight: stopDir === "ALIGHT" ? stops : [],
    });
  }
  return out;
}

/**
 * 그 요일의 기사님 화면 재료 행 — 학생 정차행(승차/하차)만, 명단 순서(sortOrder) 그대로.
 * 기사님 화면(서버)과 관리자 「기사님 화면」 보기가 **같은 함수**로 고르게 한곳에 둔다
 * (한쪽만 고쳐져 관리자가 보는 순서와 기사님이 보는 순서가 어긋나는 사고 방지).
 */
export function selectDriverDayRows<T extends Pick<RegularShuttleStop, "weekday" | "direction" | "studentName" | "sortOrder">>(stops: readonly T[], weekday: number): T[] {
  return stops
    .filter((s) => s.weekday === weekday && (s.direction === "BOARD" || s.direction === "ALIGHT") && s.studentName)
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/** 두 방향 모두 저장본이 없을 때 — 종전 화면 그대로(수업시간별 등원+하원 한 섹션). */
export function buildFallbackClasses(dayRows: RegularShuttleStop[], isAbsent: AbsentPredicate): DriverClass[] {
  const classTimes = [...new Set(dayRows.map((s) => s.classTime).filter((c): c is string => !!c))]
    .sort((a, b) => a.localeCompare(b));
  return classTimes.map((ct) => {
    const rows = dayRows.filter((s) => s.classTime === ct);
    return {
      classTime: ct,
      pending: true, // 임시 순서 · 확정 전
      board: groupSheetStops(rows, "BOARD", isAbsent),
      alight: groupSheetStops(rows, "ALIGHT", isAbsent),
    };
  });
}

/**
 * 기사님 화면 섹션 최종 조립.
 *   - 방향별로 독립 판단한다(등원만 저장돼 있으면 등원만 확정 노선, 하원은 폴백).
 *   - 두 방향 다 폴백이면 종전 화면과 100% 같은 구조를 돌려준다(회귀 0).
 *   - 저장 노선에 안 실린 명단 행은 '노선 미반영' 섹션으로 뒤에 붙여 **아무도 사라지지 않게** 한다.
 */
export function assembleRegularDriverClasses(input: {
  dayRows: RegularShuttleStop[];
  isAbsent: AbsentPredicate;
  saved: Record<RouteDirection, { vehicles?: unknown } | null>;
  rowIdsByStudentId: Record<RouteDirection, Map<string, string[]>>;
}): DriverClass[] {
  const source = {
    PICKUP: pickRegularRouteSource(input.saved.PICKUP),
    DROPOFF: pickRegularRouteSource(input.saved.DROPOFF),
  };
  if (source.PICKUP === "FALLBACK" && source.DROPOFF === "FALLBACK") {
    return buildFallbackClasses(input.dayRows, input.isAbsent);
  }

  const out: DriverClass[] = [];
  for (const direction of ["PICKUP", "DROPOFF"] as RouteDirection[]) {
    const stopDir = direction === "PICKUP" ? "BOARD" : "ALIGHT";
    const dirLabel = direction === "PICKUP" ? "등원" : "하원";
    if (source[direction] === "FALLBACK") {
      out.push(...buildFallbackDirectionSections(input.dayRows, direction, input.isAbsent));
      continue;
    }
    const { sections, leftoverRows } = buildSavedDriverSections({
      vehicles: input.saved[direction]?.vehicles,
      direction,
      rowIdsByStudentId: input.rowIdsByStudentId[direction],
      sheetRows: input.dayRows.filter((r) => r.direction === stopDir),
      isAbsent: input.isAbsent,
    });
    out.push(...sections);
    if (leftoverRows.length > 0) {
      const stops = groupSheetStops(leftoverRows, stopDir, input.isAbsent);
      if (stops.length > 0) {
        out.push({
          classTime: `${direction}#leftover`,
          title: `⚠️ 노선에 없는 승객 · ${dirLabel}`,
          pending: true,
          board: stopDir === "BOARD" ? stops : [],
          alight: stopDir === "ALIGHT" ? stops : [],
        });
      }
    }
  }
  return out;
}
