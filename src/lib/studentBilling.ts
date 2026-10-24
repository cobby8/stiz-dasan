/**
 * 정규반 월 청구 금액 계산 (구글시트 `등록` 탭 기준)
 *
 * ── 왜 별도 파일로 떼어냈나 ──
 * 실제 돈이 걸린 계산이라 회귀 테스트가 필수인데,
 * `importStudents.ts`는 `@/lib/...` 경로 별칭을 쓰고 있어
 * `node --experimental-strip-types --test`로 직접 실행할 수 없다.
 * 그래서 계산 규칙만 외부 의존성 0인 순수 함수로 분리했다.
 *
 * ── 시트 구조 (2026-07-26 시트 전수 재집계, 원장 확답 기준) ──
 * 1. 한 학생은 **수업 1개당 1행**이다. 주3회면 3행.
 * 2. `수강료`는 행마다 적힌다 → **월 청구 수강료 = 그 학생 행들의 합계**.
 *    행마다 금액이 다를 수도 있다(김태훈A: 80,000 + 120,000 = 200,000).
 *    기존 코드는 첫 행 1건만 읽어 첫 행 금액만 청구했다. 주1회 학생은
 *    첫 행 = 합계라 버그가 드러나지 않았을 뿐이다.
 * 3. `셔틀비`는 **월 단위 값이라 첫 행에만** 적힌다.
 *    다행 학생 중 두 행에 적힌 경우는 실측 0건. **합산 금지, 첫 값 1회만.**
 * 4. **청구 대상은 `결제방법` 칸으로 판정한다.**
 *    - 청구 대상: `미결제`, `카드결제`, `추가수강` (그 외 납부수단 라벨 포함)
 *    - 청구 제외: `휴원`, `퇴원`, `이월` → 그 행을 이번 달 청구에서 뺀다
 *    `이월`은 금액을 깎는 게 아니라 행을 빼는 것이다. 실제로 시트 전체
 *    2,186행에서 `이월` 금액 칸은 100% 비어 있고 라벨로만 쓰였다.
 *    (금액 칸이 나중에 채워질 때를 대비한 차감 코드는 남겨 두었다. 현재는 항상 0)
 * 5. 최종 청구액 = 수강료 합계 + 셔틀비 - 이월금액, **0 미만이 될 수 없다**.
 *
 * ── 하지 않는 것 ──
 * 형제할인은 여기서 계산하지 않는다. 시트 금액에는 이미 수기로 반영돼 있어
 * (72,000 = 80,000 × 0.9) 다시 곱하면 이중 할인이 된다.
 */

/** DB `Payment.method`에 저장되는 결제수단 값 */
export type BillingPaymentMethod = "RALLYZ" | "CARD" | "CASH" | "UNPAID";

/**
 * 시트의 여러 행을 "같은 학생"으로 묶는 키.
 *
 * 왜 학부모 전화번호로는 부족한가:
 * 같은 학생인데도 행마다 부(父)/모(母)의 다른 번호를 적어 넣은 경우가 있다.
 * 전화번호로 묶으면 그 학생이 두 명으로 쪼개져 **수강료가 반토막 난다.**
 * (2026-07-26 실측: 김용준·김백찬·이하준·박서준 4명이 각각 180,000 → 90,000)
 *
 * 그래서 생년월일이 있으면 **이름 + 생년월일**로 묶는다.
 * 동명이인은 시트에서 이미 `김태훈A` / `김태훈B`처럼 이름을 나눠 적고 있어
 * 이름과 생일이 동시에 겹치는 진짜 남남은 실측 0건이다.
 * 생년월일이 비어 있는 행만 예전처럼 학부모 전화번호로 묶는다.
 */
export function studentGroupKey(input: {
  name: string;
  birthDateISO: string | null;
  parentPhone: string | null;
}): string {
  const name = input.name.trim();
  if (input.birthDateISO) return `${name}__B${input.birthDateISO}`;
  return `${name}__P${(input.parentPhone || "").replace(/[^0-9]/g, "")}`;
}

/** 청구 계산에 필요한 등록 시트 한 행 */
export interface BillingRow {
  /** 시트 원본 행 번호 (경고 로그·디버깅용) */
  rowNumber: number;
  /** `결제방법` 칸 원문 (랠리즈/카드결제/미결제/추가수강/이월/휴원 …) */
  paymentMethodRaw: string | null;
  /** `수강료` 칸 */
  tuitionAmount: number | null;
  /** `셔틀비` 칸 */
  shuttleFee: number | null;
  /** `이월` 금액 칸 */
  carryOverAmount: number | null;
  /** 이 행에서 선택한 정규반 슬롯 키 (예: `Sun-8`) */
  slotKeys?: readonly string[];
  /** 시트의 `셔틀비 구분`에서 무료셔틀로 확정된 행인지 여부 */
  isFreeShuttle?: boolean;
}

/** 일8 대표팀은 다른 정규반을 함께 타더라도 학생의 월 셔틀비 전체를 면제한다. */
const FULL_SHUTTLE_FEE_EXEMPT_SLOT_KEYS = new Set(["Sun-8"]);

export function hasFullShuttleFeeExemption(rows: BillingRow[]): boolean {
  return rows.some(
    (row) =>
      !isExcludedFromBilling(row.paymentMethodRaw) &&
      (row.isFreeShuttle === true ||
        (row.slotKeys ?? []).some((slotKey) =>
          FULL_SHUTTLE_FEE_EXEMPT_SLOT_KEYS.has(slotKey)
        ))
  );
}

/** 학생 1명의 월 청구 계산 결과 */
export interface StudentBillingTotals {
  /** 청구 대상 행들의 수강료 합계 */
  tuitionTotal: number;
  /** 인정된 셔틀비 (합산 아님, 첫 값 1건) */
  shuttleFeeTotal: number;
  /** 차감할 이월 금액 합계 (현재 시트에서는 항상 0) */
  carryOverTotal: number;
  /** 최종 청구액 = max(수강료합 + 셔틀비 - 이월, 0) */
  billableAmount: number;
  /** 대표 결제수단 */
  paymentMethod: BillingPaymentMethod | null;
  /** 실제로 합산에 들어간 행 번호 */
  countedRowNumbers: number[];
  /** 휴원/퇴원/이월이라 이번 달 청구에서 뺀 행 번호 */
  excludedRowNumbers: number[];
  /** 납부 완료 행과 미납 행이 섞여 있음 → 운영자 수동 확인 필요 */
  mixedPaymentMethods: boolean;
}

/**
 * 이번 달 청구에서 제외해야 하는 행인지 판정.
 *
 * `휴원`·`퇴원`은 수업을 안 하니 당연히 제외.
 * `이월`은 부상·질병 등으로 다음 달로 넘긴 건이라 이번 달 청구에 넣지 않는다.
 * (금액을 깎는 게 아니라 행 자체를 뺀다 — 원장 확답)
 */
export function isExcludedFromBilling(raw: string | null | undefined): boolean {
  const value = (raw || "").trim();
  if (!value) return false;
  return value.includes("휴원") || value.includes("퇴원") || value.includes("이월");
}

/**
 * `결제방법` 칸을 DB 결제수단 값으로 변환.
 * 휴원/퇴원/추가수강/이월은 결제수단이 아니므로 null을 반환한다.
 */
export function classifyPaymentMethod(
  raw: string | null | undefined
): BillingPaymentMethod | null {
  const trimmed = (raw || "").trim();
  if (!trimmed) return null;
  if (trimmed === "랠리즈") return "RALLYZ";
  if (trimmed === "카드결제" || trimmed === "카드") return "CARD";
  if (trimmed === "현금영수증" || trimmed === "현금") return "CASH";
  if (trimmed === "미납" || trimmed === "미결제") return "UNPAID";
  return null;
}

/**
 * 여러 행의 결제수단 중 대표값 1개를 고른다.
 *
 * 미납이 하나라도 있으면 미납으로 본다 — 받을 돈을 놓치는 쪽이 더 위험하고,
 * 청구서가 생겨도 학부모 문자는 관리자가 확인 후 따로 발송하기 때문이다.
 */
function pickPaymentMethod(
  methods: Set<BillingPaymentMethod>,
  billableAmount: number
): BillingPaymentMethod | null {
  if (methods.has("UNPAID")) return "UNPAID";
  for (const candidate of ["RALLYZ", "CARD", "CASH"] as const) {
    if (methods.has(candidate)) return candidate;
  }

  // `추가수강`처럼 결제수단이 아닌 라벨만 붙은 행뿐인데 청구할 금액이 남는 경우.
  // 2026-07-26 실측: 첫 행이 `추가수강`이라 8명(배수호·우지호·이성민·서우빈·
  // 이현일·김현호·신이준·여민재)의 청구서가 통째로 안 만들어지던 사고가 여기서 났다.
  // `추가수강`도 청구 대상이므로 미납으로 청구한다.
  //
  // 반대로 금액이 0이면(우지율: 3행 전부 `추가수강` + 수강료 공란) null을 돌려
  // 호출부가 Payment를 만들지 않게 한다 — 원장 확답 "0원이 맞습니다".
  return billableAmount > 0 ? "UNPAID" : null;
}

/**
 * 학생 1명의 등록 행 전체를 받아 월 청구액을 계산한다.
 *
 * 주의: 넘기는 행은 **같은 연/월**이어야 한다.
 * 시트에 여러 달이 섞여 들어오면 호출부에서 먼저 월별로 갈라야 한다.
 */
export function summarizeStudentBilling(rows: BillingRow[]): StudentBillingTotals {
  let tuitionTotal = 0;
  let shuttleFeeTotal = 0; // 합산이 아니라 "첫 값 1건"만 담는다
  let carryOverTotal = 0;
  const countedRowNumbers: number[] = [];
  const excludedRowNumbers: number[] = [];
  const methods = new Set<BillingPaymentMethod>();
  // 일8 대표팀 수강생은 다른 요일 셔틀을 이용해도 월 셔틀비 전체가 무료다.
  const shuttleFeeExempt = hasFullShuttleFeeExemption(rows);

  for (const row of rows) {
    // (a) 이월 금액 칸은 결제방법과 무관하게 차감 대상이다.
    //     현재 시트에서는 한 번도 채워진 적이 없어 실질적으로 항상 0이지만,
    //     나중에 쓰기 시작해도 조용히 무시되지 않도록 코드는 남겨 둔다.
    const carryOver = row.carryOverAmount ?? 0;
    if (carryOver > 0) carryOverTotal += carryOver;

    // (b) 휴원·퇴원·이월 행은 이번 달 청구 대상이 아니다 → 행 자체를 뺀다.
    if (isExcludedFromBilling(row.paymentMethodRaw)) {
      excludedRowNumbers.push(row.rowNumber);
      continue;
    }

    // 음수 수강료는 시트 오입력으로 보고 0으로 취급한다(이월은 전용 칸으로만 처리).
    tuitionTotal += Math.max(row.tuitionAmount ?? 0, 0);

    // 셔틀비는 월 단위 값이라 첫 행에만 적힌다 → 절대 합산하지 않고 첫 값만 쓴다.
    const shuttleFee = shuttleFeeExempt ? 0 : Math.max(row.shuttleFee ?? 0, 0);
    if (shuttleFeeTotal === 0 && shuttleFee > 0) shuttleFeeTotal = shuttleFee;

    countedRowNumbers.push(row.rowNumber);

    const method = classifyPaymentMethod(row.paymentMethodRaw);
    if (method) methods.add(method);
  }

  // 최종액은 0 미만이 될 수 없다.
  const billableAmount = Math.max(tuitionTotal + shuttleFeeTotal - carryOverTotal, 0);

  return {
    tuitionTotal,
    shuttleFeeTotal,
    carryOverTotal,
    billableAmount,
    paymentMethod: pickPaymentMethod(methods, billableAmount),
    countedRowNumbers,
    excludedRowNumbers,
    mixedPaymentMethods: methods.has("UNPAID") && methods.size > 1,
  };
}
