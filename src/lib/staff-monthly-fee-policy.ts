import type { StaffMonthlyFeeSummary } from './staff-monthly-fee-types.ts';

export type MonthlyFeePayment = {
  id: string; studentId: string; classId: string | null; amount: number;
  status: string; invoiceId: string | null; invoiceAmount: number | null;
  invoiceStudentId: string | null; invoiceStatus: string | null; confirmationStatus: string | null;
};
export type MonthlyFeeRegister = { status: string; payload: { classes?: Array<{
  classId: string; status: string; baseAmount: number; discountAmount: number;
  carryAmount: number; prorationAmount: number;
}> } | null };

export function resolveMonthlyFee(input: {
  rosterId: string; studentId: string; classId: string; payments: MonthlyFeePayment[];
  register: MonthlyFeeRegister | null; registerAvailable: boolean;
}): StaffMonthlyFeeSummary {
  const base: StaffMonthlyFeeSummary = { rosterId: input.rosterId, studentId: input.studentId,
    amount: null, status: 'UNKNOWN', statusLabel: '금액 미확인', sourceLabel: '산정 근거 없음',
    note: null, paymentIds: [], period: 'MONTHLY' };
  const review = (note: string): StaffMonthlyFeeSummary => ({ ...base, status: 'REVIEW', statusLabel: '관리자 확인 필요', sourceLabel: '근거 확인 필요', note });
  const payments = input.payments.filter(p => p.status !== 'CANCELED' && p.status !== 'CANCELLED');
  const exact = payments.filter(p => p.classId === input.classId);
  if (payments.some(p => p.classId === null)) return review('이번 달 반 미지정 청구가 있어 이 반의 수강료를 확정할 수 없습니다.');
  if (exact.length > 1) return review('이번 달 같은 반 청구가 여러 건입니다. 분할·중복 여부를 관리자에게 확인해 주세요.');
  if (input.register?.status === 'CONFIRMED' && !Array.isArray(input.register.payload?.classes)) return review('확정 월 장부의 수강 반 근거가 올바르지 않습니다.');
  const classes = input.register?.status === 'CONFIRMED' ? input.register.payload?.classes : undefined;
  if (Array.isArray(classes) && classes.some(c => !c || typeof c !== 'object' || typeof c.classId !== 'string')) return review('확정 월 장부의 수강 반 근거가 올바르지 않습니다.');
  const matching = Array.isArray(classes) ? classes.filter(c => c.classId === input.classId) : [];
  if (matching.length > 1) return review('확정 월 장부에 같은 반이 중복되어 있습니다.');
  const entry = matching[0];
  if (entry && !['ACTIVE', 'PAUSED', 'WITHDRAWN', 'CARRY_OVER'].includes(entry.status)) return review('확정 월 장부의 수강 상태가 올바르지 않습니다.');
  let expected: number | null = null;
  if (entry?.status === 'ACTIVE') {
    const values = [entry.baseAmount, entry.discountAmount, entry.carryAmount, entry.prorationAmount];
    if (values.some(v => !Number.isSafeInteger(v) || v < 0)) return review('확정 월 장부의 금액 근거가 올바르지 않습니다.');
    expected = entry.baseAmount - entry.discountAmount - entry.carryAmount - entry.prorationAmount;
    if (expected < 0) return review('확정 월 장부의 차감액이 수강료보다 큽니다.');
  }
  const p = exact[0];
  if (p) {
    base.paymentIds = [p.id];
    if (!Number.isSafeInteger(p.amount) || p.amount < 0) return review('청구 금액이 올바르지 않습니다.');
    if (entry && (entry.status !== 'ACTIVE' || expected !== p.amount)) return review('월 장부와 청구의 수강 상태 또는 금액이 다릅니다. 셔틀비 포함 여부도 확인해 주세요.');
    if (p.invoiceId && (p.invoiceAmount !== p.amount || p.invoiceStudentId !== p.studentId ||
      (p.status === 'PAID') !== (p.invoiceStatus === 'PAID') || p.invoiceStatus === 'CANCELED')) {
      return review('결제 원장과 청구서의 학생·금액·납부 상태가 다릅니다.');
    }
    if (!['PENDING', 'OVERDUE', 'PAID'].includes(p.status)) return review('현재 결제 상태는 관리자 확인이 필요합니다.');
    const status = p.status === 'PAID' ? 'PAID' : p.confirmationStatus === 'PENDING' ? 'PENDING_CONFIRMATION' : 'UNPAID';
    return { ...base, amount: p.amount, status,
      statusLabel: status === 'PAID' ? '납부 완료' : status === 'PENDING_CONFIRMATION' ? '납부 확인 대기' : '미납',
      sourceLabel: '이번 달 이 반 청구 금액', note: `${p.invoiceId ? '' : '청구서 미발행 · '}저장된 청구 총액입니다. 셔틀비 등 포함 항목은 관리자에게 확인해 주세요.` };
  }
  if (expected !== null) return { ...base, amount: expected, status: 'UNISSUED', statusLabel: '청구 미생성', sourceLabel: '확정 월 수강 장부', note: '이 반의 할인·이월·일할 차감을 반영한 수강료입니다. 셔틀비는 제외하며 납부 여부는 아직 확인되지 않았습니다.' };
  return { ...base, note: !input.registerAvailable ? '월 수강 장부 기능이 아직 설치되지 않았습니다. 관리자에게 금액을 확인해 주세요.' : entry ? '확정 월 장부에서 휴원·퇴원·이월 상태입니다. 0원 납부로 처리하지 않습니다.' : '이번 달 결제 원장 또는 이 반의 확정 월 수강 장부가 필요합니다. 초안 금액은 사용하지 않습니다.' };
}
