// 청구서 안내·미납 안내 «발송 대기열» 실행 테스트(2026-11-13).
// 실제 문자·DB 는 쓰지 않는다 — 가짜 DB(메모리 표)와 가짜 대기열 예약 함수로 돌린다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const q = await loadTsModule("src/lib/billing/noticeQueue.ts");
const keyGuard = await loadTsModule("src/lib/payments/productionKeyGuard.ts");
const overdue = await loadTsModule("src/lib/payments/overdueRule.ts");
const read = (p) => readFileSync(p, "utf8");

const LINK = "https://www.stiz-dasan.kr/";

function invoiceRow(over = {}) {
  return {
    invoiceId: "inv-1", paymentId: "pay-1", studentId: "stu-1", studentName: "김하늘",
    parentId: "par-1", phone: "010-1234-5678", amount: 150000, dueYmd: "2026-12-10", hadPriorNotice: false,
    ...over,
  };
}

// ── 1) 청구서 안내 계획(c1·c3) ─────────────────────────────────────────────
test("청구서 안내: 알림톡 id 가 없으면 같은 본문 + «청구서 확인하기: 링크» 를 문자로", () => {
  const { notices, unlinked } = q.planInvoiceNotices([invoiceRow()], { month: 12, academyPhone: "031-000-0000", templateId: "" });
  assert.equal(unlinked.length, 0);
  assert.equal(notices.length, 1);
  const n = notices[0];
  assert.equal(n.channel, "SMS");
  assert.equal(n.recipient, "01012345678");
  assert.equal(n.kakao, undefined);
  assert.match(n.body, /김하늘 학생의 12월 수강료 청구서가 발행되었습니다/);
  assert.match(n.body, /150,000원/);
  assert.match(n.body, /2026년 12월 10일/);
  assert.ok(n.body.endsWith(`청구서 확인하기: ${LINK}payments/inv-1`), n.body);
  assert.equal(n.noticeKey, "invoice:inv-1");
});

test("청구서 안내: 알림톡 id 가 있으면 알림톡(버튼 링크) + 거절 대비 문자 본문", () => {
  const { notices } = q.planInvoiceNotices([invoiceRow()], { month: 12, academyPhone: "", templateId: "KA01TP_X" });
  const n = notices[0];
  assert.equal(n.channel, "ALIMTALK");
  assert.equal(n.kakao.kind, "ALIMTALK");
  assert.equal(n.kakao.templateId, "KA01TP_X");
  assert.equal(n.kakao.buttons[0].linkMo, `${LINK}payments/inv-1`);
  assert.ok(n.kakao.smsBody.includes(`${LINK}payments/inv-1`));
  assert.ok(!n.body.includes("청구서 확인하기:"), "알림톡 본문에는 링크 줄이 없다(버튼)");
});

test("청구서 안내: 학부모 미연결은 조용히 빠지지 않고 이름이 남는다 · 번호 없으면 앱 알림만", () => {
  const { notices, unlinked } = q.planInvoiceNotices([
    invoiceRow({ invoiceId: "a", parentId: null, studentName: "박미연결" }),
    invoiceRow({ invoiceId: "b", phone: "" }),
    invoiceRow({ invoiceId: "c", studentName: "" }), // 틀 값이 비면 빈칸 문장을 만들지 않는다
  ], { month: 12, academyPhone: "", templateId: "" });
  assert.deepEqual(unlinked.map((u) => u.studentName), ["박미연결"]);
  assert.deepEqual(notices.map((n) => [n.invoiceIds[0], n.channel, n.reason]), [
    ["b", "APP_ONLY", "NO_PHONE"],
    ["c", "APP_ONLY", "TEMPLATE_VALUES_MISSING"],
  ]);
});

test("청구서 안내: 강제 재발송 열쇠는 «그날 한 번»", () => {
  assert.equal(q.invoiceNoticeKey("inv-9", "2026-12-01"), "invoice:inv-9:resend:2026-12-01");
  assert.equal(q.invoiceNoticeKey("inv-9"), "invoice:inv-9");
});

// ── 2) 미납 안내 계획(c2) ─────────────────────────────────────────────────
const unpaidRows = [
  { paymentId: "p2", invoiceId: "i2", studentId: "s1", studentName: "이바다", parentId: "u1", phone: "01011112222", amount: 100000 },
  { paymentId: "p1", invoiceId: "i1", studentId: "s1", studentName: "이바다", parentId: "u1", phone: "01011112222", amount: "50000" },
  { paymentId: "p3", invoiceId: "i3", studentId: "s2", studentName: "최한장", parentId: "u2", phone: "01033334444", amount: 70000 },
  { paymentId: "p4", invoiceId: null, studentId: "s3", studentName: "정미연결", parentId: null, phone: null, amount: 70000 },
];
const legacyTemplate = "[스티즈농구교실] 미납 수납 안내\n{{childName}}: {{unpaidCount}}건 ({{totalAmount}}원)\n확인 부탁드립니다.";
const render = (vars) => legacyTemplate.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? "");

test("미납 안내: 학생별 한 통 · 열쇠 = 한국 날짜 + 정렬된 결제 id · 링크 없는 옛 문구에도 결제 링크가 붙는다", () => {
  const { notices, unlinked } = q.planUnpaidNotices(unpaidRows, { kstYmd: "2026-12-14", academyPhone: "", templateId: "", renderSms: render });
  assert.deepEqual(unlinked.map((u) => u.studentName), ["정미연결"]);
  assert.equal(notices.length, 2);
  const two = notices.find((n) => n.studentId === "s1");
  assert.equal(two.noticeKey, "unpaid:2026-12-14:p1,p2");
  assert.equal(two.channel, "SMS");
  assert.match(two.body, /이바다: 2건 \(150,000원\)/);
  // 청구서가 여러 장이면 마이페이지 결제 화면(한 장만 골라 보여 주면 나머지를 놓친다)
  assert.ok(two.body.endsWith(`청구서 확인하기: ${LINK}mypage/payments`), two.body);
  const one = notices.find((n) => n.studentId === "s2");
  assert.ok(one.body.endsWith(`청구서 확인하기: ${LINK}payments/i3`), one.body);
});

test("미납 안내: 새 기본 문구({{paymentLink}})면 링크를 두 번 붙이지 않는다", () => {
  const sms = read("src/lib/smsTemplate.ts");
  assert.match(sms, /UNPAID_PARENT_DEFAULT_BODY =[\s\S]*?청구서 확인하기: \{\{paymentLink\}\}/);
  const tpl = "[스티즈농구교실] 미납 수납 안내\n{{childName}}: {{unpaidCount}}건 ({{totalAmount}}원)\n확인 부탁드립니다.\n청구서 확인하기: {{paymentLink}}";
  const { notices } = q.planUnpaidNotices([unpaidRows[2]], {
    kstYmd: "2026-12-14", academyPhone: "", templateId: "",
    renderSms: (vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? ""),
  });
  assert.equal(notices[0].body.split(`${LINK}payments/i3`).length - 1, 1);
});

test("미납 안내: 알림톡 id 가 있으면 미납 알림톡(버튼 = 결제 링크)", () => {
  const { notices } = q.planUnpaidNotices([unpaidRows[2]], { kstYmd: "2026-12-14", academyPhone: "", templateId: "KA01TP_U", renderSms: render });
  assert.equal(notices[0].channel, "ALIMTALK");
  assert.equal(notices[0].kakao.buttons[0].linkMo, `${LINK}payments/i3`);
});

// ── 3) 규칙 판정(예약 시점·발송 시점 공용) ──────────────────────────────────
test("규칙: 잠금·문자 틀 꺼짐·자동 규칙 꺼짐·채널 꺼짐이면 보내지 않는다", () => {
  const on = { templateActive: true, ruleActive: true, channelEnabled: true, fallbackEnabled: false, fallbackChannel: null, fallbackChannelEnabled: null };
  assert.deepEqual(q.decideBillingSendRule(on, true), { ok: true });
  assert.equal(q.decideBillingSendRule(on, false).code, "BILLING_PARENT_SEND_LOCKED");
  assert.equal(q.decideBillingSendRule({ ...on, templateActive: false }, true).code, "SMS_TEMPLATE_DISABLED");
  assert.equal(q.decideBillingSendRule(undefined, true).code, "SMS_TEMPLATE_DISABLED");
  assert.equal(q.decideBillingSendRule({ ...on, ruleActive: false }, true).code, "AUTOMATION_RULE_DISABLED");
  assert.equal(q.decideBillingSendRule({ ...on, channelEnabled: false }, true).code, "CHANNEL_DISABLED");
  // 기본 채널이 꺼져도 문자 대체 채널이 켜져 있으면 보낸다(getAutomationPolicy 와 같은 판정)
  assert.deepEqual(q.decideBillingSendRule({ ...on, channelEnabled: false, fallbackEnabled: true, fallbackChannel: "LMS", fallbackChannelEnabled: true }, true), { ok: true });
});

test("규칙 조회: 잠금이면 DB 를 읽지 않는다 · 켜져 있으면 문자 틀·자동 규칙·채널을 한 번에 읽는다", async () => {
  let calls = 0;
  const db = { $queryRawUnsafe: async (sql, trigger) => { calls++; assert.match(sql, /FROM "SmsTemplate" t/); assert.match(sql, /"MessageAutomationRule"/); assert.equal(trigger, "UNPAID_PARENT"); return [{ templateActive: true, ruleActive: true, channelEnabled: true }]; }, $executeRawUnsafe: async () => 0 };
  assert.equal((await q.checkBillingSendRule(db, "UNPAID_PARENT", {})).ok, false);
  assert.equal(calls, 0);
  assert.equal((await q.checkBillingSendRule(db, "UNPAID_PARENT", { BILLING_PARENT_SEND_ENABLED: "1" })).ok, true);
  assert.equal(calls, 1);
});

// ── 4) 예약 → 결과 → 다시 누르기(가짜 DB) ───────────────────────────────────
// 연결표·문자 장부를 메모리로 흉내 낸다. SQL 은 이 파일이 쓰는 문장만 알아듣는다.
function fakeStore() {
  const notices = []; // BillingNoticeDelivery
  const deliveries = new Map(); // NotificationDelivery id → status
  const deliveryBatch = new Map(); // NotificationDelivery id → batchId(대기열에 실제로 들어간 행)
  const flags = { failBatchUpdate: false };
  // 가짜 대기열 예약 — 실제처럼 NotificationDelivery 행을 PENDING 으로 만든다
  const enqueue = (items, batchId) => { for (const i of items) { deliveries.set(i.deliveryId, "PENDING"); deliveryBatch.set(i.deliveryId, batchId); } };
  const marked = []; // markNoticeTargetsDelivered 로 나간 UPDATE
  const active = new Set(q.BILLING_NOTICE_ACTIVE_STATUSES);
  const db = {
    async $queryRawUnsafe(sql, ...v) {
      if (sql.includes("pg_advisory_xact_lock")) return [];
      if (sql.includes(`"paymentIds" && $1::text[]`)) {
        // 미납 겹침 검사(잠금 안) — 같은 결제가 든 살아 있는 미납 안내
        assert.ok(sql.includes(`n.status IN ('QUEUED', 'UNCERTAIN')`), "결과 확인 필요(UNCERTAIN)는 기간 없이 막는다");
        return notices.filter((n) => n.kind === "UNPAID" && n.paymentIds.some((p) => v[0].includes(p))
          && ["QUEUED", "UNCERTAIN", "SENT", "APP_ONLY"].includes(n.status)).map((n) => ({ id: n.id }));
      }
      if (sql.includes(`INSERT INTO "BillingNoticeDelivery"`)) {
        assert.match(sql, /ON CONFLICT \("noticeKey"\) WHERE status IN \('QUEUED', 'SENT', 'UNCERTAIN', 'APP_ONLY'\) DO NOTHING/);
        const [id, kind, noticeKey, periodKey, studentId, studentName, invoiceIds, paymentIds, channel, status, deliveryId] = v;
        if (notices.some((n) => n.noticeKey === noticeKey && active.has(n.status))) return [];
        notices.push({ id, kind, noticeKey, periodKey, studentId, studentName, invoiceIds, paymentIds, channel, status, deliveryId, batchId: null, createdAt: Date.now() });
        return [{ id }];
      }
      if (sql.includes(`UPDATE "BillingNoticeDelivery" n`) && sql.includes(`FROM "NotificationDelivery" d`)) {
        const [batchId] = v;
        const out = [];
        for (const n of notices) {
          const d = deliveries.get(n.deliveryId);
          if (n.status !== "QUEUED" || !d || !["SENT", "FAILED", "SKIPPED", "UNCERTAIN"].includes(d)) continue;
          if (batchId !== null && (deliveryBatch.get(n.deliveryId) ?? n.batchId) !== batchId) continue;
          n.status = d === "SENT" ? "SENT" : d === "UNCERTAIN" ? "UNCERTAIN" : "FAILED";
          out.push({ kind: n.kind, status: n.status, invoiceIds: n.invoiceIds, paymentIds: n.paymentIds });
        }
        return out;
      }
      throw new Error(`예상 밖 읽기: ${sql.slice(0, 60)}`);
    },
    async $executeRawUnsafe(sql, ...v) {
      if (sql.includes(`UPDATE "PaymentInvoice"`) || sql.includes(`UPDATE "Payment"`)) {
        marked.push({ table: sql.includes(`"PaymentInvoice"`) ? "invoice" : "payment", reminder: sql.includes(`"reminderCount"`), ids: v[0] });
        return v[0].length;
      }
      if (sql.includes(`SET "batchId" = $2`)) { if (flags.failBatchUpdate) throw new Error("합성 연결 끊김"); for (const n of notices) if (v[0].includes(n.id)) n.batchId = v[1]; return 1; }
      if (sql.includes(`'QUEUE_RESERVE_FAILED'`)) {
        assert.ok(sql.includes(`NOT EXISTS (SELECT 1 FROM "NotificationDelivery" d WHERE d.id = "BillingNoticeDelivery"."deliveryId")`), "대기열에 들어간 행은 실패로 바꾸지 않는다");
        let count = 0;
        for (const n of notices) if (v[0].includes(n.id) && n.status === "QUEUED" && !deliveries.has(n.deliveryId)) { n.status = "FAILED"; count++; }
        return count;
      }
      if (sql.includes(`'QUEUE_NOT_RESERVED'`)) return 0;
      throw new Error(`예상 밖 쓰기: ${sql.slice(0, 60)}`);
    },
  };
  const tx = (fn) => fn(db);
  let seq = 0;
  const newId = () => `id-${++seq}`;
  return { db, tx, notices, deliveries, marked, newId, enqueue, flags };
}

test("예약: 성공한 건만 «발송됨» — 끊긴 뒤 다시 누르면 못 보낸 건만 이어 보낸다(c1)", async () => {
  const s = fakeStore();
  const queueCalls = [];
  const reserveQueue = async (input) => { queueCalls.push(input); return { batchId: `batch-${queueCalls.length}` }; };
  const rows = ["1", "2", "3"].map((k) => invoiceRow({ invoiceId: `inv-${k}`, paymentId: `pay-${k}`, studentId: `stu-${k}` }));
  const plan = q.planInvoiceNotices(rows, { month: 12, academyPhone: "", templateId: "" });

  const first = await q.reserveBillingNotices({ db: s.db, tx: s.tx, kind: "INVOICE", periodKey: "2026-12", notices: plan.notices, actorUserId: "admin", reserveQueue, label: "12월 청구서 안내", newId: s.newId });
  assert.equal(first.queued.length, 3);
  assert.equal(first.batchId, "batch-1");
  assert.equal(s.marked.length, 0, "예약만으로는 sentAt 을 찍지 않는다");
  // 대기열 칸 = 연결표의 deliveryId(결과를 이 id 로 찾는다) + 발송 직전 규칙 재확인 표식
  assert.deepEqual(queueCalls[0].items.map((i) => i.deliveryId), s.notices.map((n) => n.deliveryId));
  assert.ok(queueCalls[0].items.every((i) => i.guard === "BILLING_INVOICE_PARENT"));
  assert.ok(s.notices.every((n) => n.batchId === "batch-1"));

  // 두 번 눌러도(아직 보내는 중) 다시 예약되지 않는다
  const again = await q.reserveBillingNotices({ db: s.db, tx: s.tx, kind: "INVOICE", periodKey: "2026-12", notices: plan.notices, actorUserId: "admin", reserveQueue, label: "x", newId: s.newId });
  assert.equal(again.queued.length, 0);
  assert.equal(again.skippedActive, 3);
  assert.equal(queueCalls.length, 1, "대기열을 또 부르지 않는다");

  // cron 이 두 통은 보내고 한 통은 실패(또는 60초에 끊김) → 결과 반영
  s.deliveries.set(s.notices[0].deliveryId, "SENT");
  s.deliveries.set(s.notices[1].deliveryId, "SENT");
  s.deliveries.set(s.notices[2].deliveryId, "FAILED");
  const result = await q.applyBillingNoticeResults(s.db, s.tx, "batch-1");
  assert.equal(result.sent, 2);
  assert.equal(result.failed, 1);
  const invoiceMark = s.marked.find((m) => m.table === "invoice");
  assert.deepEqual(invoiceMark.ids.sort(), ["inv-1", "inv-2"], "성공한 청구서만 sentAt");
  assert.equal(invoiceMark.reminder, false, "청구서 안내는 미납 횟수를 올리지 않는다");

  // 다시 누르기 — 화면 쿼리는 sentAt IS NULL 인 inv-3 만 다시 고른다 → 실패 행은 열쇠를 막지 않아 새로 예약된다
  const retryPlan = q.planInvoiceNotices([{ ...rows[2], hadPriorNotice: true }], { month: 12, academyPhone: "", templateId: "" });
  const retry = await q.reserveBillingNotices({ db: s.db, tx: s.tx, kind: "INVOICE", periodKey: "2026-12", notices: retryPlan.notices, actorUserId: "admin", reserveQueue, label: "x", newId: s.newId });
  assert.equal(retry.queued.length, 1);
  assert.equal(retry.queued[0].hadPriorNotice, true, "앱 알림은 다시 만들지 않는다(문자만 재시도)");
  assert.equal(queueCalls[1].items.length, 1);
  assert.equal(s.notices.filter((n) => n.noticeKey === "invoice:inv-3").length, 2);
});

test("예약: 앱 알림만(번호 없음)은 그 자리에서 «전달됨» · 대기열 예약 실패면 실패로 돌려 다시 누를 수 있다", async () => {
  const s = fakeStore();
  const plan = q.planInvoiceNotices([
    invoiceRow({ invoiceId: "inv-a", paymentId: "pay-a", phone: "" }),
    invoiceRow({ invoiceId: "inv-b", paymentId: "pay-b", studentId: "stu-b" }),
  ], { month: 12, academyPhone: "", templateId: "" });
  const out = await q.reserveBillingNotices({
    db: s.db, tx: s.tx, kind: "INVOICE", periodKey: "2026-12", notices: plan.notices, actorUserId: "admin",
    reserveQueue: async () => { throw new Error("대기열 장애"); }, label: "x", newId: s.newId,
  });
  assert.equal(out.queueFailed, true);
  assert.deepEqual(out.queued.map((n) => n.invoiceIds[0]), ["inv-a"], "문자 건은 예약되지 않은 것으로 돌려준다");
  assert.deepEqual(s.marked.find((m) => m.table === "invoice").ids, ["inv-a"]);
  assert.equal(s.notices.find((n) => n.invoiceIds[0] === "inv-b").status, "FAILED");
  assert.equal(s.notices.find((n) => n.invoiceIds[0] === "inv-a").deliveryId, null);
});

test("미납 결과: 성공한 묶음만 lastReminderAt·reminderCount 를 올린다(3일 간격의 기준)", async () => {
  const s = fakeStore();
  const plan = q.planUnpaidNotices(unpaidRows.slice(0, 3), { kstYmd: "2026-12-14", academyPhone: "", templateId: "", renderSms: render });
  const queueCalls = [];
  await q.reserveBillingNotices({ db: s.db, tx: s.tx, kind: "UNPAID", periodKey: "2026-12-14", notices: plan.notices, actorUserId: "admin", reserveQueue: async (i) => { queueCalls.push(i); return { batchId: "b" }; }, label: "미납", newId: s.newId });
  assert.ok(queueCalls[0].items.every((i) => i.guard === "UNPAID_PARENT"));
  const s1 = s.notices.find((n) => n.studentId === "s1");
  const s2 = s.notices.find((n) => n.studentId === "s2");
  s.deliveries.set(s1.deliveryId, "SENT");
  s.deliveries.set(s2.deliveryId, "UNCERTAIN");
  const r = await q.applyBillingNoticeResults(s.db, s.tx, null);
  assert.deepEqual([r.sent, r.uncertain], [1, 1]);
  const pay = s.marked.find((m) => m.table === "payment" && m.ids.length > 0);
  assert.deepEqual(pay.ids.sort(), ["p1", "p2"]);
  assert.equal(pay.reminder, true);
  // 불확실(UNCERTAIN)은 «살아 있는» 상태 — 같은 날 다시 눌러도 중복 발송하지 않는다
  assert.ok(q.BILLING_NOTICE_ACTIVE_STATUSES.includes("UNCERTAIN"));
});

// ── 5) 진행 상황·결과 문구 ─────────────────────────────────────────────────
test("결과 문구: 알림톡 N통·문자 N통·앱 알림만 N건·대상 아님(학부모 미연결) N건 + 미연결 이름", () => {
  const queued = [
    { channel: "ALIMTALK" }, { channel: "SMS" }, { channel: "SMS" }, { channel: "APP_ONLY" },
  ];
  const text = q.describeReservation({ label: "12월 청구서 안내", queued, skippedActive: 2, unlinked: [{ studentName: "박미연결" }] });
  assert.match(text, /알림톡 1통 · 문자 2통 · 앱 알림만 1건 · 대상 아님\(학부모 미연결\) 1건/);
  assert.match(text, /학부모 미연결: 박미연결/);
  assert.match(text, /이미 예약·발송된 2건은 다시 보내지 않았습니다/);
  const p = q.summarizeNoticeProgress([
    { channel: "SMS", status: "QUEUED" }, { channel: "SMS", status: "SENT" }, { channel: "ALIMTALK", status: "FAILED" }, { channel: "APP_ONLY", status: "APP_ONLY" },
  ]);
  assert.deepEqual(p, { total: 4, queued: 1, sent: 1, failed: 1, uncertain: 0, appOnly: 1, settled: 0, alimtalk: 1, sms: 2 });
});

// ── 6) 연결: 마이그레이션 = 코드 상수, 대기열 연결, 화면 ──────────────────────
test("마이그레이션: 부분 유일 인덱스의 상태 집합 = 코드 상수 · CHECK 상태 = 코드가 쓰는 값 · RLS", () => {
  const sql = read("prisma/migrations/20261113140000_billing_notice_delivery/migration.sql");
  const idx = /BillingNoticeDelivery_active_noticeKey_key"[\s\S]*?WHERE status IN \(([^)]+)\)/.exec(sql);
  const statuses = idx[1].split(",").map((s) => s.trim().replace(/'/g, ""));
  assert.deepEqual(statuses.sort(), [...q.BILLING_NOTICE_ACTIVE_STATUSES].sort());
  assert.match(sql, /CHECK \(status IN \('QUEUED', 'SENT', 'FAILED', 'UNCERTAIN', 'APP_ONLY'\)\)/);
  assert.match(sql, /CHECK \(channel IN \('ALIMTALK', 'SMS', 'APP_ONLY'\)\)/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE public\."BillingNoticeDelivery" FROM anon, authenticated;/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS/);
});

test("대기열 연결: 호출부 id 로 행을 만들고, 꺼낼 때 규칙을 다시 보고, 묶음 정리 때 결과를 옮긴다", () => {
  const ledger = read("src/lib/message-ledger.ts");
  assert.match(ledger, /item\.deliveryId \?\? randomUUID\(\)/);
  // 같은 학부모 번호로 형제 청구서 두 통 — 중복 키(유일 제약)가 부딪히지 않게 id 로 나눈다
  assert.match(ledger, /eventKey: item\.deliveryId \? `\$\{stableEventKey\}:\$\{item\.deliveryId\}` : stableEventKey/);
  assert.match(ledger, /\.\.\.\(item\.guard \? \{ guard: item\.guard \} : \{\}\)/);
  const claim = ledger.slice(ledger.indexOf("export async function claimManualMessageQueue"), ledger.indexOf("export async function markManualMessageAccepted"));
  assert.match(claim, /checkBillingSendRule\(tx, trigger\)/);
  assert.match(claim, /status='FAILED', "errorCode"=\$2/);
  assert.match(claim, /BILLING_SEND_BLOCKED:/);
  const finalize = ledger.slice(ledger.indexOf("export async function finalizeMessageDeliveryBatch"));
  assert.match(finalize, /applyBillingNoticeResults\(prisma, \(fn\) => prisma\.\$transaction\(\(tx\) => fn\(tx\)\), batchId\)/);
  // 기존 대량 문자(호출부 id·guard 없음)는 예전 그대로
  assert.match(ledger, /buildMessageDedupeKey\(\{ source: "MANUAL", eventKey: item\.deliveryId \?/);
});

test("화면: 진행 상황 한 줄(예약·발송·실패)과 보내는 중 자동 새로고침", () => {
  const client = read("src/app/admin/finance/FinanceClient.tsx");
  assert.match(client, /getBillingNoticeProgress\(y, m\)/);
  assert.match(client, /`예약 \$\{p\.queued\}`, `발송 \$\{p\.sent\}`, `실패 \$\{p\.failed\}`/);
  assert.match(client, /window\.setInterval\(\(\) => void loadNoticeProgress\(year, month\), 20_000\)/);
  assert.match(client, /if \(parentSendLocked\) return;/);
});

// ── 7) 운영 테스트 키 차단(10번) ───────────────────────────────────────────
test("운영 서버에 test_ 키면 결제 막음 · 미리보기/개발·live 키는 그대로", () => {
  const blocked = keyGuard.isProductionTestKeyBlocked;
  assert.equal(blocked({ VERCEL_ENV: "production" }, "test", "test"), true);
  assert.equal(blocked({ VERCEL_ENV: "production" }, "live", "test"), true);
  assert.equal(blocked({ VERCEL_ENV: "production" }, "live", "live"), false);
  assert.equal(blocked({ VERCEL_ENV: "preview" }, "test", "test"), false);
  assert.equal(blocked({}, "test", "test"), false);
  const ledger = read("src/lib/payment-ledger.ts");
  assert.match(ledger, /const keyPairReady = keyPairMatched && !productionTestKeyBlocked;/);
  assert.match(ledger, /if \(productionTestKeyBlocked\) \{\s*return \{ ok: false as const, error: PRODUCTION_TEST_KEY_BLOCKED_MESSAGE \};/);
  // 토스 심사용 경로(TOSS_REVIEW_*)는 건드리지 않는다
  assert.doesNotMatch(read("src/lib/payments/tossReview.ts"), /productionKeyGuard|VERCEL_ENV/);
  assert.match(read("src/app/admin/finance/FinanceClient.tsx"), /paymentProvider\.productionTestKeyBlocked/);
});

// ── 8) 연체 자동 표시(14번) ────────────────────────────────────────────────
test("연체: 납부기한(시간대 없는 칸)은 AT TIME ZONE 두 번, 오늘은 NOW() 한 번 · CURRENT_DATE 금지", () => {
  assert.equal(overdue.PAYMENT_DUE_KST_DATE_SQL, `((("dueDate" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date)`);
  assert.equal(overdue.KST_TODAY_SQL, `((NOW() AT TIME ZONE 'Asia/Seoul')::date)`);
  assert.match(overdue.OVERDUE_PAYMENT_CANDIDATES_SQL, /status = 'PENDING' AND \(\(\("dueDate"[\s\S]*< \(\(NOW\(\)/);
  const ledger = read("src/lib/payment-ledger.ts");
  const mark = ledger.slice(ledger.indexOf("export async function markOverduePayments"), ledger.indexOf("export async function syncInvoiceStatusesForMonth"));
  assert.match(mark, /\$queryRawUnsafe<\{ id: string \}\[\]>\(OVERDUE_PAYMENT_CANDIDATES_SQL\)/);
  assert.doesNotMatch(mark, /CURRENT_DATE/);
});

test("연체 cron: 매일 KST 00:10(UTC 15:10) · CRON_SECRET · 표시만(문자 없음)", () => {
  const vercel = JSON.parse(read("vercel.json"));
  assert.ok(vercel.crons.some((c) => c.path === "/api/cron/payment-overdue" && c.schedule === "10 15 * * *"));
  const route = read("src/app/api/cron/payment-overdue/route.ts");
  assert.match(route, /req\.headers\.get\("authorization"\) !== `Bearer \$\{secret\}`/);
  assert.match(route, /await markOverduePayments\(\)/);
  assert.doesNotMatch(route, /sendParentSms|sendSms|notifyParents/);
});

// ── 9) 결제 API 이메일 검사 제거(B6) · 결제 표 준비 한 번만(d5) ──────────────
test("결제 API: 이메일 없는 계정도 결제 — 소유 확인은 authUserId 그대로", () => {
  for (const file of ["src/app/api/payments/checkout/route.ts", "src/app/api/payments/toss/confirm/route.ts", "src/app/api/mypage/payments/confirm/route.ts"]) {
    const src = read(file);
    assert.doesNotMatch(src, /!user\.email|!parent\.email/, file);
    assert.match(src, /authUserId: (user|parent)\.id/, file);
  }
  const ledger = read("src/lib/payment-ledger.ts");
  assert.match(ledger, /u\."authUserId" = \$2\s+OR \(u\."authUserId" IS NULL AND u\.id = \$2\)/);
});

test("결제 표 준비: 진행 중 Promise 공유 + 먼저 SELECT 한 번으로 «다 있나» 확인", () => {
  const ledger = read("src/lib/payment-ledger.ts");
  const ensure = ledger.slice(ledger.indexOf("export async function ensurePaymentInfrastructure"), ledger.indexOf("// 결제 칸 목록"));
  assert.match(ensure, /if \(!_paymentInfrastructurePromise\)/);
  assert.match(ensure, /if \(!\(await paymentInfrastructureReady\(\)\)\) await runPaymentInfrastructureDdl\(\);/);
  assert.match(ensure, /_paymentInfrastructurePromise = null;\s*throw error;/);
  const ready = ledger.slice(ledger.indexOf("async function paymentInfrastructureReady"), ledger.indexOf("async function runPaymentInfrastructureDdl"));
  assert.doesNotMatch(ready, /ALTER|CREATE/);
  assert.match(ready, /pg_indexes/);
  assert.match(ready, /PAYMENT_LEDGER_COLUMNS\.length/);
  const ddl = ledger.slice(ledger.indexOf("async function runPaymentInfrastructureDdl"), ledger.indexOf("export async function recordPaymentAudit"));
  assert.match(ddl, /for \(const \[column, type\] of paymentColumns\)/);
  assert.match(ddl, /for \(const sql of PAYMENT_LEDGER_INDEX_SQL\)/);
});

// ── 10) 검수 반영(2026-11-13 2차) ───────────────────────────────────────────
test("H1: 대기열 예약은 됐는데 묶음 번호 기록만 실패 → 실패로 보지 않고, 다시 눌러도 1통만", async () => {
  const s = fakeStore();
  const queueCalls = [];
  const reserveQueue = async (input) => { queueCalls.push(input); s.enqueue(input.items, `batch-${queueCalls.length}`); return { batchId: `batch-${queueCalls.length}` }; };
  const plan = q.planInvoiceNotices([invoiceRow()], { month: 12, academyPhone: "", templateId: "" });
  s.flags.failBatchUpdate = true;
  const first = await q.reserveBillingNotices({ db: s.db, tx: s.tx, kind: "INVOICE", periodKey: "2026-12", notices: plan.notices, actorUserId: "a", reserveQueue, label: "x", newId: s.newId });
  assert.equal(first.queueFailed, false, "«다시 눌러 주세요»를 띄우지 않는다");
  assert.equal(s.notices[0].status, "QUEUED");
  // 원장이 그래도 다시 누름 → 살아 있는 행이 있어 새로 예약되지 않는다(두 번 발송 방지)
  const second = await q.reserveBillingNotices({ db: s.db, tx: s.tx, kind: "INVOICE", periodKey: "2026-12", notices: plan.notices, actorUserId: "a", reserveQueue, label: "x", newId: s.newId });
  assert.equal(second.queued.length, 0);
  assert.equal(queueCalls.length, 1);
  // 연결표 batchId 가 비어 있어도 대기열 행의 묶음 번호로 결과가 이어진다
  s.deliveries.set(s.notices[0].deliveryId, "SENT");
  const r = await q.applyBillingNoticeResults(s.db, s.tx, "batch-1");
  assert.equal(r.sent, 1);
});

test("H1: 대기열에 들어간 뒤 응답만 잃음(예외) → 그 행은 QUEUED 유지·실패 아님 · 정말 못 넣은 행만 실패", async () => {
  const s = fakeStore();
  const plan = q.planInvoiceNotices([invoiceRow()], { month: 12, academyPhone: "", templateId: "" });
  const lost = await q.reserveBillingNotices({
    db: s.db, tx: s.tx, kind: "INVOICE", periodKey: "2026-12", notices: plan.notices, actorUserId: "a", label: "x", newId: s.newId,
    reserveQueue: async (input) => { s.enqueue(input.items, "b1"); throw new Error("응답 끊김"); },
  });
  assert.equal(lost.queueFailed, false);
  assert.equal(s.notices[0].status, "QUEUED");

  const s2 = fakeStore();
  const failed = await q.reserveBillingNotices({
    db: s2.db, tx: s2.tx, kind: "INVOICE", periodKey: "2026-12", notices: plan.notices, actorUserId: "a", label: "x", newId: s2.newId,
    reserveQueue: async () => { throw new Error("대기열 장애"); },
  });
  assert.equal(failed.queueFailed, true);
  assert.equal(s2.notices[0].status, "FAILED");
});

test("검수 4번: 미납 — 열쇠가 달라도 같은 결제가 든 살아 있는 안내가 있으면 잠금 안에서 건너뛴다", async () => {
  const s = fakeStore();
  const reserveQueue = async (input) => { s.enqueue(input.items, "b"); return { batchId: "b" }; };
  const morning = q.planUnpaidNotices(unpaidRows.slice(0, 2), { kstYmd: "2026-12-14", academyPhone: "", templateId: "", renderSms: render });
  await q.reserveBillingNotices({ db: s.db, tx: s.tx, kind: "UNPAID", periodKey: "2026-12-14", notices: morning.notices, actorUserId: "a", reserveQueue, label: "x", newId: s.newId });
  // 오후에 p1 이 빠지고 p2 만 남음 → 열쇠가 다르지만 p2 는 이미 예약돼 있다
  const afternoon = q.planUnpaidNotices([unpaidRows[0]], { kstYmd: "2026-12-14", academyPhone: "", templateId: "", renderSms: render });
  assert.notEqual(afternoon.notices[0].noticeKey, morning.notices[0].noticeKey);
  const again = await q.reserveBillingNotices({ db: s.db, tx: s.tx, kind: "UNPAID", periodKey: "2026-12-14", notices: afternoon.notices, actorUserId: "a", reserveQueue, label: "x", newId: s.newId });
  assert.equal(again.queued.length, 0);
  assert.equal(again.skippedActive, 1);
});

test("H2·검수 1·3번: 미납 안내는 기한 지난(OVERDUE)만 · 연체 표시는 아직 PENDING 인 것만 · UNCERTAIN 은 기간 없이 제외", () => {
  const admin = read("src/app/actions/admin.ts");
  const reminders = admin.slice(admin.indexOf("export async function sendUnpaidReminders"), admin.indexOf("export async function getBillingNoticeProgress"));
  assert.match(reminders, /WHERE p\.status = 'OVERDUE'/);
  assert.doesNotMatch(reminders, /p\.status IN \('PENDING', 'OVERDUE'\)/);
  assert.ok(reminders.indexOf("await markOverduePayments()") < reminders.indexOf("WHERE p.status = 'OVERDUE'"), "연체 표시를 먼저 한다");
  assert.match(reminders, /unpaidBlockingNoticeSql\("n", "\$1"\)/);
  const blocking = q.unpaidBlockingNoticeSql("n", "$1");
  assert.ok(blocking.includes(`n.status IN ('QUEUED', 'UNCERTAIN')`));
  assert.ok(blocking.includes(`n.status IN ('SENT', 'APP_ONLY') AND n."createdAt" > NOW() - make_interval(days => $1::int)`));
  assert.match(admin, /loadBillingNoticeProgress\(prisma, "UNPAID", todayKst\(\), \{ includeAllUncertain: true \}\)/);
  assert.match(read("src/app/admin/finance/FinanceClient.tsx"), /결과 확인 필요 \$\{p\.uncertain\}/);
  const ledger = read("src/lib/payment-ledger.ts");
  const mark = ledger.slice(ledger.indexOf("export async function markOverduePayments"), ledger.indexOf("export async function syncInvoiceStatusesForMonth"));
  assert.match(mark, /WHERE id IN \(\$\{candidatePlaceholders\}\) AND status = 'PENDING'\s+RETURNING id/);
  assert.match(mark, /const ids = updatedRows\.map/);
});

test("검수 2·5·6번: 규칙 조회는 SAVEPOINT 로 격리 · 단건 검토에 결제 번호 · 연결표 행 없으면 결과 반영 건너뜀", () => {
  const ledger = read("src/lib/message-ledger.ts");
  const claim = ledger.slice(ledger.indexOf("export async function claimManualMessageQueue"), ledger.indexOf("export async function markManualMessageAccepted"));
  assert.match(claim, /SAVEPOINT billing_rule_check[\s\S]*?checkBillingSendRule\(tx, trigger\)[\s\S]*?ROLLBACK TO SAVEPOINT billing_rule_check/);
  const finalize = ledger.slice(ledger.indexOf("export async function finalizeMessageDeliveryBatch"));
  assert.ok(finalize.indexOf(`JOIN "BillingNoticeDelivery" n`) < finalize.indexOf(`await import("@/lib/billing/noticeQueue")`));
  assert.match(finalize, /if \(!pending\[0\]\?\.found\) return;/);
  const pay = read("src/lib/payment-ledger.ts");
  const review = pay.slice(pay.indexOf("async function recordSinglePaymentReview("));
  assert.match(review.slice(0, 1500), /paymentKey: paymentKey \?\? tx\.paymentKey \?\? null/);
});
