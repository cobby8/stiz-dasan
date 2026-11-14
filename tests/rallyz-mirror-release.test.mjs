import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { join, resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

// 2026-11-14 랠리즈 은퇴 2단계 — 미납으로 남은 랠리즈 사본 청구를 «사이트에서 받기»(원장 결정).
// 원장이 랠리즈 쪽 청구를 취소한 사본에 PaymentAuditLog action = 'RALLYZ_MIRROR_RELEASED_TO_SITE' 를 붙이면
// 그 결제는 더 이상 사본이 아니다(= 일반 미납 청구). 판정은 parentSendGuard.rallyzMirrorExclusionSql 한 곳.
// 가장 위험한 실수 = 반환 SQL 에 OR 이 들어갔는데 괄호가 없어 `AND` 사용처의 앞 조건이 무시되는 것 → 실행으로 못박는다.

const nodeRequire = createRequire(import.meta.url);
const load = (path, mocks = {}) => {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: absolute,
  }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => (name in mocks ? mocks[name] : nodeRequire(name));
  module._compile(compiled, absolute);
  return module.exports;
};

const guard = load("src/lib/billing/parentSendGuard.ts");
const plan = load("src/lib/enrollment/pause-settlement-plan.ts");
const bundle = load("src/lib/payments/checkoutBundle.ts", {
  "./taxFree": { taxFreeAmountFor: () => 0 },
  "@/lib/pos/charge-request.mjs": { sortChargeItems: (rows) => rows },
});
const requestRules = load("src/lib/payments/parentRequestRules.ts");

/** 공백을 한 칸으로 줄인다(줄바꿈·들여쓰기와 무관하게 비교) */
const squash = (text) => text.replace(/\s+/g, " ").trim();

/**
 * 반환 SQL 을 그대로 JS 논리식으로 옮긴다(조각 3개만 바꾸고 AND/OR/NOT 과 괄호는 SQL 그대로 둔다).
 * 모르는 글자가 남으면 실패 — SQL 모양이 바뀌면 이 테스트도 같이 봐야 한다.
 */
function sqlToJs(sql, alias) {
  const js = squash(sql)
    .replace(`COALESCE(${alias}.method, '') <> 'RALLYZ'`, "(row.method !== 'RALLYZ')")
    .replace(
      `EXISTS ( SELECT 1 FROM "PaymentAuditLog" mirror_log WHERE mirror_log."paymentId" = ${alias}.id AND mirror_log.action = 'RALLYZ_APPROVED_EXISTING_INVOICE_MIRROR' )`,
      "row.mirrorLog",
    )
    .replace(
      `EXISTS ( SELECT 1 FROM "PaymentAuditLog" release_log WHERE release_log."paymentId" = ${alias}.id AND release_log.action = 'RALLYZ_MIRROR_RELEASED_TO_SITE' )`,
      "row.releaseLog",
    )
    .replace(/\bAND\b/g, "&&")
    .replace(/\bOR\b/g, "||")
    .replace(/\bNOT\b/g, "!");
  assert.match(js, /^[\s()!&|]*(?:(?:\(row\.method !== 'RALLYZ'\)|row\.mirrorLog|row\.releaseLog|other)[\s()!&|]*)+$/, `알 수 없는 SQL: ${js}`);
  return js;
}
const evalJs = (js, row, other) => new Function("row", "other", `return Boolean(${js});`)(row, other);

/** 경우의 수 전부: method(RALLYZ/그 밖/없음) × 사본 기록 × 풀어 준 기록 */
const CASES = [];
for (const method of ["RALLYZ", "CARD", null]) {
  for (const mirrorLog of [false, true]) {
    for (const releaseLog of [false, true]) CASES.push({ method, mirrorLog, releaseLog });
  }
}
/** 기대값: 일반 청구인가 = (사본이 아니다) 또는 (풀어 준 기록이 있다) */
const expectedNormal = (row) => !(row.method === "RALLYZ" || row.mirrorLog) || row.releaseLog;

test("① 반환 SQL 은 전체가 괄호 한 쌍으로 감싸여 있다", () => {
  const sql = squash(guard.rallyzMirrorExclusionSql("p"));
  assert.ok(sql.startsWith("(") && sql.endsWith(")"), "앞뒤 괄호");
  // 첫 괄호가 «맨 끝»에서 닫혀야 한다 — `(a) OR (b)` 처럼 조각마다 감싼 것은 통과시키지 않는다
  let depth = 0;
  for (let i = 0; i < sql.length; i += 1) {
    if (sql[i] === "(") depth += 1;
    if (sql[i] === ")") depth -= 1;
    assert.ok(depth >= 0, "괄호 짝");
    if (depth === 0) assert.equal(i, sql.length - 1, "바깥 괄호가 중간에 닫히면 안 된다");
  }
  assert.equal(depth, 0);
  assert.doesNotMatch(sql, /--/, "SQL 주석이 있으면 한 줄로 이어 붙인 사용처가 깨진다");
  assert.doesNotMatch(sql, /description/i, "문구로 판별하지 않는다");
  // 별칭이 그대로 들어간다(pm = POS 결제 안내)
  assert.match(squash(guard.rallyzMirrorExclusionSql("pm")), /release_log\."paymentId" = pm\.id/);
});

test("① 진리표: «참 = 일반 청구» — 사본이 아니거나 풀어 준 기록이 있을 때만 참", () => {
  const js = sqlToJs(guard.rallyzMirrorExclusionSql("p"), "p");
  for (const row of CASES) assert.equal(evalJs(js, row, true), expectedNormal(row), JSON.stringify(row));
  // 손으로 적은 대표 경우
  assert.equal(evalJs(js, { method: "RALLYZ", mirrorLog: true, releaseLog: false }, true), false, "안 푼 사본 = 일반 청구 아님");
  assert.equal(evalJs(js, { method: "RALLYZ", mirrorLog: true, releaseLog: true }, true), true, "푼 사본(method 남음) = 일반 청구");
  assert.equal(evalJs(js, { method: null, mirrorLog: true, releaseLog: true }, true), true, "푼 사본(method 비움) = 일반 청구");
  assert.equal(evalJs(js, { method: null, mirrorLog: true, releaseLog: false }, true), false, "method 만 비우고 표시가 없으면 여전히 사본");
  assert.equal(evalJs(js, { method: null, mirrorLog: false, releaseLog: false }, true), true, "처음부터 일반 청구");
});

test("① 사용 모양 둘: `other AND ${sql}` 와 `NOT (${sql})` 에서 논리가 맞다", () => {
  const sql = guard.rallyzMirrorExclusionSql("p");
  const andShape = sqlToJs(`other AND ${sql}`, "p");
  const andTailShape = sqlToJs(`other AND ${sql} AND other`, "p");
  const notShape = sqlToJs(`NOT (${sql})`, "p");
  for (const row of CASES) {
    for (const other of [false, true]) {
      // 괄호가 없으면 other=false 인데도 풀어 준 사본이 참이 된다(앞 조건 무시) — 미납 아닌 청구에 안내가 나가는 사고
      assert.equal(evalJs(andShape, row, other), other && expectedNormal(row), `AND ${JSON.stringify(row)} other=${other}`);
      assert.equal(evalJs(andTailShape, row, other), other && expectedNormal(row), `AND..AND ${JSON.stringify(row)} other=${other}`);
    }
    assert.equal(evalJs(notShape, row, true), !expectedNormal(row), `NOT ${JSON.stringify(row)}`);
  }
  // 괄호를 벗긴 SQL 이면 위 단언이 실제로 깨지는지(테스트가 헛돌지 않는지) 확인
  const squashed = squash(sql);
  const stripped = sqlToJs(`other AND ${squashed.slice(1, -1)}`, "p");
  assert.equal(evalJs(stripped, { method: "RALLYZ", mirrorLog: true, releaseLog: true }, false), true, "괄호가 없으면 앞 조건이 무시된다(그래서 괄호가 필수)");
});

test("① 모든 사용처가 `AND ${...}` 또는 `NOT (${...})` 모양으로만 쓴다", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(name)) files.push(full);
    }
  };
  walk("src");
  let uses = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/(.{0,12})\$\{rallyzMirrorExclusionSql\("(\w+)"\)\}/g)) {
      uses += 1;
      assert.match(match[1], /(AND |NOT \()$/, `${file}: ${match[0]}`);
    }
  }
  // 발송 2 · 결제 시작/후보 2 · 승인 직전 1 · POS 자동 1 · POS 안내 1 · 휴원 정산 2
  // · 부상 결석 발행 보류 1(illness-period-admin.ts HOLD_TARGET_SCOPE — 랠리즈 사본 청구는 보류로 돌리지 않는다, `AND ${...}` 모양)
  assert.equal(uses, 10,"사용처 수가 바뀌면 새 사용처의 모양(괄호·뜻)을 확인하고 이 숫자를 고친다");
});

test("② 풀어 준 표시 상수와 조건", () => {
  assert.equal(guard.RALLYZ_MIRROR_RELEASED_ACTION, "RALLYZ_MIRROR_RELEASED_TO_SITE");
  assert.equal(guard.RALLYZ_MIRROR_AUDIT_ACTION, "RALLYZ_APPROVED_EXISTING_INVOICE_MIRROR");
  const sql = squash(guard.rallyzMirrorExclusionSql("p"));
  assert.match(sql, /OR EXISTS \( SELECT 1 FROM "PaymentAuditLog" release_log WHERE release_log\."paymentId" = p\.id AND release_log\.action = 'RALLYZ_MIRROR_RELEASED_TO_SITE' \)/);
  // 옛 조건(사본 판정)은 그대로 남아 있다
  assert.match(sql, /COALESCE\(p\.method, ''\) <> 'RALLYZ' AND NOT EXISTS \(/);
  assert.match(sql, /mirror_log\.action = 'RALLYZ_APPROVED_EXISTING_INVOICE_MIRROR'/);
  // 잠금 스위치는 그대로(정확히 "1" 일 때만)
  assert.equal(guard.isBillingParentSendEnabled({}), false);
  assert.equal(guard.isBillingParentSendEnabled({ BILLING_PARENT_SEND_ENABLED: "1" }), true);
});

test("③ 문구: 안 푼 사본은 랠리즈 앱이 아니라 학원 문의로 안내한다", () => {
  assert.equal(bundle.BUNDLE_BLOCK_MESSAGE.RALLYZ_MIRROR, "이 청구는 아직 사이트 결제가 열리지 않았습니다. 학원으로 문의해 주세요.");
  // 학부모에게 보이는 화면·규칙 파일에 «랠리즈 앱에서 결제» 안내가 남아 있지 않다
  for (const path of [
    "src/lib/payments/checkoutBundle.ts",
    "src/lib/payment-ledger.ts",
    "src/app/pay/[token]/page.tsx",
    "src/app/mypage/payments/PaymentRequestClient.tsx",
    "src/app/mypage/payments/checkout/BundleCheckoutClient.tsx",
  ]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /랠리즈 앱|랠리즈로 안내된/, path);
  }
  // 판정은 그대로: 사본이면 막고(권한 다음 순서), 풀어 준 사본(rallyzMirror=false)은 일반 청구처럼 통과
  const row = { paymentId: "p1", invoiceId: "i1", studentId: "s1", studentName: "합성", type: "MONTHLY", year: 2026, month: 10,
    title: "10월 수강료", paymentStatus: "OVERDUE", invoiceStatus: "SENT", amount: 140000, invoiceAmount: 140000, isPayer: true, rallyzMirror: true };
  assert.equal(bundle.bundleItemBlock(row), "RALLYZ_MIRROR");
  assert.equal(bundle.bundleItemBlock({ ...row, rallyzMirror: false }), null);
  assert.equal(bundle.bundleItemBlock({ ...row, isPayer: false }), "NOT_PAYER", "권한 검사가 먼저");
});

test("③ 입금 확인 요청: «랠리즈»는 새로 고를 수 없고, 과거 요청 이름표는 남는다", () => {
  assert.deepEqual([...requestRules.PAYMENT_METHODS], ["TRANSFER", "CARD", "CASH"]);
  assert.equal(requestRules.PAYMENT_METHOD_LABEL.RALLYZ, "랠리즈");
  const unpaid = { paymentStatus: "PENDING", today: "2026-11-14" };
  assert.equal(requestRules.validatePaymentRequest({ kind: "PAYMENT_CLAIM", method: "RALLYZ", paidOn: "2026-11-13" }, unpaid).error, "METHOD_REQUIRED");
  assert.equal(requestRules.validatePaymentRequest({ kind: "PAYMENT_CLAIM", method: "TRANSFER", paidOn: "2026-11-13" }, unpaid).ok, true);
});

test("④ paidChannel: 풀어 준 사본을 사이트에서 받으면 환불 경로가 RALLYZ 로 가지 않는다", () => {
  // 풀어 준 사본 = SQL 판정 rallyzMirror=false. method 를 비운 경우(총괄 계획)와 RALLYZ 가 남은 경우 둘 다 본다.
  const ch = (over) => plan.paidChannel({ paidProvider: null, method: null, rallyzMirror: false, tossTx: null, ...over });
  for (const leftover of [null, "RALLYZ"]) {
    const label = `method=${leftover}`;
    // 토스 온라인(카드·간편결제) — 결제 때 method 가 안 덮였어도(COALESCE) 받은 곳 기록으로 판정
    assert.equal(ch({ method: leftover, paidProvider: "TOSS", tossTx: { transactionId: "t", method: "카드" } }), "TOSS", label);
    assert.equal(ch({ method: leftover, paidProvider: "TOSS", tossTx: { transactionId: "t", method: "가상계좌" } }), "TOSS_VA", label);
    // 토스인데 거래 기록을 못 찾음 — 자동으로 돈을 움직이지 않고(사람), 랠리즈로도 보내지 않는다
    assert.equal(ch({ method: leftover, paidProvider: "TOSS", tossTx: null }), "MANUAL", label);
    // 현장 POS
    assert.equal(ch({ method: leftover, paidProvider: "TOSS_POS" }), "TOSS_POS", label);
    // 수동(계좌이체·현금) — 관리자 납부 처리·직원 수납 확인은 paidProvider 'MANUAL'
    assert.equal(ch({ method: leftover, paidProvider: "MANUAL" }), "MANUAL", label);
  }
  assert.equal(ch({ method: "계좌이체", paidProvider: "MANUAL" }), "MANUAL");
});

test("④ paidChannel: 과거 랠리즈 납부 사본의 뜻은 그대로(환불 경로 RALLYZ)", () => {
  const ch = (over) => plan.paidChannel({ paidProvider: null, method: null, rallyzMirror: false, tossTx: null, ...over });
  // 안 푼 사본(SQL 판정 rallyzMirror=true) — 받은 곳 기록이 무엇이든 랠리즈
  assert.equal(ch({ rallyzMirror: true, method: "RALLYZ" }), "RALLYZ");
  assert.equal(ch({ rallyzMirror: true, method: null }), "RALLYZ", "사본 감사기록만 있는 납부 사본");
  assert.equal(ch({ rallyzMirror: true, method: "RALLYZ", paidProvider: "MANUAL" }), "RALLYZ");
  // 납부된 사본에 실수로 풀어 준 표시가 붙어도(rallyzMirror=false) 받은 곳 기록이 없으면 랠리즈로 남는다
  assert.equal(ch({ method: "RALLYZ" }), "RALLYZ");
  assert.equal(ch({ method: "rallyz", paidProvider: "" }), "RALLYZ");
  assert.equal(ch({ method: "RALLYZ", paidProvider: "RALLYZ" }), "RALLYZ");
});

test("④ 휴원 정산 계획: 풀어 준 미납 사본은 사이트 청구(바로 감액), 안 푼 사본은 사람 할 일, 환불은 토스만 자동", () => {
  const NOV = ["2026-11-03", "2026-11-10", "2026-11-17", "2026-11-24"];
  const pay = (over) => ({ paymentId: "p", year: 2026, month: 11, amount: 140000, status: "PAID", paidProvider: null, method: null,
    rallyzMirror: false, tossTx: null, busy: false, classDates: NOV, settledDates: [], priorReduction: 0, ...over });
  const result = plan.planPauseSettlement({
    pauseFrom: "2026-11-17", resumeOn: null,
    payments: [
      pay({ paymentId: "a-released-unpaid", status: "OVERDUE", method: "RALLYZ" }),
      pay({ paymentId: "b-mirror-unpaid", status: "OVERDUE", method: "RALLYZ", rallyzMirror: true }),
      pay({ paymentId: "c-released-toss", method: "RALLYZ", paidProvider: "TOSS", tossTx: { transactionId: "t1", method: "카드" } }),
      pay({ paymentId: "d-released-manual", method: "RALLYZ", paidProvider: "MANUAL" }),
      pay({ paymentId: "e-rallyz-paid", method: "RALLYZ", rallyzMirror: true }),
    ],
  });
  const channels = Object.fromEntries(result.lines.map((line) => [line.paymentId, line.channel]));
  assert.deepEqual(channels, {
    "a-released-unpaid": "SITE", "b-mirror-unpaid": "RALLYZ", "c-released-toss": "TOSS", "d-released-manual": "MANUAL", "e-rallyz-paid": "RALLYZ",
  });
  const refund = Object.fromEntries(plan.settlementLineDrafts(result, "REFUND").lines.map((l) => [l.paymentId, `${l.kind}:${l.status}`]));
  assert.deepEqual(refund, {
    "a-released-unpaid": "UNPAID_REDUCE:DONE", "b-mirror-unpaid": "UNPAID_REDUCE:TODO",
    "c-released-toss": "REFUND:REQUESTED", "d-released-manual": "REFUND:TODO", "e-rallyz-paid": "REFUND:TODO",
  });
  // 랠리즈로 받은 돈은 어떤 경우에도 자동 환불(REQUESTED)이 되지 않는다
  assert.equal(plan.settlementLineDrafts(result, "REFUND").lines.filter((l) => l.status === "REQUESTED").length, 1);
});

test("④ 휴원 정산·이월 차감 SQL 은 공용 조건 하나를 쓴다(직접 method 를 보지 않는다)", () => {
  const service = readFileSync("src/lib/enrollment/pause-settlement.ts", "utf8");
  assert.match(service, /NOT \(\$\{rallyzMirrorExclusionSql\("p"\)\}\) AS "rallyzMirror"/);
  assert.match(service, /AND \$\{rallyzMirrorExclusionSql\("p"\)\}/);
  assert.doesNotMatch(service, /method\s*(=|<>|!=)\s*'RALLYZ'/);
});
