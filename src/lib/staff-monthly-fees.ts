import { prisma } from '@/lib/prisma';
import { getStaffSessionDetail, getStaffSessionStudents } from '@/lib/staff-session-queries';
import { requireStaffStudentAccess } from '@/lib/staff-class-access';
import { resolveStaffBillingGuard } from '@/lib/staff-billing-policy';
import { resolveMonthlyFee, type MonthlyFeePayment, type MonthlyFeeRegister } from './staff-monthly-fee-policy';
import type { StaffMonthlyFeeSummary, StaffSessionMonthlyFees } from './staff-monthly-fee-types';
import type { SerializedStaffClassBillingItem } from '@/app/actions/staff-billing';

export function staffFeeMonth(now = new Date()): string {
  // 실행 시점의 한국 월을 사용한다. 납기일이나 수업 날짜로 청구 월을 추측하지 않는다.
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit' }).format(now);
}

async function authorizedRoster(sessionId: string) {
  if (!sessionId || sessionId.length > 128) throw new Error('수업 정보가 올바르지 않습니다.');
  const session = await getStaffSessionDetail(sessionId);
  if (!session) throw new Error('확인할 수업을 찾을 수 없습니다.');
  const students = await getStaffSessionStudents(sessionId, session.classId);
  return { session, students };
}

const PAYMENT_COLUMNS = `p.id, p."studentId", p."classId", p.amount, p.status,
 i.id AS "invoiceId", i.amount AS "invoiceAmount", i."studentId" AS "invoiceStudentId",
 i.status AS "invoiceStatus", confirmation.status AS "confirmationStatus"`;
const PAYMENT_JOINS = `LEFT JOIN "PaymentInvoice" i ON i."paymentId" = p.id
 LEFT JOIN LATERAL (SELECT r.status FROM "StaffPaymentConfirmationRequest" r
 WHERE r."paymentId" = p.id ORDER BY r."createdAt" DESC LIMIT 1) confirmation ON true`;

type SeatFee = { rosterId: string; tuition: number; discount: number; price: number;
  shuttle: number; paymentId: string | null; studentId: string | null };

async function readContext(sessionId: string) {
  const { session, students } = await authorizedRoster(sessionId);
  const month = staffFeeMonth();
  const [yearNumber, monthNumber] = month.split('-').map(Number);
  const seatIds = students.filter(s => s.id !== s.studentId).map(s => s.attendanceKey);
  const studentIds = students.filter(s => s.id === s.studentId).map(s => s.studentId!);
  const payments = studentIds.length ? await prisma.$queryRawUnsafe<MonthlyFeePayment[]>(
    `SELECT ${PAYMENT_COLUMNS} FROM "Payment" p ${PAYMENT_JOINS}
     WHERE p."studentId" = ANY($1::text[]) AND p.type = 'MONTHLY'
       AND p.year = $2 AND p.month = $3 AND (p."classId" = $4 OR p."classId" IS NULL)
       AND p.status NOT IN ('CANCELED','CANCELLED')`, studentIds, yearNumber, monthNumber, session.classId,
  ) : [];
  // 설치 유무만 분기한다. 설치된 장부의 실제 조회 실패를 '자료 없음'으로 삼키지 않는다.
  const available = studentIds.length ? await prisma.$queryRawUnsafe<Array<{ available: boolean }>>(
    `SELECT to_regclass('public."MonthlyEnrollmentRegister"') IS NOT NULL AS available`,
  ) : [];
  const registerAvailable = available[0]?.available ?? false;
  const registers = registerAvailable ? await prisma.$queryRawUnsafe<Array<MonthlyFeeRegister & { studentId: string }>>(
    `SELECT "studentId", status, payload FROM "MonthlyEnrollmentRegister"
     WHERE "studentId" = ANY($1::text[]) AND month = $2`, studentIds, month,
  ) : [];
  const seats = seatIds.length ? await prisma.$queryRawUnsafe<SeatFee[]>(
    `SELECT ed.id AS "rosterId", i."tuitionPriceSnapshot" AS tuition,
       i."siblingDiscountSnapshot" AS discount, i."priceSnapshot" AS price,
       i."shuttleFeeSnapshot" AS shuttle, i."paymentId", app."convertedStudentId" AS "studentId"
     FROM "SpecialProgramEnrollmentDate" ed
     JOIN "SpecialProgramApplicationItem" i ON i.id = ed."applicationItemId" AND i.status = 'APPROVED'
     JOIN "SpecialProgramApplication" app ON app.id = i."applicationId"
     WHERE ed.id = ANY($1::text[]) AND ed.status = 'SCHEDULED'`, seatIds,
  ) : [];
  const seasonalIds = seats.map(s => s.paymentId).filter((id): id is string => Boolean(id));
  const seasonalPayments = seasonalIds.length ? await prisma.$queryRawUnsafe<MonthlyFeePayment[]>(
    `SELECT ${PAYMENT_COLUMNS} FROM "Payment" p ${PAYMENT_JOINS}
     WHERE p.id = ANY($1::text[])`, seasonalIds,
  ) : [];
  const items: StaffMonthlyFeeSummary[] = students.map(student => {
    if (student.id === student.studentId) return resolveMonthlyFee({ rosterId: student.id,
      studentId: student.studentId!, classId: session.classId,
      payments: payments.filter(p => p.studentId === student.studentId),
      register: registers.find(r => r.studentId === student.studentId) ?? null, registerAvailable });
    const seat = seats.find(s => s.rosterId === student.attendanceKey);
    const base: StaffMonthlyFeeSummary = { rosterId: student.id, studentId: student.studentId,
      amount: null, status: 'UNKNOWN', statusLabel: '금액 미확인', sourceLabel: '특강 전체 기간 수강료',
      note: '월별 금액이 아닌 신청한 특강 전체 기간 수강료입니다.', paymentIds: [], period: 'SEASONAL' };
    if (!seat) return base;
    const amount = seat.tuition - seat.discount;
    const p = seasonalPayments.find(p => p.id === seat.paymentId);
    const invalid = (seat.paymentId && !p) || ![seat.tuition, seat.discount, seat.price, seat.shuttle].every(v => Number.isSafeInteger(v) && v >= 0)
      || amount < 0 || amount + seat.shuttle !== seat.price
      || (p && (p.studentId !== student.studentId || p.amount !== seat.price ||
        !['PENDING', 'OVERDUE', 'PAID'].includes(p.status) ||
        (p.invoiceId && (p.invoiceAmount !== p.amount || p.invoiceStudentId !== p.studentId ||
          (p.status === 'PAID') !== (p.invoiceStatus === 'PAID') || p.invoiceStatus === 'CANCELED'))));
    if (invalid) return { ...base, status: 'REVIEW', statusLabel: '관리자 확인 필요', note: '특강 수강료·할인·셔틀비 또는 결제 원장 근거가 일치하지 않습니다.' };
    const status = !p ? 'UNISSUED' : p.status === 'PAID' ? 'PAID' : p.confirmationStatus === 'PENDING' ? 'PENDING_CONFIRMATION' : 'UNPAID';
    return { ...base, amount, status, paymentIds: p ? [p.id] : [],
      statusLabel: status === 'PAID' ? '납부 완료' : status === 'UNPAID' ? '미납' : status === 'UNISSUED' ? '청구 미생성' : '납부 확인 대기',
      note: `특강 전체 기간 수강료(셔틀비 제외)입니다.${seat.shuttle ? ' 청구 창의 총액에는 셔틀비가 포함됩니다.' : ''}${p && !p.invoiceId ? ' 청구서 미발행.' : ''}` };
  });
  return { session, students, month, items };
}

export async function getStaffSessionMonthlyFees(sessionId: string): Promise<StaffSessionMonthlyFees> {
  const { month, items } = await readContext(sessionId);
  return { month, items };
}

export async function getStaffAttendanceBilling(sessionId: string, rosterId: string) {
  const { month, items, session, students } = await readContext(sessionId);
  const summary = items.find(i => i.rosterId === rosterId);
  if (!summary || !students.some(s => s.id === rosterId)) throw new Error('이 출석 명단의 학생만 확인할 수 있습니다.');
  if (!summary.paymentIds.length) return { month, summary, items: [] as SerializedStaffClassBillingItem[] };
  const [yearNumber, monthNumber] = month.split('-').map(Number);
  const rows = await prisma.$queryRawUnsafe<Array<MonthlyFeePayment & {
    title: string; dueDate: Date; paidDate: Date | null; invoiceNo: string;
  }>>(`SELECT ${PAYMENT_COLUMNS}, COALESCE(NULLIF(i.title,''), NULLIF(p.description,''),'수강료') AS title,
    p."dueDate", p."paidDate", i."invoiceNo" FROM "Payment" p ${PAYMENT_JOINS}
    WHERE p.id = ANY($1::text[]) AND i.id IS NOT NULL AND i.status <> 'CANCELED'
      AND ($2::boolean OR (p.type = 'MONTHLY' AND p.year = $3 AND p.month = $4 AND p."classId" = $5))`,
    summary.paymentIds, summary.period === 'SEASONAL', yearNumber, monthNumber, session.classId);
  const student = students.find(s => s.id === rosterId)!;
  let hasStudentAccess = false;
  if (student.studentId) {
    try { await requireStaffStudentAccess(session.classId, student.studentId); hasStudentAccess = true; }
    catch { /* 특강 좌석 조회권한은 수납 요청권한과 별개다. 읽기는 허용하고 요청만 막는다. */ }
  }
  const detailItems: SerializedStaffClassBillingItem[] = rows.map(p => {
    const amountMismatch = p.amount !== p.invoiceAmount;
    const studentMismatch = p.studentId !== p.invoiceStudentId || p.studentId !== student.studentId;
    const guard = resolveStaffBillingGuard({ paymentClassId: p.classId, amountMismatch, studentMismatch });
    const confirmable = hasStudentAccess && guard.confirmable && p.classId === session.classId && summary.status !== 'REVIEW';
    return { id: p.id, classId: session.classId, paymentClassId: p.classId, linkSource: p.classId ? 'PAYMENT' : 'ENROLLMENT',
      studentId: p.studentId, studentName: student.name, title: p.title, amount: p.amount, invoiceAmount: p.invoiceAmount!,
      amountMismatch, studentMismatch, paymentStatus: p.status, invoiceStatus: p.invoiceStatus!, invoiceNo: p.invoiceNo,
      dueDate: p.dueDate.toISOString(), paidDate: p.paidDate?.toISOString() ?? null, confirmationStatus: p.confirmationStatus,
      status: p.status === 'PAID' ? 'PAID' : p.confirmationStatus === 'PENDING' ? 'PENDING_CONFIRMATION' : 'UNPAID',
      confirmable, blockReason: confirmable ? null : guard.blockReason ?? '담당 정규반 학생 확인 또는 관리자 확인이 필요합니다.' };
  });
  return { month, summary, items: detailItems };
}
