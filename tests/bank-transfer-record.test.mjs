import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { loadTsModule } from "./_ts-module.mjs";

/**
 * 관리자 «납부 처리»(계좌이체 기록·현장 결제 선택) 회귀 테스트 (2026-11-08 원장 결정).
 *
 * 원장 지시: «바로 납부로 바꾸면 실수·이력 누락 → 방법 고르고 근거 남겨야만 납부완료».
 * 위험은 셋이다.
 *  ① 입금일·입금자명 없이(또는 미래 날짜로) 납부완료가 되는 것 → 순수 규칙을 실제 실행
 *  ② 이미 납부·취소·환불 건을 다시 PAID 로 덮는 것 → 대상 분류를 실제 실행 + SQL 조건 확인
 *  ③ 예전 «바로 PAID» 경로(상태 변경 함수·단말기 메뉴)가 남아 있는 것 → 소스 계약 확인
 */

const RULES = "src/lib/payments/bankTransferRecord.ts";
const rules = await loadTsModule(RULES);
const actions = await readFile("src/app/actions/admin.ts", "utf8");
const finance = await readFile("src/app/admin/finance/FinanceClient.tsx", "utf8");
const modal = await readFile("src/app/admin/finance/RecordPaymentModal.tsx", "utf8");
const studentDetail = await readFile("src/app/admin/students/[id]/StudentDetailClient.tsx", "utf8");
const ledger = await readFile("src/lib/payment-ledger.ts", "utf8");

// 서버 액션 본문만 잘라 본다(다른 함수의 문자열과 섞이지 않게)
function fnBody(source, name) {
  const start = source.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, `${name} 함수가 있어야 한다`);
  const next = source.indexOf("\nexport async function ", start + 10);
  return source.slice(start, next < 0 ? undefined : next);
}

const TODAY = "2026-11-08";
const ok = { paymentIds: ["p1"], depositDate: "2026-11-08", depositorName: "김학부모", memo: "" };

test("입력 검사: 정상 입력은 공백을 정리하고 메모 빈칸은 null", () => {
  const r = rules.validateBankTransferInput(
    { paymentIds: [" p1 ", "p2", "p1", "", 3], depositDate: " 2026-11-07 ", depositorName: "  김학부모 ", memo: "  " },
    TODAY,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { paymentIds: ["p1", "p2"], depositDate: "2026-11-07", depositorName: "김학부모", memo: null });
});

test("입력 검사: 대상 없음·100건 초과 거부", () => {
  assert.equal(rules.validateBankTransferInput({ ...ok, paymentIds: [] }, TODAY).ok, false);
  assert.equal(rules.validateBankTransferInput({ ...ok, paymentIds: "p1" }, TODAY).ok, false);
  const many = Array.from({ length: rules.MAX_PAYMENT_IDS + 1 }, (_, i) => `p${i}`);
  assert.equal(rules.validateBankTransferInput({ ...ok, paymentIds: many }, TODAY).ok, false);
});

test("입력 검사: 입금일은 필수·실재 날짜·미래 금지(오늘은 허용)", () => {
  assert.equal(rules.validateBankTransferInput({ ...ok, depositDate: "" }, TODAY).ok, false);
  assert.equal(rules.validateBankTransferInput({ ...ok, depositDate: "2026-02-30" }, TODAY).ok, false);
  assert.equal(rules.validateBankTransferInput({ ...ok, depositDate: "2026/11/08" }, TODAY).ok, false);
  const future = rules.validateBankTransferInput({ ...ok, depositDate: "2026-11-09" }, TODAY);
  assert.equal(future.ok, false);
  assert.match(future.error, /오늘 이후/);
  assert.equal(rules.validateBankTransferInput({ ...ok, depositDate: TODAY }, TODAY).ok, true);
  // 연말 경계: 오늘이 12-31 이면 다음 해 1-1 은 미래
  assert.equal(rules.validateBankTransferInput({ ...ok, depositDate: "2027-01-01" }, "2026-12-31").ok, false);
  assert.equal(rules.validateBankTransferInput({ ...ok, depositDate: "2024-02-29" }, TODAY).ok, true);
});

test("입력 검사: 입금자명 필수 1~40자, 메모 200자 이내", () => {
  assert.equal(rules.validateBankTransferInput({ ...ok, depositorName: "   " }, TODAY).ok, false);
  assert.equal(rules.validateBankTransferInput({ ...ok, depositorName: undefined }, TODAY).ok, false);
  assert.equal(rules.validateBankTransferInput({ ...ok, depositorName: "가".repeat(40) }, TODAY).ok, true);
  assert.equal(rules.validateBankTransferInput({ ...ok, depositorName: "가".repeat(41) }, TODAY).ok, false);
  assert.equal(rules.validateBankTransferInput({ ...ok, memo: "a".repeat(200) }, TODAY).ok, true);
  assert.equal(rules.validateBankTransferInput({ ...ok, memo: "a".repeat(201) }, TODAY).ok, false);
});

test("상태 전이: 미납·연체만 기록하고 나머지는 이유와 함께 건너뛴다(요청 순서 유지)", () => {
  const rows = [
    { id: "a", status: "PENDING" },
    { id: "b", status: "PAID" },
    { id: "c", status: "OVERDUE" },
    { id: "d", status: "CANCELLED" },
    { id: "e", status: "REFUNDED" },
  ];
  const r = rules.splitRecordableTargets(rows, ["c", "a", "b", "d", "e", "zz"]);
  assert.deepEqual(r.recordable, ["c", "a"]);
  assert.deepEqual(r.skipped, [
    { id: "b", reason: "ALREADY_PAID" },
    { id: "d", reason: "NOT_UNPAID" },
    { id: "e", reason: "NOT_UNPAID" },
    { id: "zz", reason: "NOT_FOUND" },
  ]);
  assert.match(rules.bankTransferResultMessage(2, 4), /2건.*4건은 건너뛰었어요/);
  assert.match(rules.bankTransferResultMessage(0, 1), /기록한 건이 없어요/);
});

test("현장 결제(POS): 수강료·셔틀비 미납 1건만 활성, 여러 건이면 안내", () => {
  assert.deepEqual(rules.posChargeAvailability([{ type: "MONTHLY", status: "PENDING" }]), { enabled: true });
  assert.deepEqual(rules.posChargeAvailability([{ type: "SHUTTLE", status: "OVERDUE" }]), { enabled: true });
  const other = rules.posChargeAvailability([{ type: "UNIFORM", status: "PENDING" }]);
  assert.equal(other.enabled, false);
  assert.equal(other.reason, "수강료·셔틀비만 현장 결제할 수 있어요.");
  const multi = rules.posChargeAvailability([{ type: "MONTHLY", status: "PENDING" }, { type: "MONTHLY", status: "PENDING" }]);
  assert.equal(multi.enabled, false);
  assert.equal(multi.reason, "같은 학생 여러 건 한 번에 결제는 곧 추가됩니다.");
  assert.equal(rules.posChargeAvailability([{ type: "MONTHLY", status: "PAID" }]).enabled, false);
});

test("서버 액션: 재무 권한·서버 재검사·한 트랜잭션·미납만 갱신·계좌이체 수단·감사 기록", () => {
  const body = fnBody(actions, "recordBankTransferPayment");
  assert.match(body, /const admin = await requireFinanceOwner\(\)/);
  assert.match(body, /validateBankTransferInput\(data, todayKst\(\)\)/);
  assert.match(body, /prisma\.\$transaction\(/);
  assert.match(body, /FOR UPDATE OF p/);
  // UPDATE 자체에도 상태 조건을 걸어, 잠금 사이에 바뀐 건을 덮지 않는다
  assert.match(body, /AND status IN \('PENDING', 'OVERDUE'\)/);
  assert.match(body, /Number\(updated\) !== recordable\.length/);
  assert.equal(rules.BANK_TRANSFER_METHOD, "BANK_TRANSFER");
  assert.match(body, /INSERT INTO "PaymentAuditLog"/);
  for (const key of ["depositDate", "depositorName", "memo", "previousStatus: row.status"]) {
    assert.ok(body.includes(key), `감사 기록에 ${key} 가 있어야 한다`);
  }
  // 무tz paidDate 와 timestamptz paidAt 이 같은 순간(입금일 00:00 UTC)이어야 날짜가 어긋나지 않는다
  assert.match(body, /"paidDate" = \$2::date::timestamp/);
  assert.match(body, /"paidAt" = \(\$2::date::timestamp AT TIME ZONE 'UTC'\)/);
});

test("PAID 직접 변경 차단: 상태 변경 함수 두 개는 PAID 를 거부한다", () => {
  for (const name of ["updatePaymentStatus", "bulkUpdatePaymentStatus"]) {
    const body = fnBody(actions, name);
    assert.match(body, /=== "PAID"\) throw new Error\(DIRECT_PAID_BLOCKED_MESSAGE\)/, `${name} 가 PAID 를 막아야 한다`);
    assert.doesNotMatch(body, /markPaymentPaid\(/, `${name} 는 납부완료를 만들지 않는다`);
  }
  // 화면도 PAID 로 바로 바꾸는 호출이 없어야 한다
  assert.doesNotMatch(finance, /handleStatusChange\([^)]*"PAID"\)/);
  assert.doesNotMatch(finance, /updatePaymentStatus\([^)]*"PAID"\)/);
  assert.doesNotMatch(finance, /bulkUpdatePaymentStatus/);
  // 학생 상세: 완납 칸은 이미 완납인 건에만 보인다
  assert.match(studentDetail, /option\.value !== "PAID" \|\| p\.status === "PAID"/);
});

test("납부 처리 창: 행 메뉴·일괄 버튼이 같은 창을 열고, 현장 결제는 기존 POS 창으로 넘긴다", () => {
  assert.match(finance, /onSelect: \(\) => setRecordTargets\(\[p\]\)/);
  assert.match(finance, /선택 항목 납부 처리/);
  assert.match(finance, /setRecordTargets\(targets\)/);
  assert.match(finance, /setPosChargeTarget\(payment\)/);
  assert.match(modal, /recordBankTransferPayment\(checked\.value\)/);
  assert.match(modal, /posChargeAvailability\(targets\)/);
  assert.match(modal, /todayKst\(\)/);
  assert.match(modal, /합계/);
});

test("단말기 제거 회귀: 메뉴·모달·서버 액션·원장부 함수가 없고 과거 기록 표시는 남는다", () => {
  assert.doesNotMatch(finance, /markTerminalPaymentPaid|openTerminalModal|terminalTarget|key: "terminal"/);
  assert.doesNotMatch(actions, /export async function markTerminalPaymentPaid/);
  assert.doesNotMatch(ledger, /export async function recordTerminalPayment/);
  // 예전에 단말기로 기록된 결제의 표시 이름은 유지
  assert.match(finance, /TOSS_TERMINAL: "현장 단말기"/);
});

test("검수 보완: 수동 기록 표시(paidProvider MANUAL)·청구서 PAID/CANCELED 덮지 않기·토스 키 미변경", () => {
  const body = fnBody(actions, "recordBankTransferPayment");
  // 교사 수납 확인·특강 수동 납부와 같은 관례
  assert.match(body, /"paidProvider" = 'MANUAL'/);
  // 청구서도 이미 납부·취소면 덮지 않는다
  assert.match(body, /WHERE "paymentId" = ANY\(\$1::text\[\]\) AND status NOT IN \('PAID', 'CANCELED'\)/);
  // 수동 경로는 토스 주문번호·결제키를 건드리지 않는다
  assert.doesNotMatch(body, /"providerOrderId" =|"providerPaymentKey" =/);
});

test("여러 건 납부 처리 창: 대상 학생 이름 한 줄(중복 제거·많으면 «외 N명»)", () => {
  const s = rules.targetNamesSummary;
  assert.equal(s([{ studentName: "홍길동" }]), "홍길동");
  assert.equal(s([{ studentName: "홍길동" }, { studentName: " 홍길동 " }]), "홍길동");
  assert.equal(s([{ studentName: "홍길동" }, { studentName: "김철수" }]), "홍길동, 김철수");
  assert.equal(
    s([{ studentName: "홍길동" }, { studentName: "김철수" }, { studentName: "이영희" }, { studentName: "박민수" }]),
    "홍길동, 김철수 외 2명",
  );
  assert.equal(s([{ studentName: "" }]), "이름 없음");
  assert.equal(s([{ studentName: "가" }, { studentName: "나" }], 1), "가 외 1명");
  // 창이 실제로 이 한 줄을 여러 건일 때 보인다
  assert.match(modal, /targets\.length > 1 &&[\s\S]*대상 \{targetNamesSummary\(targets\)\}/);
});
