import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { resolveMonthlyFee } from '../src/lib/staff-monthly-fee-policy.ts';

const payment = { id: 'payment-a', studentId: 'student-a', classId: 'class-a', amount: 100000,
  status: 'PENDING', invoiceId: null, invoiceAmount: null, invoiceStudentId: null, invoiceStatus: null, confirmationStatus: null };
const entry = { classId: 'class-a', status: 'ACTIVE', baseAmount: 140000, discountAmount: 20000, carryAmount: 10000, prorationAmount: 10000 };
const base = { rosterId: 'student-a', studentId: 'student-a', classId: 'class-a', payments: [], register: null, registerAvailable: true };
const resolve = (input = {}) => resolveMonthlyFee({ ...base, ...input });

test('청구서 없는 Payment도 실제 금액과 미납/납부 상태를 표시한다', () => {
  const pending = resolve({ payments: [payment] });
  assert.equal(pending.amount, 100000); assert.equal(pending.status, 'UNPAID');
  assert.match(pending.note, /청구서 미발행/);
  assert.equal(resolve({ payments: [{ ...payment, status: 'PAID' }] }).status, 'PAID');
  assert.equal(resolve({ payments: [{ ...payment, confirmationStatus: 'PENDING' }] }).status, 'PENDING_CONFIRMATION');
});
test('확정 월 장부만 할인 이월 일할 차감하고 셔틀비는 합산하지 않는다', () => {
  const item = resolve({ register: { status: 'CONFIRMED', payload: { classes: [entry, { ...entry, classId: 'other', baseAmount: 500000 }], shuttleAmount: 20000 } } });
  assert.equal(item.amount, 100000); assert.equal(item.status, 'UNISSUED');
  assert.match(item.note, /셔틀비는 제외/);
});
test('초안과 근거 없는 경우 0원으로 오인하지 않는다', () => {
  assert.equal(resolve().amount, null);
  assert.equal(resolve({ register: { status: 'DRAFT', payload: { classes: [entry] } } }).amount, null);
  assert.match(resolve({ registerAvailable: false }).note, /설치되지/);
});
test('확정 장부의 근거 있는 0원은 청구 미생성이고 납부 완료가 아니다', () => {
  const item = resolve({ register: { status: 'CONFIRMED', payload: { classes: [{ ...entry, baseAmount: 40000 }] } } });
  assert.equal(item.amount, 0); assert.equal(item.status, 'UNISSUED');
});
test('휴원 퇴원 이월 상태를 0원 납부로 표시하지 않는다', () => {
  for (const status of ['PAUSED', 'WITHDRAWN', 'CARRY_OVER']) {
    assert.equal(resolve({ register: { status: 'CONFIRMED', payload: { classes: [{ ...entry, status }] } } }).amount, null);
  }
});
test('다른 반의 청구는 사용하지 않고 반 미지정 청구는 확인 보류한다', () => {
  assert.equal(resolve({ payments: [{ ...payment, classId: 'other' }] }).amount, null);
  assert.equal(resolve({ payments: [{ ...payment, classId: null }] }).status, 'REVIEW');
});
test('복수 청구를 임의 합산하지 않는다', () => {
  const item = resolve({ payments: [payment, { ...payment, id: 'p2' }] });
  assert.equal(item.amount, null); assert.equal(item.status, 'REVIEW');
});
test('결제 원장과 청구서의 학생 금액 납부 상태 모순을 숨기지 않는다', () => {
  const issued = { ...payment, invoiceId: 'invoice-a', invoiceAmount: 100000, invoiceStudentId: 'student-a', invoiceStatus: 'ISSUED' };
  assert.equal(resolve({ payments: [issued] }).status, 'UNPAID');
  for (const patch of [{ invoiceAmount: 90000 }, { invoiceStudentId: 'other' }, { invoiceStatus: 'PAID' }, { invoiceStatus: 'CANCELED' }]) {
    assert.equal(resolve({ payments: [{ ...issued, ...patch }] }).status, 'REVIEW');
  }
});
test('월 장부 불일치와 반별 셔틀 배분 근거 없는 차액은 자동 추정하지 않는다', () => {
  const item = resolve({ payments: [{ ...payment, amount: 120000 }], register: { status: 'CONFIRMED', payload: { classes: [entry], shuttleAmount: 20000 } } });
  assert.equal(item.amount, null); assert.equal(item.status, 'REVIEW'); assert.match(item.note, /셔틀비/);
});
test('안전하지 않은 음수 및 차감 초과는 확인 보류한다', () => {
  for (const patch of [{ baseAmount: -1 }, { discountAmount: 900000 }]) {
    assert.equal(resolve({ register: { status: 'CONFIRMED', payload: { classes: [{ ...entry, ...patch }] } } }).status, 'REVIEW');
  }
});
test('확정 장부 payload 누락과 잘못된 classes를 0원으로 오인하지 않는다', () => {
  for (const payload of [null, {}, { classes: 'invalid' }, { classes: [null] }]) {
    const item = resolve({ register: { status: 'CONFIRMED', payload } });
    assert.equal(item.status, 'REVIEW'); assert.equal(item.amount, null);
  }
});
test('조회 구현은 세션 권한과 실제 출석 명단을 먼저 증명한다', () => {
  const source = readFileSync('src/lib/staff-monthly-fees.ts', 'utf8');
  assert.match(source, /await getStaffSessionDetail\(sessionId\)/);
  assert.match(source, /await getStaffSessionStudents\(sessionId, session.classId\)/);
  assert.match(source, /students.some\(s => s.id === rosterId\)/);
  assert.doesNotMatch(source, /JOIN[^\n]+ON[^\n]+\.name/);
});
test('정확 월 원장과 실제 선택 청구만 읽으며 조회 중 변경 명령은 없다', () => {
  const source = readFileSync('src/lib/staff-monthly-fees.ts', 'utf8');
  assert.match(source, /p.year = \$2 AND p.month = \$3/);
  assert.match(source, /LEFT JOIN "PaymentInvoice"/);
  assert.match(source, /to_regclass/);
  assert.match(source, /summary.paymentIds/);
  assert.match(source, /ed.id = ANY\(\$1::text\[\]\)/);
  assert.doesNotMatch(source, /\$executeRaw|INSERT INTO|UPDATE "|DELETE FROM|CREATE TABLE/);
  assert.doesNotMatch(source, /getStaffClassBilling/);
});
