import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * 토스POS 결제 → 슬랙 DM 알림 회귀 테스트 (2026-09-30).
 *
 * 이 기능의 위험은 둘이다.
 *  ① 사람 판단 없이 사이트 청구서를 납부 처리하는 것(랠리즈가 원본인데 사이트가 앞서 간다)
 *  ② 결제 한 건에 DM 이 두 번 가거나 한 번도 안 가는 것
 * 그래서 분류 규칙은 순수 모듈을 **실행**해서, 돈 쓰기 경로는 가짜 prisma 를 끼워 **실행**해서,
 * 계약(원문 먼저 읽기·원장만·ON CONFLICT)은 소스에서 확인한다.
 */

const NOTICE_MODULE = "src/lib/pos/payment-notice.mjs";
const SERVICE = "src/lib/pos/paymentNoticeService.ts";
const ACTIONS = "src/lib/pos/paymentNoticeActions.ts";
const ROUTE = "src/app/api/slack/interactions/route.ts";
const SWEEP = "src/app/api/cron/pos-notice-sweep/route.ts";
const WEBHOOK = "src/app/api/webhooks/tossplace/route.ts";
const CLIENT = "src/lib/pos/tossplaceClient.ts";
const SLACK_CLIENT = "src/lib/slack/client.ts";
const MIGRATION = "prisma/migrations/20260930090000_add_pos_payment_notice/migration.sql";

const N = await import(pathToFileURL(path.resolve(NOTICE_MODULE)).href);
const { NOTICE_KIND: K } = N;

// ───────────────────────── 분류 규칙 (순수 · 실행) ─────────────────────────

const students = [
  { id: "s-kim", name: "김대건", classes: ["금요일 3교시"] },
  { id: "s-lee", name: "이시윤", classes: ["토요일 4교시"] },
  { id: "s-park", name: "박하늘", classes: ["금요일 3교시"] },
  { id: "s-jhA", name: "이현준A", classes: ["월요일 2교시"] },
  { id: "s-jhB", name: "이현준B", classes: ["월요일 2교시"] },
];
const row = (over) => ({ id: "p1", studentId: "s-lee", amount: 180000, status: "PENDING", type: "MONTHLY", year: 2026, month: 9, ...over });
const classify = (over = {}) =>
  N.classifyNotice({ memoRaw: "토4 이시윤 9월", memoNames: ["이시윤"], students, amount: 180000, kstDate: "2026-09-15", siteRows: [row()], ...over });

test("이름 정확히 일치 1명 + 같은 금액 미납 1건 ⇒ AUTO_CANDIDATE (사이트 청구서 ID 포함)", () => {
  const r = classify();
  assert.equal(r.kind, K.AUTO_CANDIDATE);
  assert.equal(r.resolvedStudentId, "s-lee");
  assert.equal(r.sitePaymentId, "p1");
  assert.deepEqual([r.targetYear, r.targetMonth], [2026, 9]);
});

test("성을 뺀 표기('대건')는 후보 1명이어도 절대 확정하지 않는다 ⇒ AMBIGUOUS", () => {
  const r = classify({ memoRaw: "금3 대건", memoNames: ["대건"], siteRows: [row({ studentId: "s-kim" })] });
  assert.equal(r.kind, K.AMBIGUOUS);
  assert.equal(r.resolvedStudentId, null);
  assert.equal(r.sitePaymentId, null);
  assert.deepEqual(r.nameCandidates.map((s) => s.id), ["s-kim"], "후보로는 제시한다");
});

test("동명이인 꼬리표(이현준A/B)는 '정확히 일치'가 아니다 ⇒ AMBIGUOUS", () => {
  const r = classify({ memoRaw: "이현준", memoNames: ["이현준"] });
  assert.equal(r.kind, K.AMBIGUOUS);
  assert.deepEqual(r.nameCandidates.map((s) => s.id).sort(), ["s-jhA", "s-jhB"]);
});

test("같은 달 같은 금액 PAID 가 있으면 ⇒ ALREADY_PAID (이중결제 의심)", () => {
  const r = classify({ siteRows: [row({ status: "PAID" })] });
  assert.equal(r.kind, K.ALREADY_PAID);
  assert.equal(r.sitePaymentId, null);
});

test("그 달 청구서가 없으면 ⇒ NO_SITE_INVOICE (취소 청구서만 있어도 없음으로 본다)", () => {
  assert.equal(classify({ siteRows: [] }).kind, K.NO_SITE_INVOICE);
  assert.equal(classify({ siteRows: [row({ status: "CANCELED" })] }).kind, K.NO_SITE_INVOICE);
  // 다른 달·다른 원생 청구서는 섞이지 않는다
  assert.equal(classify({ siteRows: [row({ month: 10 }), row({ studentId: "s-kim" })] }).kind, K.NO_SITE_INVOICE);
});

test("금액이 다르면 ⇒ AMOUNT_MISMATCH (사이트 금액을 함께 돌려준다)", () => {
  const r = classify({ siteRows: [row({ amount: 200000 })] });
  assert.equal(r.kind, K.AMOUNT_MISMATCH);
  assert.deepEqual(r.siteAmounts, [200000]);
});

test("같은 달 미납이 2건이면 금액이 같아도 자동 후보가 아니다", () => {
  const r = classify({ siteRows: [row(), row({ id: "p2" })] });
  assert.equal(r.kind, K.AMOUNT_MISMATCH);
  assert.equal(r.sitePaymentId, null);
});

test("메모가 없으면 ⇒ NO_MEMO, 명단에 없는 이름이면 ⇒ NOT_IN_ROSTER", () => {
  assert.equal(classify({ memoRaw: "", memoNames: [] }).kind, K.NO_MEMO);
  assert.equal(classify({ memoRaw: "토4 홍길동 9월", memoNames: ["홍길동"] }).kind, K.NOT_IN_ROSTER);
});

test("메모 '10월' + 9/28 결제 ⇒ 청구월 2026-10 (결제일의 달이 아니라 메모의 달)", () => {
  const r = classify({
    memoRaw: "토4 이시윤 10월",
    kstDate: "2026-09-28",
    siteRows: [row({ month: 9, id: "sep" }), row({ month: 10, id: "oct" })],
  });
  assert.deepEqual([r.targetYear, r.targetMonth], [2026, 10]);
  assert.equal(r.sitePaymentId, "oct");
});

test("메모에 달이 여럿이면 청구서 하나로 자동 묶지 않는다", () => {
  const r = classify({ memoRaw: "이시윤 9월, 10월" });
  assert.notEqual(r.kind, K.AUTO_CANDIDATE);
});

test("웹훅 본문에서 주문 ID 를 방어적으로 뽑는다", () => {
  assert.equal(N.extractOrderIdFromWebhook({ type: "payment.x", data: { orderId: "o-1" } }).orderId, "o-1");
  assert.equal(N.extractOrderIdFromWebhook({ type: "x", data: { order: { id: 77 } } }).orderId, "77");
  assert.equal(N.extractOrderIdFromWebhook({ type: "x", data: { payment: { orderId: "o-3" } } }).orderId, "o-3");
  assert.equal(N.extractOrderIdFromWebhook({ type: "order.order.completed.v1", data: { id: "o-4" } }).orderId, "o-4");
  assert.equal(N.extractOrderIdFromWebhook({ type: "payment.approved", data: { id: "pay-1" } }).orderId, "", "결제 알림의 data.id 는 주문 ID 가 아니다");
  assert.equal(N.extractOrderIdFromWebhook({ data: { orderId: "../cancel" } }).orderId, "", "경로 조작 문자는 버린다");
  assert.equal(N.extractOrderIdFromWebhook(null).orderId, "");
});

test("알림 대상은 카드 · 승인 결제뿐이다", () => {
  const order = {
    id: "o-1",
    memo: "토4 이시윤 10월",
    lineItems: [{ item: { title: "토요일 4교시" } }],
    payments: [
      { id: "pay-card", sourceType: "CARD", state: "APPROVED", amount: 180000, approvedAt: "2026-09-28T05:20:00Z" },
      { id: "pay-cash", sourceType: "CASH", state: "APPROVED", amount: 1000, approvedAt: "2026-09-28T05:20:00Z" },
      { id: "pay-cancel", sourceType: "CARD", state: "CANCELLED", amount: 180000, approvedAt: "2026-09-28T05:20:00Z" },
    ],
  };
  const list = N.extractNoticePayments(order);
  assert.deepEqual(list.map((p) => p.tossPaymentId), ["pay-card"]);
  assert.equal(list[0].kstDateTime, "2026-09-28 14:20", "UTC 05:20 은 KST 14:20");
  assert.equal(list[0].approvedAtIso, "2026-09-28T14:20:00+09:00");
  assert.equal(list[0].lineItems, "토요일 4교시");
  assert.deepEqual(list[0].memoNames, ["이시윤"]);
});

test("원생 고르기 후보: 같은 반(정확히 같은 이름) 원생 + 메모 이름 후보, 최대 20명", () => {
  const r = N.buildCandidateList({ kind: K.NO_MEMO, students, classTitles: ["금요일 3교시"] });
  assert.deepEqual(r.candidates.map((s) => s.id).sort(), ["s-kim", "s-park"]);
  assert.equal(N.buildCandidateList({ kind: K.NO_MEMO, students, classTitles: ["금요일 3교"] }).candidates.length, 0, "반 이름은 정확히 같아야 한다");
  const many = Array.from({ length: 25 }, (_, i) => ({ id: `x${i}`, name: `원생${String(i).padStart(2, "0")}`, classes: ["금요일 3교시"] }));
  const capped = N.buildCandidateList({ kind: K.NO_MEMO, students: many, classTitles: ["금요일 3교시"] });
  assert.equal(capped.candidates.length, 20);
  assert.equal(capped.overflow, 5);
  const amb = N.buildCandidateList({ kind: K.AMBIGUOUS, students, classTitles: ["토요일 4교시"], nameCandidates: [students[0]] });
  assert.deepEqual(amb.candidates.map((s) => s.id), ["s-kim", "s-lee"], "메모 이름 후보가 맨 앞");
});

test("DM: 필수 문구와 분류별 버튼", () => {
  const notice = { id: "n1", amount: 180000, kstDateTime: "2026-09-28 14:20", lineItems: "토요일 4교시", memo: "토4 이시윤 10월", targetYear: 2026, targetMonth: 10 };
  const ids = (m) => m.blocks.filter((b) => b.type === "actions").flatMap((b) => b.elements.map((e) => e.action_id));
  const all = (m) => JSON.stringify(m.blocks);

  const auto = N.buildNoticeMessage({ notice, kind: K.AUTO_CANDIDATE, studentName: "이시윤" });
  assert.match(all(auto), /랠리즈에서 현장결제 처리하셨나요\?/);
  assert.match(all(auto), /₩180,000/);
  assert.match(all(auto), /2026-09-28 14:20/);
  assert.match(all(auto), /토요일 4교시/);
  assert.match(all(auto), /사이트 청구서 10월 ₩180,000 미납 → 함께 납부 처리합니다/);
  assert.deepEqual(ids(auto), [N.ACTION.CONFIRM_PAY, N.ACTION.IGNORE]);
  assert.match(all(auto), /랠리즈 처리함 · 사이트 납부 반영/);

  const pick = N.buildNoticeMessage({ notice, kind: K.NO_MEMO, candidates: [{ id: "s-kim", name: "김대건", classes: [] }], overflow: 3 });
  assert.deepEqual(ids(pick), [`${N.ACTION.PICK_PREFIX}s-kim`, N.ACTION.ACK, N.ACTION.IGNORE]);
  assert.ok(!ids(pick).includes(N.ACTION.CONFIRM_PAY), "원생을 고르기 전에는 돈 버튼이 없다");
  assert.match(all(pick), /외 3명/);

  assert.match(all(N.buildNoticeMessage({ notice, kind: K.NO_SITE_INVOICE })), /사이트에 10월 청구서가 아직 없습니다\(랠리즈→사이트 미반영\)/);
  assert.match(all(N.buildNoticeMessage({ notice, kind: K.ALREADY_PAID })), /이미 10월 납부 기록이 있습니다 — 이중결제인지 확인해 주세요/);
  assert.match(all(N.buildNoticeMessage({ notice, kind: K.ALREADY_PAID })), /확인함/);
  assert.match(all(N.buildNoticeMessage({ notice, kind: K.AMOUNT_MISMATCH, siteAmounts: [200000] })), /₩200,000/);
  for (const kind of [K.NO_SITE_INVOICE, K.ALREADY_PAID, K.AMOUNT_MISMATCH]) {
    assert.ok(!ids(N.buildNoticeMessage({ notice, kind })).includes(N.ACTION.CONFIRM_PAY), `${kind} 에는 돈 버튼이 없다`);
  }

  const done = N.buildNoticeMessage({ notice, kind: K.AUTO_CANDIDATE, resultLine: "✅ 랠리즈 처리 확인" });
  assert.equal(ids(done).length, 0, "처리가 끝나면 버튼을 없앤다");
  assert.match(all(done), /✅ 랠리즈 처리 확인/);

  // 메모의 <, > 가 슬랙 링크·멘션으로 바뀌지 않는다
  assert.doesNotMatch(all(N.buildNoticeMessage({ notice: { ...notice, memo: "<!channel>" }, kind: K.NO_MEMO })), /<!channel>/);
});

test("버튼 값 해석: 모양이 틀리면 아무것도 하지 않는다", () => {
  assert.deepEqual(N.parseActionValue(N.ACTION.CONFIRM_PAY, "n1"), { type: "CONFIRM_PAY", noticeId: "n1" });
  assert.deepEqual(N.parseActionValue(`${N.ACTION.PICK_PREFIX}s1`, "n1|s1"), { type: "PICK", noticeId: "n1", studentId: "s1" });
  assert.equal(N.parseActionValue(`${N.ACTION.PICK_PREFIX}s1`, "n1|s2"), null, "버튼 ID 와 값의 원생이 다르면 무시");
  assert.equal(N.parseActionValue("other", "n1"), null);
  assert.equal(N.parseActionValue(N.ACTION.ACK, "n1'; DROP"), null);
});

// ───────────────── 실행 하네스 (prisma·슬랙·토스·원장부를 가짜로) ─────────────────

const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const transpile = async (file) =>
  ts.transpileModule(await readFile(file, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
const fileUrl = (f) => pathToFileURL(path.resolve(f)).href;

/** 가짜 prisma: SQL 모양으로 답을 고른다. 모든 호출을 globalThis.__calls 에 남긴다. */
const PRISMA_STUB = toDataUrl(`
  const S = () => globalThis.__state;
  const log = (kind, sql, args) => { globalThis.__calls.push({ kind, sql, args }); };
  const answer = (sql) => {
    if (/UPDATE "PosPaymentNotice" n/.test(sql)) { if (S().claimThrows) throw new Error("unique violation"); return S().claimRows; }
    if (/FROM "PosPaymentNotice" n\\s+LEFT JOIN/.test(sql)) return S().notice ? [S().notice] : [];
    if (/UPDATE "PosPaymentNotice"[\\s\\S]*SET status = 'NOTIFIED'/.test(sql)) return S().sendClaim ?? [];
    if (/UPDATE "PosPaymentNotice"[\\s\\S]*RETURNING id/.test(sql)) return [{ id: "n1" }];
    if (/SELECT id FROM "PosPaymentNotice"/.test(sql)) return [{ id: "n1" }];
    if (/INSERT INTO "PosPaymentNotice"/.test(sql)) return [{ id: "n1" }];
    if (/FROM "PosWebhookEvent"/.test(sql)) return S().events ?? [];
    if (/SELECT status FROM "Payment"/.test(sql)) return [{ status: S().paymentStatus ?? "PENDING" }];
    if (/FROM "Payment"/.test(sql)) return S().monthRows ?? [];
    if (/FROM "Student" s\\s+JOIN "Enrollment"/.test(sql)) return S().roster ?? [];
    if (/FROM "Student"/.test(sql)) return S().studentExists === false ? [] : [{ id: "s-x" }];
    return [];
  };
  export const prisma = {
    $queryRawUnsafe: async (sql, ...args) => { log("query", sql, args); return answer(sql); },
    $executeRawUnsafe: async (sql, ...args) => { log("execute", sql, args); return 1; },
  };
`);
const LEDGER_STUB = toDataUrl(`
  export async function markPaymentPaid(input) {
    globalThis.__paid.push(input);
    if (globalThis.__state.ledgerThrows) throw new Error("ledger failed");
  }
`);
const SLACK_STUB = toDataUrl(`
  export async function postMessage(m) { globalThis.__slack.push({ op: "post", ...m }); return { channel: "D1", ts: "1.1" }; }
  export async function updateMessage(m) { globalThis.__slack.push({ op: "update", ...m }); return { channel: m.channel, ts: m.ts }; }
  export async function respondEphemeral(url, text) { globalThis.__slack.push({ op: "ephemeral", text }); }
`);
const TOSS_STUB = toDataUrl(`
  export async function fetchTossOrderById(p) { globalThis.__toss.push(p); return { order: globalThis.__state.order, eventId: "e" }; }
`);

let loaded = null;
async function loadModules() {
  if (loaded) return loaded;
  let svc = await transpile(SERVICE);
  svc = svc
    .split('"@/lib/prisma"').join(`"${PRISMA_STUB}"`)
    .split('"@/lib/slack/client"').join(`"${SLACK_STUB}"`)
    .split('"./tossplaceClient"').join(`"${TOSS_STUB}"`)
    .split('"./tossplace-match.mjs"').join(`"${fileUrl("src/lib/pos/tossplace-match.mjs")}"`)
    .split('"./payment-notice.mjs"').join(`"${fileUrl(NOTICE_MODULE)}"`);
  const svcUrl = toDataUrl(svc);
  let act = await transpile(ACTIONS);
  act = act
    .split('"@/lib/prisma"').join(`"${PRISMA_STUB}"`)
    .split('"@/lib/payment-ledger"').join(`"${LEDGER_STUB}"`)
    .split('"@/lib/slack/client"').join(`"${SLACK_STUB}"`)
    .split('"./paymentNoticeService"').join(`"${svcUrl}"`)
    .split('"./payment-notice.mjs"').join(`"${fileUrl(NOTICE_MODULE)}"`);
  loaded = { service: await import(svcUrl), actions: await import(toDataUrl(act)) };
  return loaded;
}

const OWNER = "U099YJJNKC7";
const baseNotice = {
  id: "n1", tossPaymentId: "pay-1", tossOrderId: "o-1", amount: 180000,
  kstDateTime: "2026-09-28 14:20", kstDate: "2026-09-28", lineItems: "토요일 4교시", memo: "토4 이시윤 10월",
  resolvedStudentId: "s-lee", studentName: "이시윤", targetYear: 2026, targetMonth: 10, sitePaymentId: "p-oct",
  kind: "AUTO_CANDIDATE", pickedKind: null, status: "NOTIFIED", slackChannel: "D1", slackTs: "1.1", siteMarkedPaid: false,
};

async function run(action, state = {}, userId = OWNER) {
  const { actions } = await loadModules();
  globalThis.__state = { notice: { ...baseNotice }, claimRows: [], ...state };
  globalThis.__calls = [];
  globalThis.__paid = [];
  globalThis.__slack = [];
  globalThis.__toss = [];
  const saved = process.env.SLACK_OWNER_USER_ID;
  process.env.SLACK_OWNER_USER_ID = OWNER;
  try {
    await actions.handleSlackNoticeAction(action, { userId, responseUrl: "https://hooks.slack.com/x" });
  } finally {
    if (saved == null) delete process.env.SLACK_OWNER_USER_ID;
    else process.env.SLACK_OWNER_USER_ID = saved;
  }
  return { calls: globalThis.__calls, paid: globalThis.__paid, slack: globalThis.__slack };
}

const writes = (calls) => calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)/i.test(c.sql));

test("원장이 아니면 아무것도 바뀌지 않고 '권한이 없습니다'만 보인다", async () => {
  const r = await run({ type: "CONFIRM_PAY", noticeId: "n1" }, { claimRows: [{ id: "n1", sitePaymentId: "p-oct", tossOrderId: "o-1", tossPaymentId: "pay-1", approvedAtUtc: "2026-09-28T05:20:00Z" }] }, "U_SOMEONE");
  assert.equal(r.paid.length, 0);
  assert.equal(r.calls.length, 0, "DB 를 읽지도 않는다");
  assert.deepEqual(r.slack.map((s) => s.text), ["권한이 없습니다"]);
});

test("[사이트 납부 반영]: 재확인(선점) 통과 시에만 markPaymentPaid 1회 — 카드·TOSS_POS·주문ID·승인시각", async () => {
  const r = await run({ type: "CONFIRM_PAY", noticeId: "n1" }, {
    claimRows: [{ id: "n1", sitePaymentId: "p-oct", tossOrderId: "o-1", tossPaymentId: "pay-1", approvedAtUtc: "2026-09-28T05:20:00Z" }],
  });
  assert.equal(r.paid.length, 1);
  assert.equal(r.paid[0].paymentId, "p-oct");
  assert.equal(r.paid[0].method, "CARD");
  assert.equal(r.paid[0].provider, "TOSS_POS");
  assert.equal(r.paid[0].providerOrderId, "o-1");
  assert.equal(r.paid[0].paidAt, "2026-09-28T05:20:00Z");
  const claimAt = r.calls.findIndex((c) => /UPDATE "PosPaymentNotice" n/.test(c.sql));
  assert.ok(claimAt >= 0, "선점 UPDATE 가 먼저 실행된다");
  assert.ok(!r.calls.some((c) => /UPDATE\s+"Payment"/.test(c.sql)), "Payment 를 직접 고치지 않는다");
  const update = r.slack.find((s) => s.op === "update");
  assert.match(JSON.stringify(update.blocks), /✅ 랠리즈 처리 확인 · 사이트 10월 청구 납부 반영/);
});

test("[사이트 납부 반영]: 누른 순간 재확인이 실패하면 쓰지 않고 이유를 남긴다", async () => {
  const r = await run({ type: "CONFIRM_PAY", noticeId: "n1" }, {
    claimRows: [],
    monthRows: [{ id: "p-oct", studentId: "s-lee", amount: 180000, status: "PAID", type: "MONTHLY", year: 2026, month: 10 }],
  });
  assert.equal(r.paid.length, 0);
  const update = r.slack.find((s) => s.op === "update");
  assert.match(JSON.stringify(update.blocks), /사이트 납부 반영을 하지 않았습니다/);
  const reclass = r.calls.find((c) => /SET status = 'STUDENT_CHOSEN', "pickedKind"/.test(c.sql));
  assert.equal(reclass.args[1], "ALREADY_PAID", "지금 상태로 다시 판정해 둔다");
});

test("[사이트 납부 반영]: 다른 알림과 동시 선점(유일 인덱스 예외)이면 쓰지 않는다", async () => {
  const r = await run({ type: "CONFIRM_PAY", noticeId: "n1" }, { claimThrows: true });
  assert.equal(r.paid.length, 0);
});

test("[사이트 납부 반영]: 이미 처리된 알림(두 번째 클릭)은 아무것도 하지 않는다", async () => {
  const r = await run({ type: "CONFIRM_PAY", noticeId: "n1" }, { notice: { ...baseNotice, status: "CONFIRMED", siteMarkedPaid: true } });
  assert.equal(r.paid.length, 0);
  assert.equal(writes(r.calls).length, 0);
});

test("[사이트 납부 반영]: 원장부 쓰기가 실패하고 청구서가 미납이면 선점을 되돌린다", async () => {
  const r = await run({ type: "CONFIRM_PAY", noticeId: "n1" }, {
    claimRows: [{ id: "n1", sitePaymentId: "p-oct", tossOrderId: "o-1", tossPaymentId: "pay-1", approvedAtUtc: null }],
    ledgerThrows: true,
    paymentStatus: "PENDING",
  });
  assert.equal(r.paid.length, 1);
  const revert = r.calls.find((c) => /"siteMarkedPaid" = false, "decidedBySlackUser" = NULL/.test(c.sql));
  assert.ok(revert, "되돌리는 UPDATE 가 있어야 다시 누를 수 있다");
  assert.equal(revert.args[1], "NOTIFIED");
});

test("[랠리즈 처리함]·[학원 외 결제]·원생 고르기는 돈을 쓰지 않는다", async () => {
  for (const [action, state] of [
    [{ type: "ACK", noticeId: "n1" }, {}],
    [{ type: "IGNORE", noticeId: "n1" }, {}],
    [{ type: "PICK", noticeId: "n1", studentId: "s-lee" }, { notice: { ...baseNotice, kind: "AMBIGUOUS", resolvedStudentId: null, sitePaymentId: null },
      monthRows: [{ id: "p-oct", studentId: "s-lee", amount: 180000, status: "PENDING", type: "MONTHLY", year: 2026, month: 10 }] }],
  ]) {
    const r = await run(action, state);
    assert.equal(r.paid.length, 0, `${action.type} 는 markPaymentPaid 를 부르지 않는다`);
    assert.ok(!r.calls.some((c) => /"Payment"\s+SET|UPDATE\s+"Payment"/.test(c.sql)));
  }
});

test("원생을 고르면 최종 확인 버튼이 뜬다(돈은 두 번째 클릭에서만)", async () => {
  const picked = { ...baseNotice, kind: "AMBIGUOUS", status: "STUDENT_CHOSEN", pickedKind: "AUTO_CANDIDATE" };
  const r = await run({ type: "PICK", noticeId: "n1", studentId: "s-lee" }, {
    notice: { ...baseNotice, kind: "AMBIGUOUS", resolvedStudentId: null, sitePaymentId: null },
    monthRows: [{ id: "p-oct", studentId: "s-lee", amount: 180000, status: "PENDING", type: "MONTHLY", year: 2026, month: 10 }],
  });
  const pick = r.calls.find((c) => /SET status = 'STUDENT_CHOSEN', "resolvedStudentId"/.test(c.sql));
  assert.deepEqual(pick.args.slice(1), ["s-lee", "AUTO_CANDIDATE", "p-oct"]);
  // 다시 그린 메시지는 DB 기준(여기선 가짜 prisma 가 고르기 전 행을 돌려준다) — 고른 뒤 행으로 한 번 더 확인
  const { service } = await loadModules();
  globalThis.__state = { ...globalThis.__state, notice: picked };
  const msg = await service.renderNotice(picked);
  assert.match(JSON.stringify(msg.blocks), /pos_notice_confirm_pay/);
});

test("웹훅 처리: 카드·승인 결제만 결제ID 로 한 줄씩 기록(ON CONFLICT) — 청구서는 건드리지 않는다", async () => {
  const { service } = await loadModules();
  globalThis.__state = {
    events: [{ id: "ev1", eventType: "order.order.completed.v1", payload: { type: "order.order.completed.v1", data: { id: "o-1" } }, processedAt: null }],
    order: {
      id: "o-1", memo: "토4 이시윤 10월", lineItems: [{ item: { title: "토요일 4교시" } }],
      payments: [
        { id: "pay-card", sourceType: "CARD", state: "APPROVED", amount: 180000, approvedAt: "2026-09-28T05:20:00Z" },
        { id: "pay-cash", sourceType: "CASH", state: "APPROVED", amount: 1000, approvedAt: "2026-09-28T05:20:00Z" },
      ],
    },
    roster: [{ id: "s-lee", name: "이시윤", classes: ["토요일 4교시"] }],
    monthRows: [{ id: "p-oct", studentId: "s-lee", amount: 180000, status: "PENDING", type: "MONTHLY", year: 2026, month: 10 }],
    sendClaim: [],
  };
  globalThis.__calls = []; globalThis.__slack = []; globalThis.__toss = [];
  const env = { TOSS_PLACE_ACCESS_KEY: "k", TOSS_PLACE_ACCESS_SECRET: "s", TOSS_PLACE_MERCHANT_ID: "324744" };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  try {
    const r = await service.processPosWebhookEvent("ev1");
    assert.equal(r.notices, 1);
  } finally {
    for (const [k, v] of Object.entries(saved)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  }
  assert.equal(globalThis.__toss[0].orderId, "o-1");
  const inserts = globalThis.__calls.filter((c) => /INSERT INTO "PosPaymentNotice"/.test(c.sql));
  assert.equal(inserts.length, 1);
  assert.match(inserts[0].sql, /ON CONFLICT \("tossPaymentId"\) DO NOTHING/);
  assert.equal(inserts[0].args[0], "pay-card");
  assert.equal(inserts[0].args.at(-1), "AUTO_CANDIDATE");
  assert.equal(inserts[0].args[9], "p-oct");
  assert.ok(!globalThis.__calls.some((c) => /UPDATE\s+"Payment"|INSERT INTO "Payment"/.test(c.sql)));
  assert.ok(globalThis.__calls.some((c) => /UPDATE "PosWebhookEvent"[\s\S]*"processedAt" = now\(\)/.test(c.sql)));
});

test("웹훅 처리: 다루지 않는 알림 종류는 IGNORED 로 표시하고 끝낸다", async () => {
  const { service } = await loadModules();
  globalThis.__state = { events: [{ id: "ev2", eventType: "merchant.updated", payload: {}, processedAt: null }] };
  globalThis.__calls = []; globalThis.__toss = [];
  await service.processPosWebhookEvent("ev2");
  const mark = globalThis.__calls.find((c) => /UPDATE "PosWebhookEvent"/.test(c.sql));
  assert.equal(mark.args[1], "IGNORED");
  assert.equal(globalThis.__toss.length, 0, "토스를 조회하지 않는다");
});

// ───────────────────────── 소스 계약 ─────────────────────────

const src = {
  route: await readFile(ROUTE, "utf8"),
  sweep: await readFile(SWEEP, "utf8"),
  service: await readFile(SERVICE, "utf8"),
  actions: await readFile(ACTIONS, "utf8"),
  module: await readFile(NOTICE_MODULE, "utf8"),
  webhook: await readFile(WEBHOOK, "utf8"),
  client: await readFile(CLIENT, "utf8"),
  slack: await readFile(SLACK_CLIENT, "utf8"),
};

test("슬랙 라우트: 원문(req.text())을 먼저 읽고 → 서명 검증 → 원장 확인 → 처리", () => {
  const rawAt = src.route.indexOf("await req.text()");
  const verifyAt = src.route.indexOf("verifySlackSignature({");
  const ownerAt = src.route.indexOf("process.env.SLACK_OWNER_USER_ID");
  const handleAt = src.route.indexOf("handleSlackNoticeAction(action");
  assert.ok(rawAt > 0 && verifyAt > rawAt && ownerAt > verifyAt && handleAt > ownerAt);
  assert.doesNotMatch(src.route, /req\.json\(\)|req\.formData\(\)/);
  assert.match(src.route, /status: 401/);
  assert.match(src.route, /권한이 없습니다/);
});

test("돈 쓰기는 markPaymentPaid 한 곳, 그것도 [납부 반영] 클릭 + 선점 재확인 뒤에만", () => {
  const newCode = [src.route, src.sweep, src.service, src.actions, src.module, src.webhook, src.slack];
  for (const code of newCode) {
    assert.doesNotMatch(code, /UPDATE\s+"Payment"/i, "Payment 를 직접 고치지 않는다");
    assert.doesNotMatch(code, /UPDATE\s+"PaymentInvoice"/i);
  }
  for (const code of [src.route, src.sweep, src.service, src.module, src.webhook]) {
    assert.doesNotMatch(code, /markPaymentPaid/, "납부 처리는 버튼 처리 파일에만 있다");
  }
  const calls = [...src.actions.matchAll(/await markPaymentPaid\(/g)];
  assert.equal(calls.length, 1, "markPaymentPaid 호출은 딱 한 곳");
  const fnStart = src.actions.indexOf("async function confirmPay(");
  const claimAt = src.actions.indexOf("CLAIM_PAY_SQL, notice.id", fnStart);
  const emptyAt = src.actions.indexOf("claimed.length === 0", fnStart);
  const payAt = src.actions.indexOf("await markPaymentPaid(", fnStart);
  assert.ok(fnStart > 0 && claimAt > fnStart && emptyAt > claimAt && payAt > emptyAt, "선점 → 실패면 return → 그다음 납부");
  assert.match(src.actions, /if \(action\.type === "CONFIRM_PAY"\) return confirmPay\(/);
  // 선점 SQL 이 재확인 조건을 모두 담는다
  const claimSql = src.actions.slice(src.actions.indexOf("const CLAIM_PAY_SQL"), src.actions.indexOf("RETURNING n.id"));
  assert.match(claimSql, /p\.status IN \('PENDING', 'OVERDUE'\) AND p\.amount = n\.amount/);
  assert.match(claimSql, /\) = 1/);
  assert.match(claimSql, /o\."siteMarkedPaid" = true AND o\.id <> n\.id/);
  assert.match(claimSql, /p\.status = 'PAID' AND p\.amount = n\.amount/);
});

test("알림 기록은 결제ID 로 DB 가 중복을 막는다", () => {
  assert.match(src.service, /ON CONFLICT \("tossPaymentId"\) DO NOTHING/);
});

test("토스 클라이언트는 여전히 조회(GET) 전용이다", () => {
  assert.match(src.client, /assertReadOnlyTossRequest\(method, pathname\)/);
  assert.doesNotMatch(src.client, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
  assert.match(src.client, /request\("GET", `\/merchants\/\$\{merchantId\}\/order\/orders\/\$\{orderId\}`\)/);
});

test("스윕 크론: CRON_SECRET 확인 + vercel.json 10분 주기 등록", async () => {
  assert.match(src.sweep, /Bearer \$\{secret\}/);
  const vercel = JSON.parse(await readFile("vercel.json", "utf8"));
  assert.ok(vercel.crons.some((c) => c.path === "/api/cron/pos-notice-sweep" && c.schedule === "*/10 * * * *"));
});

test("웹훅 라우트: 새로 저장된 경우에만 처리하고, 처리 실패가 응답을 바꾸지 않는다", () => {
  assert.match(src.webhook, /RETURNING id/);
  assert.match(src.webhook, /if \(insertedRows\[0\]\) await tryProcessNow\(insertedRows\[0\]\.id\)/);
  const fn = src.webhook.slice(src.webhook.indexOf("async function tryProcessNow"), src.webhook.indexOf("export async function POST"));
  assert.match(fn, /catch \(processError\)/);
  assert.match(fn, /PROCESS_TIMEOUT_MS/);
});

test("슬랙 클라이언트: ok:false 를 실패로 보고, 토큰이 없으면 한국어 오류", () => {
  assert.match(src.slack, /json\.ok !== true/);
  assert.match(src.slack, /SLACK_BOT_TOKEN\)이 설정되지 않아/);
  assert.doesNotMatch(src.slack, /console\.(log|error|warn)\([^)]*token/i, "토큰을 로그에 남기지 않는다");
});

// ───────────────────────── 스키마 ↔ 마이그레이션 일치 ─────────────────────────

test("schema.prisma 의 PosPaymentNotice 가 마이그레이션 컬럼과 똑같다", async () => {
  const schema = await readFile("prisma/schema.prisma", "utf8");
  const start = schema.indexOf("model PosPaymentNotice {");
  assert.ok(start >= 0, "schema.prisma 에 model PosPaymentNotice 가 없습니다");
  const block = schema.slice(start, schema.indexOf("\n}", start));
  const modelCols = [...block.matchAll(/^\s{2}([a-zA-Z]+)\s+(String|BigInt|Int|Boolean|DateTime)(\?)?/gm)].map((m) => ({
    name: m[1], type: m[2], optional: !!m[3],
  }));

  const sql = await readFile(MIGRATION, "utf8");
  const table = sql.slice(sql.indexOf('CREATE TABLE IF NOT EXISTS "PosPaymentNotice"'), sql.indexOf("CONSTRAINT"));
  const typeMap = { TEXT: "String", BIGINT: "BigInt", INTEGER: "Int", BOOLEAN: "Boolean", TIMESTAMPTZ: "DateTime" };
  const sqlCols = [...table.matchAll(/^\s+"([a-zA-Z]+)"\s+([A-Z]+)(.*)$/gm)].map((m) => ({
    name: m[1], type: typeMap[m[2]], optional: !/NOT NULL|PRIMARY KEY/.test(m[3]),
  }));

  assert.deepEqual(modelCols.map((c) => c.name).sort(), sqlCols.map((c) => c.name).sort(), "컬럼 목록이 다릅니다");
  for (const col of sqlCols) {
    const m = modelCols.find((c) => c.name === col.name);
    assert.equal(m.type, col.type, `${col.name} 타입이 다릅니다`);
    assert.equal(m.optional, col.optional, `${col.name} NULL 허용 여부가 다릅니다`);
  }
  assert.match(block, /tossPaymentId\s+String\s+@unique/);
  assert.match(block, /@@index\(\[status, createdAt\(sort: Desc\)\]\)/);
  assert.match(block, /@@index\(\[tossOrderId\]\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "PosPaymentNotice_tossPaymentId_key"/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE "PosPaymentNotice" FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /REVOKE DELETE, TRUNCATE ON TABLE "PosPaymentNotice" FROM service_role/);
  // 분류 CHECK 가 순수 모듈의 목록과 같다
  const kindCheck = sql.slice(sql.indexOf('"PosPaymentNotice_kind_check"'), sql.indexOf('"PosPaymentNotice_pickedKind_check"'));
  for (const kind of Object.values(K)) assert.match(kindCheck, new RegExp(`'${kind}'`));
});
