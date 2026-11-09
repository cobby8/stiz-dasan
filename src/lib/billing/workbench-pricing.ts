/**
 * 청구 준비(workbench)의 «자동 제안값» 계산 — 외부 의존성 0 인 순수 함수만 둔다.
 *
 * 왜 따로 떼어냈나:
 *   돈이 걸린 계산이라 DB 없이 테스트로 못박아야 한다. workbench-service.ts 는 DB 조회와
 *   행 조립을 맡고, «얼마를 제안할지»는 전부 여기서만 정한다(규칙이 두 곳에 갈라지지 않게).
 *
 * 여기서 만든 값은 «제안값»이다. 관리자가 행에서 고쳐 저장하면 저장값이 우선한다
 * (서비스가 저장 초안 payload 로 덮어쓴다). 확정 월 장부가 있는 행에도 적용하지 않는다.
 *
 * 근거(2026-11-08 운영 DB 대조 — 랠리즈 11월 청구 사본):
 *   - 주2·3회: 프로그램의 주N회 요금을 반(행) 수로 균등 분배. 예) 주중취미 주2회 160,000 → 80,000 × 2,
 *     주중취미 주3회 210,000 → 70,000 × 3, 주중경기 주2회 180,000 → 90,000 × 2.
 *   - 셔틀비: 주1회 10,000 / 주2회 15,000 / 주3회 이상 20,000(프로그램 화면의 «자동 계산» 표와 같다).
 *     횟수는 «셔틀 탑승 요일 수»가 아니라 «셔틀 운행 반의 주 수업 횟수»다
 *     (김민재·윤수영: 주2회 수업·명단 1일 → 11월 15,000원).
 *   - 형제할인: 형제 «전원» 각각 10%(김루나·김루희 둘 다 90,000, 정우준·정지유 주3회 240,000 → 216,000).
 *     방학특강 정책(src/lib/seasonal/sibling-discount.ts)도 «형제 전원 각각 10%·셔틀비 제외·원 단위 절사».
 */

/** 프로그램 요금 칸(Program 표 그대로). 빈 칸은 null. */
export type ProgramPrices = {
  price: number;
  priceWeek1: number | null;
  priceWeek2: number | null;
  priceWeek3: number | null;
  priceDaily: number | null;
};

/** 기본 금액 계산에 쓰는 «이번 달 청구 대상 등록» 한 건 */
export type TuitionEnrollment = ProgramPrices & {
  /** 행 식별자(studentId:classId) */
  key: string;
  studentId: string;
  programId: string | null;
  programName?: string | null;
  /** 반 요일(Mon~Sun). 대회준비반 «주말 훈련» 판별에 쓴다. 없으면 주말 아님으로 본다. */
  dayOfWeek?: string | null;
};

export type TuitionPlan = {
  baseAmount: number;
  /** 화면 «근거»에 남길 설명 */
  basis: string | null;
  /** 관리자가 꼭 봐야 할 경고(주N회 요금 빈 칸, 여러 프로그램 수강 등) */
  warning: string | null;
  /**
   * 고정 요금 행(대회준비반 30만 원 묶음·평일만 15만 원) — 형제할인·3회 달 차감을 붙이지 않는다.
   * 원장 결정(2026-11-09 «월 30만 원 고정»). 서비스는 이 값이 true 면 할인·기간 조정 제안을 0 으로 둔다.
   */
  fixedFee?: boolean;
};

/** 고정 요금 행의 근거 문구 — 화면·테스트가 같은 문장을 쓴다. */
export const FIXED_FEE_NOTE = "고정 요금 — 형제할인·3회 달 차감 없음";

const won = (n: number) => `${n.toLocaleString("ko-KR")}원`;
const validAmount = (v: number | null | undefined): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * 같은 프로그램을 주 N회 다닐 때의 «한 달 전체» 요금. 빈 칸이면 null(호출부가 기존 방식으로 떨어진다).
 * N=1 은 지금까지처럼 p.price 를 쓴다(운영 데이터상 price = priceWeek1 이고, 기존 동작을 바꾸지 않기 위해).
 * N≥5 는 «매일반» 요금, N=4 는 해당 칸이 없어 null.
 */
export function weeklyTierPrice(program: ProgramPrices, count: number): number | null {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (count === 1) return validAmount(program.price) ? program.price : null;
  if (count === 2) return validAmount(program.priceWeek2) ? program.priceWeek2 : null;
  if (count === 3) return validAmount(program.priceWeek3) ? program.priceWeek3 : null;
  if (count >= 5) return validAmount(program.priceDaily) ? program.priceDaily : null;
  return null;
}

/** 한 달 요금을 행 수만큼 나눈다. 나누어떨어지지 않으면 남는 원은 첫 행에 붙인다(합계가 정확히 요금과 같게). */
export function splitTierPrice(total: number, parts: number): number[] {
  if (!Number.isSafeInteger(total) || total < 0 || !Number.isInteger(parts) || parts <= 0) return [];
  const each = Math.floor(total / parts);
  const rest = total - each * parts;
  return Array.from({ length: parts }, (_, i) => each + (i === 0 ? rest : 0));
}

/** 주말 요일. 대회준비반 «주말 훈련» 판별과 셔틀 미운행(주말 수업) 판단에 같이 쓴다. */
const WEEKEND_DAYS = new Set(["Sat", "Sun"]);

// ── 대회준비반 ─────────────────────────────────────────────
/**
 * 대회준비반 판별 = 프로그램 이름(앞뒤 공백 제거 후 정확히 일치). 이 상수 한 곳에서만 정한다.
 * 운영 DB(2026-11-09) Program «대회준비반»(id 88dbc742-…) — 반: 수요일 7교시(Wed-7)·일요일 8교시(Sun-8, 일8 대표팀).
 *
 * 원장 결정(2026-11-09 원문): «대회준비반은 현재 휴강 중, 월 30만원 고정, 주말 대회준비반 훈련 필수 +
 * 수요일 7교시 대회준비반 훈련 필수 + 추가로 다른 일반 반 중 1회 선택».
 * → 주말 대회준비반 반이 있는 학생 = 30만원 묶음(대회준비반 반 전부 + 일반 반 1개).
 *   주말 훈련 없이 평일 대회준비반만 다니는 학생 = 월 150,000원 고정(COMPETITION_WEEKDAY_ONLY_FEE).
 *   근거: 10~11월 «수요일 7교시만» 수강생(임지호·이지민·박하준)을 원장이 건별로 15만 원 처리 → 2026-11-09 원장 확정.
 *   평일 대회준비반 + 일반 반이 함께 있으면 대회준비반 행만 150,000원 고정, 일반 반은 일반 규칙(N 에 대회준비반 행 제외) + 확인 경고.
 * 두 고정 요금 모두 형제할인·3회 달 차감을 붙이지 않는다(원장 확정 «월 30만 원 고정»).
 */
export const COMPETITION_PROGRAM_NAMES: ReadonlySet<string> = new Set(["대회준비반"]);
/** 대회준비반 묶음 월 요금(원장 결정 «월 30만원 고정»). */
export const COMPETITION_PACKAGE_FEE = 300_000;
/** 묶음에 포함되는 일반 반 개수(원장 결정 «다른 일반 반 중 1회 선택»). */
export const COMPETITION_INCLUDED_GENERAL_CLASSES = 1;
/** 주말 훈련 없이 평일(수요일) 대회준비반만 다니는 학생의 월 요금(원장 확정 2026-11-09). */
export const COMPETITION_WEEKDAY_ONLY_FEE = 150_000;

export function isCompetitionProgram(programName: string | null | undefined): boolean {
  return COMPETITION_PROGRAM_NAMES.has((programName ?? "").trim());
}

/** 경고 문장 여러 개를 하나로(빈 값은 버린다). */
const joinWarnings = (...items: Array<string | null | undefined>): string | null => {
  const list = items.filter((v): v is string => Boolean(v));
  return list.length ? list.join(" ") : null;
};

/**
 * 일반 규칙: 학생의 청구 대상 반 «전체» 주 횟수 N(프로그램 무관)으로 각 반 프로그램의 주N회 요금 ÷ N.
 * 원장 결정(2026-11-09 원문): «주중경기반 1회 + 주말경기반 1회면 총 주2회 수강이니 각 프로그램의 주2회 요금에
 * 해당하는 금액으로 계산. 주중경기반 8만, 주말경기반 9만이면 17만».
 * - 반마다 원 단위 절사, 프로그램별 절사로 남는 원은 학생의 첫 행에 붙인다(한 프로그램만 다니면 합계 = 주N회 요금 그대로).
 * - 그 프로그램의 주N회 칸이 비면 기존 방식(그 반은 주1회 요금)으로 두고 경고한다.
 * - 프로그램을 모르는 등록(programId 없음)은 N 에 세지 않고 주1회 요금 그대로 둔다(기존 동작).
 */
function planGeneralRows(rows: readonly TuitionEnrollment[], result: Map<string, TuitionPlan>, extraWarning: string | null) {
  for (const e of rows.filter(r => !r.programId)) result.set(e.key, { baseAmount: e.price, basis: null, warning: extraWarning });
  const known = rows.filter(r => r.programId);
  if (!known.length) return;
  const n = known.length;
  // 프로그램 → 등록 목록 (입력 순서 유지 = 서비스의 studentId,classId 정렬 순서)
  const groups = new Map<string, TuitionEnrollment[]>();
  for (const e of known) groups.set(e.programId!, [...(groups.get(e.programId!) ?? []), e]);
  const label = (e: TuitionEnrollment) => e.programName ?? "프로그램";
  // 여러 프로그램이면 «어떻게 N 을 셌는지»를 근거에 적는다(예전의 «여러 프로그램 수강» 경고를 대신한다).
  const summary = groups.size > 1 ? `여러 프로그램 합산 주${n}회(${[...groups.values()].map(g => `${label(g[0])} 주${g.length}회`).join(" + ")})` : null;
  let remainder = 0;
  for (const group of groups.values()) {
    const tier = weeklyTierPrice(group[0], n);
    if (tier === null) {
      // 주N회 요금 빈 칸 → 기존 방식(반마다 주1회 요금). 과다 청구 가능성이 있어 반드시 경고.
      for (const e of group) result.set(e.key, {
        baseAmount: e.price,
        basis: n > 1 ? `${summary ? `${summary} · ` : ""}${label(e)} 주${n}회 요금 미설정 → 주1회 요금 ${won(e.price)} × ${group.length}반` : null,
        warning: joinWarnings(n > 1 ? `${label(e)} 주${n}회 요금이 비어 있어 주1회 요금 × ${group.length}반으로 계산했습니다. 프로그램 요금을 확인해 주세요.` : null, extraWarning),
      });
      continue;
    }
    const each = Math.floor(tier / n);
    // 이 프로그램 몫(반 수 × 요금 ÷ N, 원 단위 절사)과 반별 절사 합의 차이 = 첫 행에 붙일 남는 원
    remainder += Math.floor((tier * group.length) / n) - each * group.length;
    for (const e of group) result.set(e.key, {
      baseAmount: each,
      basis: summary ? `${summary} → ${label(e)} 주${n}회 요금 ${won(tier)} ÷ ${n}` : n > 1 ? `주${n}회 요금 ${won(tier)} ÷ ${n}반` : null,
      warning: extraWarning,
    });
  }
  if (remainder > 0) {
    const first = result.get(known[0].key)!;
    result.set(known[0].key, { ...first, baseAmount: first.baseAmount + remainder });
  }
}

/**
 * 학생별로 수강료 제안값을 정한다.
 * 넘기는 등록은 «이번 달 청구 대상(제외되지 않은)» 것만이어야 한다 — 휴원 반까지 세면 주N회가 잘못 오른다.
 * 1) 주말 대회준비반 반이 있으면 대회준비반 묶음(30만원 고정, 첫 대회준비반 행에 몰고 나머지 0원).
 * 2) 평일 대회준비반만 있으면 대회준비반 행 15만원 고정 + 일반 반은 일반 규칙(대회준비반 제외 N).
 * 3) 그 밖에는 일반 규칙(학생 전체 주 횟수 N 기준 주N회 요금 ÷ N).
 */
export function planWeeklyTuition(enrollments: readonly TuitionEnrollment[]): Map<string, TuitionPlan> {
  const result = new Map<string, TuitionPlan>();
  // 학생 → 등록 목록 (입력 순서 유지)
  const byStudent = new Map<string, TuitionEnrollment[]>();
  for (const e of enrollments) byStudent.set(e.studentId, [...(byStudent.get(e.studentId) ?? []), e]);
  for (const rows of byStudent.values()) {
    const comp = rows.filter(e => isCompetitionProgram(e.programName));
    const general = rows.filter(e => !isCompetitionProgram(e.programName));
    const isWeekend = (e: TuitionEnrollment) => WEEKEND_DAYS.has(e.dayOfWeek ?? "");
    if (comp.some(isWeekend)) {
      // 대회준비반 묶음: 대회준비반 반 전부 + 일반 반 1개까지 합계 300,000원.
      const packageBasis = `대회준비반 월 ${won(COMPETITION_PACKAGE_FEE)} 고정(주말·수요일 대회준비반 훈련 + 일반 반 ${COMPETITION_INCLUDED_GENERAL_CLASSES}회 포함) · ${FIXED_FEE_NOTE}`;
      const missingWeekday = comp.every(isWeekend)
        ? "대회준비반 수요일 7교시 훈련(필수) 등록이 없습니다. 수강 반을 확인해 주세요." : null;
      comp.forEach((e, i) => result.set(e.key, {
        baseAmount: i === 0 ? COMPETITION_PACKAGE_FEE : 0,
        basis: i === 0 ? packageBasis : `${packageBasis} — 금액은 첫 대회준비반 행에 포함`,
        warning: missingWeekday,
        fixedFee: true, // 묶음 행 — 형제할인·3회 달 차감 없음
      }));
      const included = general.slice(0, COMPETITION_INCLUDED_GENERAL_CLASSES);
      const extra = general.slice(COMPETITION_INCLUDED_GENERAL_CLASSES);
      for (const e of included) result.set(e.key, { baseAmount: 0, basis: `${packageBasis} — 포함된 일반 반(0원)`, warning: missingWeekday, fixedFee: true });
      if (extra.length) {
        // 일반 반이 2개 이상이면 1개만 묶음에 넣고 나머지는 일반 규칙(그 반들의 주 횟수 기준)으로 계산한다.
        planGeneralRows(extra, result, joinWarnings(missingWeekday,
          `대회준비반 학생이 일반 반을 ${general.length}개 수강합니다. ${COMPETITION_INCLUDED_GENERAL_CLASSES}개는 ${won(COMPETITION_PACKAGE_FEE)}에 포함하고 나머지 ${extra.length}개는 일반 요금으로 계산했습니다. 확인해 주세요.`));
      }
      continue;
    }
    if (comp.length) {
      // 주말 훈련 없이 평일 대회준비반만: 대회준비반 행 합계 150,000원 고정(첫 행에 몰고 나머지 0원).
      const weekdayBasis = `대회준비반 평일(수요일)만 월 ${won(COMPETITION_WEEKDAY_ONLY_FEE)} 고정 · ${FIXED_FEE_NOTE}`;
      comp.forEach((e, i) => result.set(e.key, {
        baseAmount: i === 0 ? COMPETITION_WEEKDAY_ONLY_FEE : 0,
        basis: i === 0 ? weekdayBasis : `${weekdayBasis} — 금액은 첫 대회준비반 행에 포함`,
        warning: null,
        fixedFee: true,
      }));
      // 일반 반이 함께 있으면 일반 규칙으로 따로 계산한다(주 횟수 N 에 대회준비반 행은 넣지 않는다) + 확인 경고.
      if (general.length) {
        planGeneralRows(general, result,
          `평일 대회준비반(${won(COMPETITION_WEEKDAY_ONLY_FEE)} 고정)과 일반 반 ${general.length}개를 함께 수강합니다. 일반 반은 일반 요금으로 따로 계산했습니다. 확인해 주세요.`);
      }
      continue;
    }
    planGeneralRows(rows, result, null);
  }
  return result;
}

// ── 셔틀비 ────────────────────────────────────────────────

/** 프로그램 화면 «자동 계산» 표와 같은 값(ProgramFormPanel.tsx SHUTTLE 표). 주 수업 횟수 → 월 셔틀비. */
export const AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT: readonly number[] = [0, 10_000, 15_000, 20_000];
/** 일8 대표팀은 다른 요일 셔틀을 타도 월 셔틀비 전체 면제(studentBilling.ts FULL_SHUTTLE_FEE_EXEMPT_SLOT_KEYS 와 같은 값). */
export const FULL_SHUTTLE_FEE_EXEMPT_SLOT_KEYS: ReadonlySet<string> = new Set(["Sun-8"]);

/**
 * 그 반에 셔틀이 다니는가 — «셔틀 운행 반» 판정은 이 함수 한 곳에서만 한다.
 * 기준: 프로그램 «셔틀 운행»(Program.runsShuttle)이 켜져 있고 평일(월~금) 반.
 *   - 주말 반(토요일 «통쾌한 주말경기반», 일8 대표팀 등)과 성인반은 셔틀을 운행하지 않는다.
 * 같이 쓰는 곳(«같은 규칙 두 경로» 방지 — 한쪽만 고치지 말 것):
 *   - 청구 셔틀비(regularShuttlePlan) — 운행 반 수로 주N회 셔틀비
 *   - 신규 배차 학생 «남은 칸»(src/lib/shuttle/driverAssign.ts) — 기사님 새 학생 배정·관리자 정규 배차
 *   - 셔틀 신청 검토(src/lib/enrollment/shuttle-review-query.ts)·배차 진행 표시(shuttle-progress-query.ts)
 * runsShuttle 이 비어 있으면(null/undefined) 운행하지 않는 것으로 본다 — 조회에서 빠뜨린 경우 칸이 생기지 않게.
 */
export function classRunsShuttle(c: { dayOfWeek: string | null | undefined; runsShuttle?: boolean | null }): boolean {
  return c.runsShuttle === true && !WEEKEND_DAYS.has(c.dayOfWeek ?? "");
}

/** 셔틀비 판단에 쓰는 «이번 달 청구 대상 등록» 한 건 */
export type ShuttleEnrollment = {
  dayOfWeek: string;
  slotKey: string | null;
  runsShuttle: boolean;
  /** 프로그램 «셔틀비 직접 입력». null=자동 계산, 0=셔틀비 없음 */
  shuttleFeeOverride: number | null;
};

export type ShuttlePlan = { amount: number; basis: string | null; warning: string | null };

/** 셔틀 명단(RegularShuttleStop)에서 그 학생이 타고 내리는 정류장 한 건 */
export type ShuttleStopUse = { direction: string; stopName: string };

/**
 * 정규 셔틀 «무료 거점» 정류장 이름 — 이 상수 한 곳에서만 정한다(띄어쓰기는 무시하고 비교).
 *
 * 근거:
 *   - 원장(2026-11-09): «1호점 앞 버스정류장에서 타는 학생은 무료거점에서 타는 거라 셔틀비 안 받아».
 *   - 코덱스 지식 `.Codex/knowledge/conventions.md` [2026-09-02] «정규 무료셔틀은 시트 구분값으로 청구에서 제외»:
 *     `1호점 앞 버스정류장` 승차 학생은 정규 셔틀 명단에는 포함하지만 셔틀비를 받지 않는다.
 *   - 옛 시트 가져오기(src/lib/studentBilling.ts hasFullShuttleFeeExemption): `셔틀비 구분=무료셔틀` 이면 학생 월 셔틀비 전체 0.
 *   - 하원 하차 지점: 무료 거점의 하차는 길 건너 버스정류장(AcademySettings.shuttleHubDropoffName «새봄중 앞 버스정류장»,
 *     migration 20260728000000_add_shuttle_hub_dropoff). 정규 명단에서는 «새봄중학교 앞 버스정류장» 하차로 적힌다.
 *     단, 이 정류장은 일반 승차 학생도 내리는 곳이라(12월 명단: 이도경·이윤건) «거점 승차가 있는 학생»에게만 무료로 본다.
 * 운영 명단(2026-11·12)에서 «1호점 앞 버스정류장»은 승차(BOARD)로만 쓰인다.
 */
export const FREE_SHUTTLE_HUB_STOPS: Readonly<{ board: readonly string[]; alight: readonly string[] }> = {
  board: ["1호점 앞 버스정류장"],
  alight: ["새봄중학교 앞 버스정류장"],
};
const stopKey = (name: string | null | undefined) => (name ?? "").replace(/\s+/g, "");
const isHubBoard = (s: ShuttleStopUse) => s.direction === "BOARD" && FREE_SHUTTLE_HUB_STOPS.board.some(n => stopKey(n) === stopKey(s.stopName));
const isHubAlight = (s: ShuttleStopUse) => s.direction === "ALIGHT" && FREE_SHUTTLE_HUB_STOPS.alight.some(n => stopKey(n) === stopKey(s.stopName));

/**
 * 그 달 셔틀 명단에 있는 학생의 월 셔틀비 제안값.
 * - 명단에 없으면 0(제안 없음).
 * - 셔틀비 면제 반(일8 대표팀)에 다니면 0.
 * - 무료 거점: 명단의 승차가 전부 «1호점 앞 버스정류장»이고 하차가 거점 하차(또는 없음)뿐이면 0.
 *   거점 승차와 일반 정류장 이용이 섞여 있으면 아래 일반 셔틀비를 제안하되 확인 경고를 단다.
 * - 셔틀 운행 반(평일·runsShuttle·직접입력 0 아님)의 주 수업 횟수로 10,000/15,000/20,000.
 * - 그 반들의 프로그램에 «직접 입력» 셔틀비가 있으면 그중 큰 값.
 */
export function planShuttleFee(onRoster: boolean, enrollments: readonly ShuttleEnrollment[], stops: readonly ShuttleStopUse[] = []): ShuttlePlan {
  if (!onRoster) return { amount: 0, basis: null, warning: null };
  if (enrollments.some(e => e.slotKey && FULL_SHUTTLE_FEE_EXEMPT_SLOT_KEYS.has(e.slotKey))) {
    return { amount: 0, basis: "셔틀 명단 있음 · 일8 대표팀 셔틀비 면제", warning: null };
  }
  const usesHub = stops.some(isHubBoard);
  if (usesHub && stops.every(s => isHubBoard(s) || isHubAlight(s))) {
    return { amount: 0, basis: `셔틀 명단 있음 · 무료 거점(${FREE_SHUTTLE_HUB_STOPS.board[0]}) 승차 — 셔틀비 없음`, warning: null };
  }
  const plan = regularShuttlePlan(enrollments);
  if (!usesHub) return plan;
  // 거점 승차가 있지만 다른 정류장도 이용 — 일부 요일만 유료인지 원장 확인이 필요하다.
  const hubNote = `셔틀 명단에서 무료 거점(${FREE_SHUTTLE_HUB_STOPS.board[0]}) 승차와 다른 정류장 이용이 섞여 있어 일반 셔틀비를 제안했습니다. 셔틀비를 받을지 확인해 주세요.`;
  return { ...plan, warning: plan.warning ? `${plan.warning} ${hubNote}` : hubNote };
}

/** 무료 거점·면제 판단 뒤의 일반 셔틀비(주 수업 횟수표 또는 프로그램 지정값). */
function regularShuttlePlan(enrollments: readonly ShuttleEnrollment[]): ShuttlePlan {
  // 셔틀 운행 반(공용 판정) 중 «셔틀비 없음(직접 입력 0)»이 아닌 반만 센다.
  const eligible = enrollments.filter(e => classRunsShuttle(e) && e.shuttleFeeOverride !== 0);
  if (!eligible.length) {
    return { amount: 0, basis: null, warning: "셔틀 명단에 있지만 셔틀을 운행하는 평일 반이 없어 셔틀비를 제안하지 않았습니다. 확인해 주세요." };
  }
  const overrides = eligible.map(e => e.shuttleFeeOverride).filter(validAmount);
  if (overrides.length) {
    const amount = Math.max(...overrides);
    return { amount, basis: `셔틀 명단 있음 · 프로그램 지정 셔틀비 ${won(amount)}`, warning: null };
  }
  const count = Math.min(eligible.length, AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT.length - 1);
  const amount = AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT[count];
  return { amount, basis: `셔틀 명단 있음 · 주${eligible.length}회 셔틀비 ${won(amount)}`, warning: null };
}

// ── 형제할인 ──────────────────────────────────────────────

/** 형제할인율(원장 지시 2026-11-08 «형제할인 10%, 셔틀비는 할인 대상에서 제외»). */
export const REGULAR_SIBLING_DISCOUNT_PERCENT = 10;
/**
 * 누구에게 적용하나. «ALL» = 형제 전원 각각(현재 운영 관례·특강 정책과 같음).
 * «SECOND_AND_LATER» 로 바꾸면 첫째(생일이 가장 빠른 자녀)를 빼고 둘째부터 할인한다.
 */
export type SiblingDiscountTarget = "ALL" | "SECOND_AND_LATER";
export const REGULAR_SIBLING_DISCOUNT_TARGET: SiblingDiscountTarget = "ALL";

export type SiblingCandidate = { studentId: string; parentId: string | null; birthDate: string | null; name: string };

/**
 * 형제할인을 받을 학생 id 집합.
 * 넘기는 학생은 «이번 달 청구 대상 반이 하나 이상 있는 재원생»이어야 한다(휴원·퇴원 형제는 세지 않는다).
 * 같은 학부모(parentId) 자녀가 2명 이상일 때만 대상이다.
 */
export function siblingDiscountStudents(
  students: readonly SiblingCandidate[],
  target: SiblingDiscountTarget = REGULAR_SIBLING_DISCOUNT_TARGET,
): Set<string> {
  const byParent = new Map<string, SiblingCandidate[]>();
  for (const s of students) {
    if (!s.parentId) continue; // 학부모 연결이 없으면 형제를 알 수 없다
    const list = byParent.get(s.parentId) ?? [];
    if (!list.some(x => x.studentId === s.studentId)) list.push(s); // 반이 여러 개여도 학생은 한 번만
    byParent.set(s.parentId, list);
  }
  const result = new Set<string>();
  for (const kids of byParent.values()) {
    if (kids.length < 2) continue;
    // 첫째 = 생일이 가장 빠른 자녀(생일 없으면 뒤로), 같으면 이름순 — «둘째부터» 설정일 때만 쓴다.
    const ordered = [...kids].sort((a, b) =>
      (a.birthDate ?? "9999").localeCompare(b.birthDate ?? "9999") || a.name.localeCompare(b.name, "ko") || a.studentId.localeCompare(b.studentId));
    ordered.forEach((kid, i) => { if (target === "ALL" || i > 0) result.add(kid.studentId); });
  }
  return result;
}

/** 수강료(기본 금액)에만 거는 형제할인액. 원 단위 절사. 셔틀비는 절대 넣지 않는다. */
export function siblingDiscountAmount(baseAmount: number, percent = REGULAR_SIBLING_DISCOUNT_PERCENT): number {
  if (!Number.isSafeInteger(baseAmount) || baseAmount <= 0) return 0;
  return Math.floor((baseAmount * percent) / 100);
}
