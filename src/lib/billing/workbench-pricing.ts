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
};

export type TuitionPlan = {
  baseAmount: number;
  /** 화면 «근거»에 남길 설명 */
  basis: string | null;
  /** 관리자가 꼭 봐야 할 경고(주N회 요금 빈 칸, 여러 프로그램 수강 등) */
  warning: string | null;
};

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

/**
 * 학생별·프로그램별로 묶어 주N회 요금을 행에 나눠 담는다.
 * 넘기는 등록은 «이번 달 청구 대상(제외되지 않은)» 것만이어야 한다 — 휴원 반까지 세면 주2회로 잘못 오른다.
 * 프로그램 id 가 없거나 주N회 칸이 비면 기존 방식(행마다 p.price)으로 두고 경고를 단다.
 */
export function planWeeklyTuition(enrollments: readonly TuitionEnrollment[]): Map<string, TuitionPlan> {
  const result = new Map<string, TuitionPlan>();
  // 학생 → 프로그램 → 등록 목록 (입력 순서 유지 = 서비스의 studentId,classId 정렬 순서)
  const byStudent = new Map<string, Map<string, TuitionEnrollment[]>>();
  for (const e of enrollments) {
    const programs = byStudent.get(e.studentId) ?? new Map<string, TuitionEnrollment[]>();
    const groupKey = e.programId ?? `no-program:${e.key}`; // 프로그램을 모르면 묶지 않는다
    programs.set(groupKey, [...(programs.get(groupKey) ?? []), e]);
    byStudent.set(e.studentId, programs);
  }
  for (const programs of byStudent.values()) {
    // 여러 프로그램(예: 주말경기반 + 주중경기반)을 함께 다니면 랠리즈는 합산 요금을 쓴 사례가 있어 자동으로 확정하지 않는다.
    const mixed = programs.size > 1
      ? `여러 프로그램을 함께 수강합니다(${[...programs.values()].map(g => `${g[0].programName ?? "프로그램"} 주${g.length}회`).join(" + ")}). 프로그램별 요금을 더한 값이라 합산 할인 여부를 확인해 주세요.`
      : null;
    for (const group of programs.values()) {
      const count = group.length;
      const tier = weeklyTierPrice(group[0], count);
      if (tier === null) {
        // 주N회 요금 빈 칸 → 기존 방식(반마다 주1회 요금). 과다 청구 가능성이 있어 반드시 경고.
        for (const e of group) result.set(e.key, {
          baseAmount: e.price,
          basis: count > 1 ? `주${count}회 요금 미설정 → 주1회 요금 ${won(e.price)} × ${count}반` : null,
          warning: count > 1 ? `${e.programName ?? "프로그램"} 주${count}회 요금이 비어 있어 주1회 요금 × ${count}반으로 계산했습니다. 프로그램 요금을 확인해 주세요.` : mixed,
        });
        continue;
      }
      const parts = splitTierPrice(tier, count);
      group.forEach((e, i) => result.set(e.key, {
        baseAmount: parts[i],
        basis: count > 1 ? `주${count}회 요금 ${won(tier)} ÷ ${count}반` : null,
        warning: mixed,
      }));
    }
  }
  return result;
}

// ── 셔틀비 ────────────────────────────────────────────────

/** 프로그램 화면 «자동 계산» 표와 같은 값(ProgramFormPanel.tsx SHUTTLE 표). 주 수업 횟수 → 월 셔틀비. */
export const AUTO_SHUTTLE_FEE_BY_WEEKLY_COUNT: readonly number[] = [0, 10_000, 15_000, 20_000];
/** 주말 수업은 셔틀을 운행하지 않는다(프로그램 화면 규칙). */
const WEEKEND_DAYS = new Set(["Sat", "Sun"]);
/** 일8 대표팀은 다른 요일 셔틀을 타도 월 셔틀비 전체 면제(studentBilling.ts FULL_SHUTTLE_FEE_EXEMPT_SLOT_KEYS 와 같은 값). */
export const FULL_SHUTTLE_FEE_EXEMPT_SLOT_KEYS: ReadonlySet<string> = new Set(["Sun-8"]);

/** 셔틀비 판단에 쓰는 «이번 달 청구 대상 등록» 한 건 */
export type ShuttleEnrollment = {
  dayOfWeek: string;
  slotKey: string | null;
  runsShuttle: boolean;
  /** 프로그램 «셔틀비 직접 입력». null=자동 계산, 0=셔틀비 없음 */
  shuttleFeeOverride: number | null;
};

export type ShuttlePlan = { amount: number; basis: string | null; warning: string | null };

/**
 * 그 달 셔틀 명단에 있는 학생의 월 셔틀비 제안값.
 * - 명단에 없으면 0(제안 없음).
 * - 셔틀비 면제 반(일8 대표팀)에 다니면 0.
 * - 셔틀 운행 반(평일·runsShuttle·직접입력 0 아님)의 주 수업 횟수로 10,000/15,000/20,000.
 * - 그 반들의 프로그램에 «직접 입력» 셔틀비가 있으면 그중 큰 값.
 */
export function planShuttleFee(onRoster: boolean, enrollments: readonly ShuttleEnrollment[]): ShuttlePlan {
  if (!onRoster) return { amount: 0, basis: null, warning: null };
  if (enrollments.some(e => e.slotKey && FULL_SHUTTLE_FEE_EXEMPT_SLOT_KEYS.has(e.slotKey))) {
    return { amount: 0, basis: "셔틀 명단 있음 · 일8 대표팀 셔틀비 면제", warning: null };
  }
  const eligible = enrollments.filter(e => e.runsShuttle && !WEEKEND_DAYS.has(e.dayOfWeek) && e.shuttleFeeOverride !== 0);
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
