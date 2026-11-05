// 학생 총 재원기간 계산 — 순수 함수(DB·시계 의존 0)
//
// 왜 이렇게 나누나: 옛 구글시트 시절 기록은 DB 에 없다. 그래서 원장이 학생마다
// «기준월까지 실제로 다닌 달 수(baseline)» 를 한 번 넣고, 그 뒤 달은 사이트 기록
// (수강료 청구·출석)으로 이어서 센다. 두 출처가 겹치는 달을 두 번 세지 않는 것이 핵심이라
// 계산을 화면·조회와 떼어 테스트로 경계를 못박는다.
//
// 달은 전부 "YYYY-MM" 문자열로 다룬다(날짜 규칙: Date 객체를 들고 다니지 않는다).

export type StudentTenureInput = {
  baselineMonths: number | null; // 기준월까지 실제로 수강한 달 수(옛 기록)
  baselineThrough: string | null; // 기준월 "YYYY-MM" — 이 달까지는 baseline 에 이미 들어 있다
  firstMonth: string | null; // 첫 등록월 "YYYY-MM"
  liveMonths: string[]; // 사이트 기록에서 나온 수강 달 목록(중복 가능)
  currentMonth: string; // 이번 달 "YYYY-MM"(KST) — 이보다 뒤(미래) 달은 세지 않는다
};

export type StudentTenure = {
  actualMonths: number; // 실제로 수강한 달 수
  firstMonth: string | null; // 첫 등록월
  spanMonths: number | null; // 첫 등록월~이번 달 사이 전체 개월(이번 달 포함)
  label: string; // actualMonths 를 «3년 2개월» 꼴로
  spanLabel: string | null; // spanMonths 를 «3년 2개월» 꼴로
};

const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function isYearMonth(value: unknown): value is string {
  return typeof value === "string" && YM_RE.test(value);
}

// "YYYY-MM" → 0년 1월부터 센 달 번호(비교·뺄셈용)
function monthIndex(ym: string): number {
  return Number(ym.slice(0, 4)) * 12 + Number(ym.slice(5, 7)) - 1;
}

/** 개월 수를 사람 말로: 38 → "3년 2개월", 24 → "2년", 11 → "11개월", 0 → "0개월" */
export function formatTenureMonths(months: number): string {
  const safe = Math.max(0, Math.floor(months));
  const years = Math.floor(safe / 12);
  const rest = safe % 12;
  if (years === 0) return `${rest}개월`;
  if (rest === 0) return `${years}년`;
  return `${years}년 ${rest}개월`;
}

/**
 * 총 재원기간 계산. 보여줄 자료가 하나도 없으면 null(화면은 아무것도 표시하지 않는다).
 *
 * - actualMonths = baseline + (기준월보다 뒤 ~ 이번 달 이하인 사이트 기록 달의 고유 개수)
 * - baseline 이 없으면 사이트 기록 달(이번 달 이하)만 센다
 * - baselineMonths 는 있는데 기준월이 비었거나 형식이 틀리면 «어디까지 셌는지» 알 수 없어
 *   두 번 셀 위험이 있으므로 baseline 을 쓰지 않는다(사이트 기록만)
 */
export function computeStudentTenure(input: StudentTenureInput): StudentTenure | null {
  if (!isYearMonth(input.currentMonth)) return null;
  const current = monthIndex(input.currentMonth);

  const hasBaseline =
    typeof input.baselineMonths === "number" &&
    Number.isFinite(input.baselineMonths) &&
    input.baselineMonths >= 0 &&
    isYearMonth(input.baselineThrough);
  const through = hasBaseline ? monthIndex(input.baselineThrough as string) : null;

  // 사이트 기록 달: 형식이 맞고, 미래가 아니며, 기준월보다 뒤인 달만 고유하게
  const validLive = Array.from(new Set(input.liveMonths.filter(isYearMonth)))
    .filter((ym) => monthIndex(ym) <= current);
  const countedLive = validLive.filter((ym) => through === null || monthIndex(ym) > through);

  const baseline = hasBaseline ? Math.floor(input.baselineMonths as number) : 0;
  const actualMonths = baseline + countedLive.length;

  // 첫 등록월: 입력값 우선, 없으면 사이트 기록 중 가장 이른 달
  // 옛 기준값을 쓰는데 첫 등록월이 비었으면 사이트 기록으로 대신 채우지 않는다(실제 수강과 기간이 어긋남)
  const firstMonth = isYearMonth(input.firstMonth)
    ? input.firstMonth
    : !hasBaseline && validLive.length > 0
      ? [...validLive].sort()[0]
      : null;

  if (actualMonths === 0 && !firstMonth) return null;

  // 첫 등록월이 이번 달보다 뒤면(입력 실수) 기간을 계산하지 않는다
  const spanMonths = firstMonth && monthIndex(firstMonth) <= current
    ? current - monthIndex(firstMonth) + 1
    : null;

  return {
    actualMonths,
    firstMonth,
    spanMonths,
    label: formatTenureMonths(actualMonths),
    spanLabel: spanMonths === null ? null : formatTenureMonths(spanMonths),
  };
}
