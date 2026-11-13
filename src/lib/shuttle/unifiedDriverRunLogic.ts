// 기사님 "통합 운행 화면"이 그날 무엇을 어떤 순서로 보여 줄지 정하는 순수 로직.
// ─────────────────────────────────────────────────────────────────────────────
// 왜 순수 모듈인가?
//   기사님은 방학특강·정규를 구분하지 않는다. 그냥 "지금 몇 시에 어디로 가야 하나"만 본다.
//   그래서 두 데이터를 시각순 한 줄로 합치는데, 이 병합이 조용히 어긋나면
//   (① 학생이 사라지거나 ② 탑승 체크가 엉뚱한 API 로 저장되거나 ③ 시각 없는 정차가 맨 앞으로 오거나)
//   기사님이 학생을 두고 출발하는 실사고가 난다.
//   그래서 prisma·React 의존 없이 떼어 내 테스트로 못박는다.
//
// ⚠️ 탑승 체크 저장 경로는 절대 통합하지 않는다. 행마다 자기 종류(kind)를 들고 다니며
//    특강 행은 /api/shuttle/boarding, 정규 행은 /api/shuttle/regular-boarding 으로 간다.
//    저장 키도 종전 그대로다(특강=shuttleRequestId, 정규=시트 정차행 id).

import type { DriverClass } from "./regularDriverRouteLogic";

export type UnifiedKind = "SEASONAL" | "REGULAR";
export type UnifiedDirection = "PICKUP" | "DROPOFF";

/** 한 학생(정확히는 "한 정차에서의 한 탑승 건"). checkId 는 그 종류의 기존 저장 키 그대로. */
export type UnifiedRider = {
  /** 탑승 상태 맵의 키. 종류·방향이 달라도 절대 겹치지 않게 접두사를 붙인다. */
  key: string;
  /** 저장 API 로 그대로 보낼 id(특강=shuttleRequestId, 정규=시트 정차행 id). */
  checkId: string;
  kind: UnifiedKind;
  direction: UnifiedDirection;
  name: string;
  grade: string | null;
  parentPhone: string | null;
  studentPhone: string | null;
  /** 그날 결석으로 잡힌 학생(정규=결석 뱃지·기본 «결석», 특강=결석예정). 명단에서 빼지 않는다. */
  absent: boolean;
  /** 정규 결석 뱃지 문구(항상 «결석» · 사유 없음). 없으면 화면이 기본 «결석»을 쓴다. */
  absentLabel?: string | null;
  /** "오늘만" 셔틀 변경(안 탐·다른 곳에서 탐). 결석과 다르다 — 아이는 수업에 온다. */
  shuttleNote?: string | null;
  /** 잠긴 줄 뱃지(정규 휴원·퇴원·첫 수업 전·휴무). 있으면 탑승·미탑승 버튼을 잠그고 체크 대상에서 뺀다. */
  blockedLabel?: string | null;
};

/** 목록의 한 줄 = 한 정차(또는 차고지 출발/학원 도착 같은 안내 줄). */
export type UnifiedRow = {
  key: string;
  kind: UnifiedKind;
  direction: UnifiedDirection;
  /** 순서 편집 단위(같은 차량·같은 방향). */
  groupKey: string;
  /** 화면에 작게 붙는 그룹 이름(🚐 1호차 · 1회차 / 🕒 17:00 수업 · 등원). 없으면 표시 안 함. */
  groupLabel: string | null;
  label: string;
  /** 그 줄에 곁들이는 보조 정보(수업 시작/종료 시각). 없으면 표시 안 함. */
  subLabel: string | null;
  /** 표시용 시각 'HH:MM'. null 이면 '시간 미정'. */
  time: string | null;
  /** 정렬 키(분). null 은 목록 맨 끝으로 보낸다. */
  minutes: number | null;
  /** 원본 순서(안정 정렬용 tiebreak). */
  seq: number;
  lat: number | null;
  lng: number | null;
  /** 특강 무료 거점(워크인). */
  isHub: boolean;
  /** 차고지 출발·학원 도착 같은 안내 줄(탑승 체크 없음, 진행률에서도 제외). */
  isTerminal: boolean;
  /** 정규 '임시 순서 · 확정 전'. */
  pending: boolean;
  /** 정규 '노선에 없는 승객'(저장 노선에 안 실린 시트 행). */
  warn: boolean;
  riders: UnifiedRider[];
};

// ── 입력 계약 — 기존 두 화면이 만들던 모양 그대로 받는다(구조적 타입이라 그대로 넘겨도 맞는다) ──
export type SeasonalStudentInput = {
  requestId: string; name: string; grade?: string | null;
  parentPhone?: string | null; childPhone?: string | null; isAbsent?: boolean;
};
export type SeasonalStopInput = {
  label: string; isHub?: boolean; etaLabel?: string | null;
  lat?: number | null; lng?: number | null; students?: SeasonalStudentInput[];
};
export type SeasonalVehicleInput = {
  vehicleName: string; tripLabel?: string | null;
  departTime?: string | null; arriveTime?: string | null; depotTime?: string | null;
  stops?: SeasonalStopInput[];
};
export type SeasonalSectionInput = {
  direction: UnifiedDirection; time?: string | null;
  startName: string; endName: string; vehicles?: SeasonalVehicleInput[];
};

/** 'HH:MM' 을 문자열 어디에서든 하나 뽑아 분으로. '08:57 승차' → 537. 못 찾으면 null. */
export function parseHHMM(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const m = value.match(/(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]), min = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** 분 → 'HH:MM'. 표시용으로 시각을 통일한다('8:5' 같은 시트 오타 흡수). */
export function formatHHMM(minutes: number | null): string | null {
  if (minutes == null) return null;
  const v = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${String(v % 60).padStart(2, "0")}`;
}

/** 방학특강 섹션 → 통합 행. 학생은 한 명도 빠뜨리지 않는다(정차 순서·소속 차량 그대로). */
export function buildSeasonalRows(sections: SeasonalSectionInput[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const sec of sections ?? []) {
    const isPickup = sec.direction === "PICKUP";
    const vehicles = sec.vehicles ?? [];
    vehicles.forEach((v, vi) => {
      const groupKey = `S:${sec.direction}:${vi}`;
      // 차량이 하나뿐이면 종전 화면처럼 차량명을 굳이 띄우지 않는다(정보 최소화).
      const groupLabel = vehicles.length > 1
        ? `🚐 ${v.vehicleName}${v.tripLabel ? ` · ${v.tripLabel}` : ""}`
        : null;

      // 출발 줄(차고지/학원 출발) — 시각이 있을 때만 만든다(시각 없는 안내 줄이 끝에 쌓이지 않게).
      const departMin = parseHHMM(v.departTime);
      if (departMin != null) {
        rows.push(terminalRow({
          key: `${groupKey}:start`, groupKey, groupLabel, direction: sec.direction,
          label: `${sec.startName} 출발`,
          subLabel: !isPickup && sec.time ? `수업 ${sec.time} 종료` : null,
          minutes: departMin,
        }));
      }

      for (const [si, s] of (v.stops ?? []).entries()) {
        const minutes = parseHHMM(s.etaLabel ?? null);
        rows.push({
          key: `${groupKey}:${si}`,
          kind: "SEASONAL",
          direction: sec.direction,
          groupKey, groupLabel,
          label: s.label,
          subLabel: null,
          time: formatHHMM(minutes),
          minutes,
          seq: 0,
          lat: s.lat ?? null,
          lng: s.lng ?? null,
          isHub: Boolean(s.isHub),
          isTerminal: false,
          pending: false,
          warn: false,
          riders: (s.students ?? []).map((st) => ({
            // 특강 탑승 상태는 방향별로 따로 저장된다 → 키에 방향을 포함해야 등원/하원이 섞이지 않는다.
            key: `S:${sec.direction}:${st.requestId}`,
            checkId: st.requestId,
            kind: "SEASONAL" as const,
            direction: sec.direction,
            name: st.name,
            grade: st.grade ?? null,
            parentPhone: st.parentPhone ?? null,
            studentPhone: st.childPhone ?? null,
            absent: Boolean(st.isAbsent),
          })),
        });
      }

      // 도착/복귀 줄.
      const endMin = parseHHMM(isPickup ? v.arriveTime : v.depotTime);
      if (endMin != null) {
        rows.push(terminalRow({
          key: `${groupKey}:end`, groupKey, groupLabel, direction: sec.direction,
          label: `${sec.endName} ${isPickup ? "도착" : "복귀"}`,
          subLabel: isPickup && sec.time ? `수업 ${sec.time} 시작` : null,
          minutes: endMin,
        }));
      }
    });
  }
  return rows;
}

function terminalRow(input: {
  key: string; groupKey: string; groupLabel: string | null;
  direction: UnifiedDirection; label: string; subLabel: string | null; minutes: number;
}): UnifiedRow {
  return {
    key: input.key, kind: "SEASONAL", direction: input.direction,
    groupKey: input.groupKey, groupLabel: input.groupLabel,
    label: input.label, subLabel: input.subLabel,
    time: formatHHMM(input.minutes), minutes: input.minutes, seq: 0,
    lat: null, lng: null, isHub: false, isTerminal: true, pending: false, warn: false, riders: [],
  };
}

/** 정규 섹션(DriverClass) → 통합 행. 탑승 체크 키(rowId)는 손대지 않는다. */
export function buildRegularRows(classes: DriverClass[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  for (const c of classes ?? []) {
    // '노선에 없는 승객' 섹션은 조립부가 classTime 을 '#leftover' 로 표시해 준다(제목 문구에 의존하지 않는다).
    const warn = typeof c.classTime === "string" && c.classTime.endsWith("#leftover");
    const groupLabel = c.title ?? `🕒 ${c.classTime} 수업`;
    for (const [key, stops] of [["board", c.board], ["alight", c.alight]] as const) {
      for (const [si, s] of (stops ?? []).entries()) {
        const direction: UnifiedDirection = s.direction === "BOARD" ? "PICKUP" : "DROPOFF";
        const minutes = parseHHMM(s.arriveTime);
        rows.push({
          key: `R:${c.classTime}:${key}:${si}`,
          kind: "REGULAR",
          direction,
          groupKey: `R:${c.classTime}:${key}`,
          groupLabel,
          label: s.label,
          subLabel: null,
          time: formatHHMM(minutes),
          minutes,
          seq: 0,
          lat: s.lat ?? null,
          lng: s.lng ?? null,
          isHub: false,
          isTerminal: false,
          pending: Boolean(c.pending),
          warn,
          riders: (s.rows ?? []).map((r) => ({
            // 정규 저장 키는 시트 정차행 id 라 방향까지 이미 유일하다.
            key: `R:${r.rowId}`,
            checkId: r.rowId,
            kind: "REGULAR" as const,
            direction,
            name: r.name,
            grade: null,
            parentPhone: r.parentPhone ?? null,
            studentPhone: r.studentPhone ?? null,
            absent: Boolean(r.absent),
            absentLabel: r.absentLabel ?? null,
            shuttleNote: r.shuttleNote ?? null,
            // 잠긴 줄만 칸을 붙인다(잠금이 없으면 종전 모양 그대로 — 기존 비교 테스트 보존).
            ...(r.blockedLabel ? { blockedLabel: r.blockedLabel } : {}),
          })),
        });
      }
    }
  }
  return rows;
}

/**
 * 시각 오름차순 정렬. 시각이 없는 줄은 **맨 끝**에 원래 순서대로 모은다.
 * (0시로 취급해 맨 앞에 오면 기사님이 첫 목적지를 오인한다 → 절대 금지)
 */
export function sortUnifiedRows(rows: UnifiedRow[]): UnifiedRow[] {
  return rows
    .map((r, i) => ({ ...r, seq: i }))
    .sort((a, b) => {
      const am = a.minutes, bm = b.minutes;
      if (am == null && bm == null) return a.seq - b.seq;
      if (am == null) return 1;   // 시간 미정 → 뒤로
      if (bm == null) return -1;
      return am === bm ? a.seq - b.seq : am - bm;
    });
}

export type BoardingStatus = "BOARDED" | "NOSHOW" | "SELF";

/**
 * 탑승자 한 명의 «화면에 보이는» 상태.
 *
 * 원장 지시(2026-11-09): 정규 결석 신고 학생은 명단에서 빼지 않고 그대로 두되 «결석» 뱃지를 붙이고
 * 행을 흐리게 한다. 탑승 버튼은 그대로 누를 수 있다(실제로 탔으면 체크). 저장 기록이 없으면 기본 «결석»(NOSHOW).
 *   - absentReported: 정규 결석 신고 학생인가(특강 «결석예정»은 종전대로 체크 대상 — 여기 해당 없음)
 *   - status: 저장된 상태가 있으면 그것, 없으면 결석 학생만 NOSHOW(기본값 · 저장하지 않음)
 *   - absentDefault: 저장 기록 없이 기본 «결석»으로 보이는 중인가(되돌리기 버튼을 띄우지 않는 기준)
 *   - dimmed: 행을 흐리게 할지(결석 신고 + 탑승·자차로 바뀌지 않음)
 */
export function riderBoardingView(
  rider: Pick<UnifiedRider, "kind" | "absent" | "blockedLabel">,
  stored: BoardingStatus | null | undefined,
): { absentReported: boolean; status: BoardingStatus | null; absentDefault: boolean; dimmed: boolean; blocked: boolean } {
  // 원장 지시(2026-11-14): 휴원·퇴원·첫 수업 전·휴무 줄은 명단에 남기되 버튼을 잠근다 — 흐린 행, 기본 상태 없음, 체크 대상 아님.
  const blocked = rider.kind === "REGULAR" && Boolean(rider.blockedLabel);
  const absentReported = !blocked && rider.kind === "REGULAR" && Boolean(rider.absent);
  const saved = stored ?? null;
  const status: BoardingStatus | null = saved ?? (absentReported ? "NOSHOW" : null);
  return {
    absentReported,
    status,
    absentDefault: absentReported && saved == null,
    dimmed: blocked || (absentReported && status !== "BOARDED" && status !== "SELF"),
    blocked,
  };
}

/** 결석 학생 저장 기록이 없을 때 보일 기본 상태(정규 결석 = NOSHOW, 그 외 = 없음). */
export function riderDefaultStatus(rider: Pick<UnifiedRider, "kind" | "absent" | "blockedLabel">): BoardingStatus | null {
  return riderBoardingView(rider, null).status;
}

/**
 * 한 정차의 결석 요약 — 정차 머리에 «결석 N명», 전원이 결석이면 «정차 안 해도 됨»을 띄우는 근거.
 * 같은 학생이 한 정차에 두 번 들어 있어도 키 기준 1명으로 센다.
 */
export function stopAbsenceSummary(
  riders: UnifiedRider[],
  boarding: Record<string, BoardingStatus>,
): { absentCount: number; allSkippable: boolean } {
  const unique = [...new Map(riders.map((rider) => [rider.key, rider])).values()];
  const views = unique.map((rider) => riderBoardingView(rider, boarding[rider.key]));
  return {
    absentCount: views.filter((view) => view.absentReported).length,
    allSkippable: views.length > 0 && views.every((view) => view.dimmed),
  };
}

/** 진행률(중복 탑승건은 키 기준 1건으로 센다 — 헤더 숫자와 행 합이 어긋나지 않게). */
export function countProgress(
  rows: UnifiedRow[],
  boarding: Record<string, BoardingStatus>,
): { total: number; boarded: number; noshow: number; self: number } {
  const seen = new Set<string>();
  let total = 0, boarded = 0, noshow = 0, self = 0;
  for (const row of rows) {
    for (const rider of row.riders) {
      if (seen.has(rider.key)) continue;
      seen.add(rider.key);
      // 잠긴 줄(휴원·휴무 등)은 체크 대상이 아니라 분모에서 뺀다 — «체크 완료»가 영영 안 되는 일을 막는다.
      if (riderBoardingView(rider, boarding[rider.key]).blocked) continue;
      total += 1;
      // 정규 결석 신고 학생은 저장 기록이 없어도 기본 «결석»으로 센다(명단에 남아 있으니 분모에도 들어간다).
      const st = riderBoardingView(rider, boarding[rider.key]).status;
      if (st === "BOARDED") boarded += 1;
      else if (st === "NOSHOW") noshow += 1;
      else if (st === "SELF") self += 1;
    }
  }
  return { total, boarded, noshow, self };
}

/** 통합 목록 조립 — 특강 먼저 만들고 정규를 이어 붙인 뒤 시각순으로 섞는다. */
export function buildUnifiedRun(input: {
  seasonal?: SeasonalSectionInput[];
  regular?: DriverClass[];
}): UnifiedRow[] {
  return sortUnifiedRows([
    ...buildSeasonalRows(input.seasonal ?? []),
    ...buildRegularRows(input.regular ?? []),
  ]);
}

/** 종류별 운행 유무 — 없는 종류는 화면에 아무 것도 그리지 않기 위해 쓴다(빈 섹션 금지). */
export function hasRunOfKind(rows: UnifiedRow[], kind: UnifiedKind): boolean {
  return rows.some((r) => r.kind === kind && !r.isTerminal);
}
