/** 현재 수강 명단과 실제 납부 장부를 대조한다. 월 수강·최종 청구액을 추정하지 않는다. */
export type MonthlyClassLedgerEnrollment = {
  studentId: string;
  studentName: string;
  classId: string;
  className: string;
  status: string;
};

export type MonthlyClassLedgerPayment = {
  id: string;
  studentId: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  year: number | null;
  month: number | null;
  type: string;
  amount: number;
  status: string;
};

export type MonthlyClassLedgerInput = {
  year: number;
  month: number;
  enrollments: readonly MonthlyClassLedgerEnrollment[];
  payments: readonly MonthlyClassLedgerPayment[];
};

export type MonthlyClassLedgerAmounts = {
  billedAmount: number | null;
  paidAmount: number | null;
  outstandingAmount: number | null;
  canceledAmount: number | null;
};

export type MonthlyClassLedgerPaymentReference = {
  id: string;
  type: string;
  amount: number | null;
  status: string;
  includedInTotals: boolean;
};

export type MonthlyClassLedgerBreakdown = MonthlyClassLedgerAmounts & {
  paymentCount: number;
  excludedPaymentCount: number;
  paymentTypes: string[];
};

export type MonthlyClassLedgerRow = MonthlyClassLedgerAmounts & {
  rowKey: string;
  studentId: string;
  studentName: string;
  classId: string | null;
  className: string | null;
  year: number;
  month: number;
  enrollmentStatus: string | null;
  enrollmentNotice: string | null;
  payments: MonthlyClassLedgerPaymentReference[];
  breakdown: Record<"MONTHLY" | "SHUTTLE" | "OTHER", MonthlyClassLedgerBreakdown>;
  reviewReasons: string[];
};

export type MonthlyClassLedgerResult = {
  year: number;
  month: number;
  amountBasis: "RECORDED_PAYMENTS_ONLY";
  notice: string;
  rows: MonthlyClassLedgerRow[];
  summary: {
    studentCount: number;
    classRowCount: number;
    unassignedPaymentCount: number;
    reviewRowCount: number;
    paymentCount: number;
    excludedPaymentCount: number;
    knownBilledAmount: number;
    knownPaidAmount: number;
    knownOutstandingAmount: number;
    knownCanceledAmount: number;
  };
};

const ENROLLMENT_NOTICE = "현재 수강 명단이며 선택한 월의 수강 확정 자료가 아닙니다.";
const AMOUNT_KEYS = ["billedAmount", "paidAmount", "outstandingAmount", "canceledAmount"] as const;
const VALID_STATUSES = new Set(["PAID", "PENDING", "OVERDUE", "CANCELED"]);
const PAYMENT_FIELDS = [
  "id", "studentId", "studentName", "classId", "className", "year", "month", "type", "amount", "status",
] as const;

function emptyAmounts(): MonthlyClassLedgerAmounts {
  return { billedAmount: null, paidAmount: null, outstandingAmount: null, canceledAmount: null };
}

function emptyBreakdown(): MonthlyClassLedgerBreakdown {
  return { ...emptyAmounts(), paymentCount: 0, excludedPaymentCount: 0, paymentTypes: [] };
}

function safeAdd(left: number, right: number): number {
  const sum = left + right;
  if (!Number.isSafeInteger(sum)) throw new Error("장부 합계가 안전한 정수 범위를 벗어났습니다.");
  return sum;
}

function addPayment(target: MonthlyClassLedgerAmounts, amount: number, status: string) {
  // 취소 장부는 청구·납부·미납 합계와 분리한다.
  const amounts = {
    billedAmount: status === "CANCELED" ? 0 : amount,
    paidAmount: status === "PAID" ? amount : 0,
    outstandingAmount: status === "PENDING" || status === "OVERDUE" ? amount : 0,
    canceledAmount: status === "CANCELED" ? amount : 0,
  };
  for (const key of AMOUNT_KEYS) target[key] = safeAdd(target[key] ?? 0, amounts[key]);
}

function review(row: MonthlyClassLedgerRow, reason: string) {
  if (!row.reviewReasons.includes(reason)) row.reviewReasons.push(reason);
}

export function buildMonthlyClassLedger(input: MonthlyClassLedgerInput): MonthlyClassLedgerResult {
  const { year, month } = input;
  if (!Number.isInteger(year) || year < 2020 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("조회 연도는 2020~2100년, 월은 1~12 정수여야 합니다.");
  }

  const rowsByKey = new Map<string, MonthlyClassLedgerRow>();
  function getRow(studentId: string, studentName: string, classId: string | null, className: string | null) {
    if (!studentId || classId === "") throw new Error("학생 또는 반 식별자가 비어 있습니다.");
    const rowKey = JSON.stringify([studentId, year, month, classId]);
    let row = rowsByKey.get(rowKey);
    if (!row) {
      row = {
        ...emptyAmounts(), rowKey, studentId, studentName, classId, className, year, month,
        enrollmentStatus: null, enrollmentNotice: null, payments: [],
        breakdown: { MONTHLY: emptyBreakdown(), SHUTTLE: emptyBreakdown(), OTHER: emptyBreakdown() },
        reviewReasons: [],
      };
      rowsByKey.set(rowKey, row);
    } else if (row.studentName !== studentName || (className !== null && row.className !== className)) {
      review(row, "같은 식별자의 이름 또는 반 표시명이 달라 원본 확인이 필요합니다.");
    }
    return row;
  }

  for (const enrollment of input.enrollments) {
    const row = getRow(enrollment.studentId, enrollment.studentName, enrollment.classId, enrollment.className);
    if (row.enrollmentStatus !== null && row.enrollmentStatus !== enrollment.status) {
      throw new Error("같은 학생·반의 현재 수강 상태가 충돌합니다.");
    }
    row.enrollmentStatus = enrollment.status;
    row.enrollmentNotice = ENROLLMENT_NOTICE;
    review(row, ENROLLMENT_NOTICE);
  }

  const uniquePayments = new Map<string, MonthlyClassLedgerPayment>();
  for (const payment of input.payments) {
    if (!payment.id) throw new Error("납부 기록 식별자가 비어 있습니다.");
    const previous = uniquePayments.get(payment.id);
    if (previous) {
      // 같은 id의 내용이 다르면 어느 쪽이 맞는지 추정하지 않고 전체 조회를 중단한다.
      if (!PAYMENT_FIELDS.every((field) => Object.is(previous[field], payment[field]))) {
        throw new Error("같은 납부 기록 식별자의 내용이 충돌합니다.");
      }
      continue;
    }
    uniquePayments.set(payment.id, payment);
  }

  for (const payment of uniquePayments.values()) {
    if (payment.year !== year || payment.month !== month) continue;
    // 반이 없는 기록은 한 반만 수강하더라도 임의로 배분하지 않는다.
    const row = getRow(payment.studentId, payment.studentName, payment.classId, payment.className);
    const bucket = row.breakdown[payment.type === "MONTHLY" || payment.type === "SHUTTLE" ? payment.type : "OTHER"];
    bucket.paymentCount += 1;
    if (!bucket.paymentTypes.includes(payment.type)) bucket.paymentTypes.push(payment.type);
    const validAmount = Number.isSafeInteger(payment.amount) && payment.amount >= 0;
    const validStatus = VALID_STATUSES.has(payment.status);
    const includedInTotals = validAmount && validStatus;
    row.payments.push({
      id: payment.id, type: payment.type, amount: validAmount ? payment.amount : null,
      status: payment.status, includedInTotals,
    });
    if (!validAmount) review(row, "음수·소수·안전 범위 밖 금액은 합계에서 제외했습니다.");
    if (!validStatus) review(row, "알 수 없는 납부 상태의 기록은 합계에서 제외했습니다.");
    if (!["MONTHLY", "SHUTTLE", "UNIFORM", "OTHER"].includes(payment.type)) {
      review(row, "알 수 없는 청구 항목은 원본 유형을 유지해 기타 기록으로 표시했습니다.");
    }
    if (includedInTotals) {
      addPayment(row, payment.amount, payment.status);
      addPayment(bucket, payment.amount, payment.status);
    } else {
      bucket.excludedPaymentCount += 1;
    }
  }

  const rows = Array.from(rowsByKey.values()).sort((a, b) => a.rowKey.localeCompare(b.rowKey));
  const summary: MonthlyClassLedgerResult["summary"] = {
    studentCount: new Set(rows.map((row) => row.studentId)).size,
    classRowCount: rows.filter((row) => row.classId !== null).length,
    unassignedPaymentCount: 0, reviewRowCount: 0, paymentCount: 0, excludedPaymentCount: 0,
    knownBilledAmount: 0, knownPaidAmount: 0, knownOutstandingAmount: 0, knownCanceledAmount: 0,
  };
  for (const row of rows) {
    if (!row.payments.length) review(row, "선택한 월의 납부 기록이 없어 청구·납부 금액을 확정할 수 없습니다.");
    if (row.classId === null) {
      review(row, "반 미지정 납부 기록입니다. 수강 반에 자동 배분하지 않았습니다.");
      summary.unassignedPaymentCount += row.payments.length;
    } else if (row.enrollmentStatus === null) {
      review(row, "현재 수강 명단에는 없는 과거 반의 납부 기록입니다.");
    }
    if (row.reviewReasons.length) summary.reviewRowCount += 1;
    summary.paymentCount += row.payments.length;
    summary.excludedPaymentCount += row.payments.filter((payment) => !payment.includedInTotals).length;
    summary.knownBilledAmount = safeAdd(summary.knownBilledAmount, row.billedAmount ?? 0);
    summary.knownPaidAmount = safeAdd(summary.knownPaidAmount, row.paidAmount ?? 0);
    summary.knownOutstandingAmount = safeAdd(summary.knownOutstandingAmount, row.outstandingAmount ?? 0);
    summary.knownCanceledAmount = safeAdd(summary.knownCanceledAmount, row.canceledAmount ?? 0);
  }

  return {
    year, month, amountBasis: "RECORDED_PAYMENTS_ONLY",
    notice: "사이트에 실제 기록된 금액의 점검표입니다. 월 수강 확정·최종 청구서가 아니며 할인·이월·부분납부 범위를 추정하지 않습니다.",
    rows, summary,
  };
}
