import type { MonthlyClassLedgerEnrollment, MonthlyClassLedgerPayment } from "./monthly-class-ledger";
// @ts-expect-error Node의 타입 제거 테스트에서도 같은 순수 함수를 사용한다.
import { buildMonthlyClassLedger } from "./monthly-class-ledger.ts";

type ReadDatabase = {
  $queryRawUnsafe<T>(sql: string, ...values: unknown[]): Promise<T>;
};

export const MONTHLY_LEDGER_READ_LIMIT = 5000;

export function parseMonthlyLedgerMonth(value: string) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error("INVALID_MONTH");
  const [year, month] = value.split("-").map(Number);
  if (year < 2020 || year > 2100) throw new Error("INVALID_MONTH");
  return { year, month };
}

/** 거래 호출자가 동일한 읽기 스냅샷을 제공한다. 과거 수강이나 요금을 추측하지 않는다. */
export async function readMonthlyClassLedger(db: ReadDatabase, targetMonth: string) {
  const { year, month } = parseMonthlyLedgerMonth(targetMonth);
  const enrollments = await db.$queryRawUnsafe<MonthlyClassLedgerEnrollment[]>(`
    SELECT e."studentId", s.name AS "studentName", e."classId",
           c.name AS "className", e.status
    FROM "Enrollment" e
    JOIN "Student" s ON s.id = e."studentId"
    JOIN "Class" c ON c.id = e."classId"
    WHERE e.status IN ('ACTIVE', 'PAUSED')
    ORDER BY e."studentId", e."classId"
    LIMIT $1
  `, MONTHLY_LEDGER_READ_LIMIT + 1);
  const payments = await db.$queryRawUnsafe<MonthlyClassLedgerPayment[]>(`
    SELECT p.id, p."studentId", s.name AS "studentName", p."classId",
           c.name AS "className", p.year, p.month, p.type, p.amount, p.status
    FROM "Payment" p
    JOIN "Student" s ON s.id = p."studentId"
    LEFT JOIN "Class" c ON c.id = p."classId"
    WHERE p.year = $1 AND p.month = $2
    ORDER BY p."studentId", p."classId", p.id
    LIMIT $3
  `, year, month, MONTHLY_LEDGER_READ_LIMIT + 1);
  // 일부만 가져와 전체 월 합계처럼 표시하지 않는다.
  if (enrollments.length > MONTHLY_LEDGER_READ_LIMIT || payments.length > MONTHLY_LEDGER_READ_LIMIT) {
    throw new Error("MONTHLY_LEDGER_LIMIT");
  }
  return buildMonthlyClassLedger({ year, month, enrollments, payments });
}
