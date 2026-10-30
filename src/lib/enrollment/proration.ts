/**
 * 반을 옮길 때의 수강료 일할 계산.
 *
 * 원장 결정(2026-08-09): **수업 회차 기준**.
 * 이 학원은 주 1회 월정액이라 날짜(30일)로 나누면 실제와 어긋난다.
 *
 * ★ 나누는 기준은 "달력에 그 요일이 몇 번 있는가"가 아니라 **연간 계획표의 실제 수업일**이다.
 *   원장이 구글 캘린더에 "N월 M주차"를 넣어 **월별 요일당 4회로 맞춰** 운영한다.
 *   달력만 세면 9월 화요일은 5회로 잡혀 회당 단가가 실제보다 싸게 계산된다.
 *   계획표에 그달 수업일이 없으면 **추측하지 않고** 계산 불가로 알린다(돈이라서).
 *
 * ★ 회당 단가 = 정가 ÷ 4 (원장 결정 2026-10-30).
 *   정가는 월 4회 기준이고, 3회인 달(설 주간·연휴)은 청구 작업대가 1회분을 빼고 청구한다.
 *   그달 횟수(3)로 나누면 회당이 33% 비싸진다. 5회 이상 잡힌 달만 그 횟수로 나눈다.
 *
 * 화면·서버가 각자 계산하면 안 된다. 여기 한 곳에서만 계산한다.
 */

/** 정가가 기준으로 삼는 한 달 수업 횟수 — billing/workbench.ts 의 STANDARD_MONTHLY_SESSIONS 와 같아야 한다. */
export const STANDARD_MONTHLY_SESSIONS = 4;

/** 회당 단가를 나눌 횟수. 4회 미만인 달도 정가는 4회 기준이라 4로 나눈다. */
export function sessionDivisor(totalSessions: number): number {
  return Math.max(totalSessions, STANDARD_MONTHLY_SESSIONS);
}

export type ClassFee = {
  /** 그 반의 한 달 수강료(Program.price) */
  monthlyFee: number;
  /** 연간 계획표에서 뽑은 그달 수업일(YYYY-MM-DD). 비어 있으면 계산할 수 없다. */
  classDates: string[];
};

export type ProrationResult = {
  /** 일할 계산이 필요한지. 달 1일부터 바뀌면 그냥 다음 달을 새 요금으로 청구하면 된다. */
  needsProration: boolean;
  /** 계획표에 그달 수업일이 없어 계산할 수 없는 상태. 이때 금액은 모두 0이다. */
  scheduleUnavailable: boolean;
  yearMonth: string;
  fromTotalSessions: number;
  fromRemainingSessions: number;
  /** 기존 반에서 빼야 할 금액(안 듣는 회차) */
  fromCredit: number;
  toTotalSessions: number;
  toRemainingSessions: number;
  /** 새 반에서 더해야 할 금액(듣게 되는 회차) */
  toCharge: number;
  /** 양수면 추가 청구, 음수면 다음 달 청구에서 차감 */
  diff: number;
};

/** 원 단위로 맞춘다. 학부모에게 보이는 금액이라 소수점을 남기지 않는다. */
function toWon(value: number): number {
  return Math.round(value);
}

/** 그달 수업일 중 기준일 이후(당일 포함) 남은 회차 */
export function countRemaining(classDates: string[], from: string): number {
  return classDates.filter((date) => date >= from).length;
}

export function computeClassChangeProration(input: {
  /** 반이 바뀌는 날(YYYY-MM-DD). 이 날부터 새 반 수업을 듣는다. */
  effectiveFrom: string;
  from: ClassFee;
  to: ClassFee;
}): ProrationResult {
  const yearMonth = input.effectiveFrom.slice(0, 7);
  const day = Number(input.effectiveFrom.split("-")[2]);

  const fromTotal = input.from.classDates.length;
  const toTotal = input.to.classDates.length;
  // 변경일 당일부터 새 반을 듣고, 기존 반은 그날부터 안 듣는다. 기준을 같은 날로 맞춰야
  // 하루가 양쪽에 이중으로 잡히거나 비지 않는다.
  const fromRemaining = countRemaining(input.from.classDates, input.effectiveFrom);
  const toRemaining = countRemaining(input.to.classDates, input.effectiveFrom);

  // 달 1일부터면 그 달 전체가 새 반이다. 일할이 아니라 그냥 새 요금으로 청구하면 된다.
  const needsProration = day !== 1;
  // 계획표가 없으면 회당 단가를 알 수 없다. 추측해서 청구하면 안 된다.
  const scheduleUnavailable = needsProration && (fromTotal === 0 || toTotal === 0);
  const computable = needsProration && !scheduleUnavailable;

  const fromCredit = computable ? toWon((input.from.monthlyFee / sessionDivisor(fromTotal)) * fromRemaining) : 0;
  const toCharge = computable ? toWon((input.to.monthlyFee / sessionDivisor(toTotal)) * toRemaining) : 0;

  return {
    needsProration,
    scheduleUnavailable,
    yearMonth,
    fromTotalSessions: fromTotal,
    fromRemainingSessions: computable ? fromRemaining : 0,
    fromCredit,
    toTotalSessions: toTotal,
    toRemainingSessions: computable ? toRemaining : 0,
    toCharge,
    diff: toCharge - fromCredit,
  };
}

/** 원장 화면에 그대로 쓰는 설명. 근거를 보여줘야 원장이 숫자를 믿고 발행할 수 있다. */
export function describeProration(result: ProrationResult, names: { from: string; to: string }): string[] {
  if (!result.needsProration) {
    return [`${result.yearMonth} 1일부터 바뀌므로 일할 계산이 없습니다. 다음 청구부터 새 반 요금으로 발행하세요.`];
  }
  if (result.scheduleUnavailable) {
    return [
      `${result.yearMonth} 수업일이 연간 계획표에 없어 자동 계산할 수 없습니다.`,
      "구글 캘린더에 그달 주차 일정을 넣은 뒤 다시 확인하거나, 금액을 직접 입력해 발행하세요.",
    ];
  }
  return [
    `${names.from}: 계획표상 그달 ${result.fromTotalSessions}회 중 남은 ${result.fromRemainingSessions}회 → ${result.fromCredit.toLocaleString()}원 빼기`,
    `${names.to}: 계획표상 그달 ${result.toTotalSessions}회 중 듣는 ${result.toRemainingSessions}회 → ${result.toCharge.toLocaleString()}원 더하기`,
  ];
}
