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

test("현장 결제(POS): 수강료·셔틀비 미납 — 1건, 또는 같은 학생 여러 건이면 활성(2026-11-08 원장 결정)", () => {
  assert.deepEqual(rules.posChargeAvailability([{ type: "MONTHLY", status: "PENDING" }]), { enabled: true });
  assert.deepEqual(rules.posChargeAvailability([{ type: "SHUTTLE", status: "OVERDUE" }]), { enabled: true });
  const other = rules.posChargeAvailability([{ type: "UNIFORM", status: "PENDING" }]);
  assert.equal(other.enabled, false);
  assert.equal(other.reason, "유니폼 청구는 현장 결제할 수 없어요(본사 직접 구매).");
  // 기타 청구도 면세로 현장 결제 가능(2026-11-08 원장 지시)
  assert.deepEqual(rules.posChargeAvailability([{ type: "OTHER", status: "PENDING" }]), { enabled: true });
  assert.deepEqual(rules.posChargeAvailability([{ type: "OTHER", status: "PENDING", studentId: "s1" }, { type: "OTHER", status: "PENDING", studentId: "s1" }]), { enabled: true });
  assert.equal(rules.posChargeAvailability([{ type: "MONTHLY", status: "PAID" }]).enabled, false);
  // 같은 학생 여러 건(수강료+셔틀비, 연체 섞임) → 활성
  const same = [
    { type: "MONTHLY", status: "PENDING", studentId: "s1" },
    { type: "SHUTTLE", status: "OVERDUE", studentId: "s1" },
  ];
  assert.deepEqual(rules.posChargeAvailability(same), { enabled: true });
  // 다른 학생이 섞이면 막고 이유 안내
  const mixed = rules.posChargeAvailability([...same, { type: "MONTHLY", status: "PENDING", studentId: "s2" }]);
  assert.equal(mixed.enabled, false);
  assert.match(mixed.reason, /다른 학생이 섞여 있어요/);
  // 학생을 모르면(옛 데이터) 막는다
  assert.equal(rules.posChargeAvailability([{ type: "MONTHLY", status: "PENDING" }, { type: "MONTHLY", status: "PENDING" }]).enabled, false);
  // 대상 아닌 유형·이미 납부가 섞이면 막는다
  const uniform = rules.posChargeAvailability([same[0], { type: "UNIFORM", status: "PENDING", studentId: "s1" }]);
  assert.equal(uniform.enabled, false);
  assert.match(uniform.reason, /유니폼 청구가 섞여 있어요/);
  const paid = rules.posChargeAvailability([same[0], { type: "MONTHLY", status: "PAID", studentId: "s1" }]);
  assert.equal(paid.enabled, false);
  assert.match(paid.reason, /미납·연체가 아닌 청구가 섞여 있어요/);
  // 최대 건수 = 서버 MAX_CHARGE_ITEMS
  const many = Array.from({ length: rules.POS_CHARGE_MAX_ITEMS + 1 }, () => same[0]);
  assert.equal(rules.posChargeAvailability(many).enabled, false);
  // «곧 추가됩니다» 문구는 사라졌다
  for (const t of [same, [same[0]]]) assert.doesNotMatch(JSON.stringify(rules.posChargeAvailability(t)), /곧 추가/);
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
  assert.match(finance, /onSelect: \(\) => \{?\s*(?:setRecordPreferPos\(false\);\s*)?setRecordTargets\(\[p\]\)/);
  assert.match(finance, /선택 항목 납부 처리/);
  assert.match(finance, /setRecordTargets\(targets\)/);
  // 현장 결제는 고른 청구 전부(1건 또는 같은 학생 여러 건)를 POS 창으로 넘긴다
  assert.match(finance, /setPosChargeTargets\(payments\.length > 0 \? payments : null\)/);
  // 안 되는 건을 뺀 «결제 가능 묶음»만 넘긴다(2026-11-08 막다른 버튼 제거)
  assert.match(modal, /onChoosePos\(pos\.groups\[0\]\.targets\)/);
  assert.match(modal, /onChoosePos\(g\.targets\)/);
  assert.match(finance, /studentId: t\.studentId/, "같은 학생 판단용 학생 id 를 창에 넘긴다");
  assert.match(modal, /recordBankTransferPayment\(checked\.value\)/);
  assert.match(modal, /planPosCharge\(targets\)/);
  assert.match(modal, /planBankTransfer\(targets\)/);
  // 계좌이체는 미납·연체인 건의 id 만 보낸다
  assert.match(modal, /paymentIds: transfer\.recordable\.map\(\(t\) => t\.id\)/);
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
  assert.match(modal, /\$\{targetNamesSummary\(targets\)\} · \$\{targets\.length\}건 선택/);
});

// ── 2026-11-08 원장 지시: 막다른 흐린 버튼 없애기 · 이미 납부 건 알리고 나머지만 처리 ──
const T = (id, o = {}) => ({ id, studentId: "s1", studentName: "홍길동", amount: 2500, type: "MONTHLY", status: "PENDING", month: 11, ...o });
const ids = (list) => list.map((t) => t.id);

test("planPosCharge: 단일 OK — 묶음 1개, 제외 없음", () => {
  const r = rules.planPosCharge([T("a")]);
  assert.equal(r.groups.length, 1);
  assert.deepEqual(ids(r.groups[0].targets), ["a"]);
  assert.equal(r.groups[0].total, 2500);
  assert.equal(r.excluded.length, 0);
});

test("planPosCharge: 이미 납부·환불·취소가 섞이면 그것만 빼고 나머지로 묶는다", () => {
  const r = rules.planPosCharge([T("a"), T("b", { status: "PAID" }), T("c", { type: "SHUTTLE", status: "OVERDUE" }), T("d", { status: "REFUNDED" }), T("e", { status: "CANCELED" })]);
  assert.deepEqual(ids(r.groups[0].targets), ["a", "c"]);
  assert.equal(r.groups[0].total, 5000);
  assert.deepEqual(r.excluded.map((e) => [e.target.id, e.reason]), [["b", "ALREADY_PAID"], ["d", "REFUNDED"], ["e", "CANCELED"]]);
  // 안내 문구: 어느 건이 왜 빠지고 몇 건·얼마가 처리되는지
  const msg = rules.excludedNotice(r.excluded.slice(0, 1), 2, 5000);
  assert.equal(msg, "이미 납부 1건(홍길동 11월 수강료)은 빼고, 미납 2건 합계 5,000원만 처리할까요?");
});

test("planPosCharge: 유니폼·금액 0원은 POS 에서만 빠지고 계좌이체로는 기록 가능", () => {
  const list = [T("a"), T("u", { type: "UNIFORM" }), T("z", { amount: 0, type: "OTHER" })];
  const r = rules.planPosCharge(list);
  assert.deepEqual(ids(r.groups[0].targets), ["a"]);
  assert.deepEqual(r.excluded.map((e) => e.reason), ["UNIFORM", "ZERO_AMOUNT"]);
  const b = rules.planBankTransfer(list);
  assert.deepEqual(ids(b.recordable), ["a", "u", "z"]);
  assert.equal(b.excluded.length, 0);
});

test("planPosCharge: 학생 둘이면 학생마다 묶음(처음 나온 순서) · 학생 id 없는 옛 데이터는 각자 1건", () => {
  const r = rules.planPosCharge([T("a"), T("k", { studentId: "s2", studentName: "김철수" }), T("b"), T("x", { studentId: "" }), T("y", { studentId: null })]);
  assert.deepEqual(r.groups.map((g) => [g.studentName, ids(g.targets)]), [
    ["홍길동", ["a", "b"]],
    ["김철수", ["k"]],
    ["홍길동", ["x"]],
    ["홍길동", ["y"]],
  ]);
  assert.equal(new Set(r.groups.map((g) => g.key)).size, 4, "묶음 키가 겹치지 않는다");
});

test("planPosCharge: 같은 학생 11건이면 10건 + 1건으로 나눈다(서버 한도와 같음)", () => {
  const list = Array.from({ length: 11 }, (_, i) => T(`p${i}`));
  const r = rules.planPosCharge(list);
  assert.deepEqual(r.groups.map((g) => g.targets.length), [rules.POS_CHARGE_MAX_ITEMS, 1]);
  assert.deepEqual(r.groups.map((g) => [g.part, g.parts]), [[1, 2], [2, 2]]);
  assert.equal(r.groups[0].total, 25000);
  assert.ok(r.groups.every((g) => g.targets.length <= rules.POS_CHARGE_MAX_ITEMS));
});

test("planPosCharge: 전부 불가면 묶음 0개 — 사유가 모두 남는다", () => {
  const r = rules.planPosCharge([T("a", { status: "PAID" }), T("u", { type: "UNIFORM" }), T("m", { amount: -1 })]);
  assert.equal(r.groups.length, 0);
  assert.deepEqual(r.excluded.map((e) => e.reason), ["ALREADY_PAID", "UNIFORM", "ZERO_AMOUNT"]);
  assert.match(rules.excludedNotice(r.excluded, 0, 0), /남는 청구가 없어요/);
  // 창은 이때만 버튼 대신 사유를 보인다
  assert.match(modal, /현장 결제할 수 있는 청구가 없어요/);
});

test("planBankTransfer·문구: 미납 아닌 건은 사유와 함께 빼고, 이름은 사유별 2건까지 «외 N건»", () => {
  const b = rules.planBankTransfer([T("a", { status: "PAID", label: "2026년 11월 수강료" }), T("b"), T("c", { status: "PAID", month: 10 }), T("d", { status: "PAID", studentName: "김철수" })]);
  assert.deepEqual(ids(b.recordable), ["b"]);
  assert.equal(
    rules.excludedNotice(b.excluded, 1, 2500),
    "이미 납부 3건(홍길동 2026년 11월 수강료, 홍길동 10월 수강료 외 1건)은 빼고, 미납 1건 합계 2,500원만 처리할까요?",
  );
  assert.equal(rules.planTargetLabel({ type: "SHUTTLE" }), "셔틀비");
  assert.equal(rules.planTargetLabel({ type: "OTHER", month: 3 }), "3월 기타");
});

test("납부 처리 창: preferPos 면 현장 결제 확인 화면으로 바로 열리고 계좌이체로 돌아갈 수 있다 · 같은 입금 정보 문구는 계좌이체 화면에", () => {
  assert.match(modal, /preferPos\?: boolean/);
  assert.match(modal, /useState<Step>\(\(\) => \(preferPos \? "pos" : "choose"\)\)/);
  assert.match(modal, /POS로 결제 요청/);
  assert.match(modal, /다른 방법\(계좌이체\)/);
  const transferAt = modal.indexOf('step === "transfer" && (');
  assert.ok(transferAt > 0);
  assert.ok(modal.indexOf("선택한 모든 건에 같은 입금 정보로 기록돼요") > transferAt, "문구는 계좌이체 입력 화면에만");
  // 막다른 흐린 POS 버튼(disabled={!pos.enabled})은 없어졌다
  assert.doesNotMatch(modal, /disabled=\{!pos\.enabled\}/);
});
