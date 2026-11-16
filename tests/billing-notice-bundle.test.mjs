// 청구서 묶음 안내 실행 테스트(2026-11-16 원장 «청구서 안내 — 묶어보내기»).
// 같은 학부모(같은 받는 번호)의 같은 달 청구서를 문자 한 통으로. 실제 문자·DB 는 쓰지 않는다(가짜 DB).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const q = await loadTsModule("src/lib/billing/noticeQueue.ts");
const read = (p) => readFileSync(p, "utf8");
const LINK = "https://www.stiz-dasan.kr/";
// 통신사 LMS 바이트(한글 2·영문 1)
const bytes = (s) => [...s].reduce((n, ch) => n + (ch.codePointAt(0) <= 0x7f ? 1 : 2), 0);

function invoiceRow(over = {}) {
  return {
    invoiceId: "inv-1", paymentId: "pay-1", studentId: "stu-1", studentName: "김하늘",
    parentId: "par-1", phone: "010-1234-5678", amount: 150000, dueYmd: "2026-12-10", hadPriorNotice: false,
    ...over,
  };
}
const sameParent = (k, over = {}) => invoiceRow({
  invoiceId: `inv-${k}`, paymentId: `pay-${k}`, studentId: `stu-${k}`, studentName: `아이${k}`,
  className: `화요일 ${k}교시`, amount: 100000, dueYmd: "2026-11-30", ...over,
});

// 가짜 연결표·대기열(billing-notice-queue.test.mjs 와 같은 SQL 만 알아듣는다)
function fakeStore() {
  const notices = [];
  const deliveries = new Map();
  const marked = [];
  const active = new Set(q.BILLING_NOTICE_ACTIVE_STATUSES);
  const suffix = (key) => /:resend:\d{4}-\d{2}-\d{2}$/.exec(key)?.[0] ?? "";
  const db = {
    async $queryRawUnsafe(sql, ...v) {
      if (sql.includes("pg_advisory_xact_lock")) return [];
      if (sql.includes(`"invoiceIds" && $1::text[]`)) {
        return notices.filter((n) => n.kind === "INVOICE" && n.invoiceIds.some((i) => v[0].includes(i))
          && active.has(n.status) && suffix(n.noticeKey) === v[1]).map((n) => ({ id: n.id }));
      }
      if (sql.includes(`INSERT INTO "BillingNoticeDelivery"`)) {
        const [id, kind, noticeKey, , studentId, studentName, invoiceIds, paymentIds, channel, status, deliveryId] = v;
        if (notices.some((n) => n.noticeKey === noticeKey && active.has(n.status))) return [];
        notices.push({ id, kind, noticeKey, studentId, studentName, invoiceIds, paymentIds, channel, status, deliveryId, batchId: null });
        return [{ id }];
      }
      if (sql.includes(`UPDATE "BillingNoticeDelivery" n`) && sql.includes(`FROM "NotificationDelivery" d`)) {
        const out = [];
        for (const n of notices) {
          const d = deliveries.get(n.deliveryId);
          if (n.status !== "QUEUED" || !d || !["SENT", "FAILED"].includes(d)) continue;
          n.status = d;
          out.push({ kind: n.kind, status: n.status, invoiceIds: n.invoiceIds, paymentIds: n.paymentIds });
        }
        return out;
      }
      throw new Error(`예상 밖 읽기: ${sql.slice(0, 60)}`);
    },
    async $executeRawUnsafe(sql, ...v) {
      if (sql.includes(`UPDATE "PaymentInvoice"`) || sql.includes(`UPDATE "Payment"`)) {
        marked.push({ table: sql.includes(`"PaymentInvoice"`) ? "invoice" : "payment", ids: v[0] });
        return v[0].length;
      }
      if (sql.includes(`SET "batchId" = $2`)) { for (const n of notices) if (v[0].includes(n.id)) n.batchId = v[1]; return 1; }
      if (sql.includes(`'QUEUE_NOT_RESERVED'`)) return 0;
      throw new Error(`예상 밖 쓰기: ${sql.slice(0, 60)}`);
    },
  };
  let seq = 0;
  return { db, tx: (fn) => fn(db), notices, deliveries, marked, newId: () => `id-${++seq}` };
}

test("묶음: 한 장뿐인 번호는 예전과 똑같다(알림톡 심사본 글자·열쇠 그대로)", () => {
  const opts = { month: 12, academyPhone: "031-000-0000", templateId: "KA01TP_X" };
  const before = q.planInvoiceNotices([invoiceRow()], opts);
  const mixed = q.planInvoiceNotices([
    invoiceRow(),
    sameParent("7", { parentId: "par-2", phone: "010-7777-7777" }),
    sameParent("8", { parentId: "par-2", phone: "010-7777-7777" }),
  ], opts);
  assert.deepEqual(mixed.notices[0], before.notices[0], "한 장짜리 안내는 한 글자도 바뀌지 않는다");
  assert.equal(before.notices[0].channel, "ALIMTALK");
  assert.equal(before.notices[0].noticeKey, "invoice:inv-1");
  assert.equal(mixed.notices.length, 2);
});

test("묶음: 두 장 이상 = 문자(LMS) 1통 — 머리말·«이름 · 반 · 금액» 줄·합계·기한·한 번에 결제 링크·문의", () => {
  const { notices } = q.planInvoiceNotices([sameParent("1"), sameParent("2", { amount: 120000 })], { month: 12, academyPhone: "031-000-0000", templateId: "KA01TP_X" });
  assert.equal(notices.length, 1);
  const n = notices[0];
  assert.equal(n.channel, "SMS", "알림톡 틀과 글자가 달라 문자로");
  assert.equal(n.kakao, undefined);
  assert.equal(n.recipient, "01012345678");
  assert.deepEqual(n.invoiceIds, ["inv-1", "inv-2"]);
  assert.deepEqual(n.paymentIds, ["pay-1", "pay-2"]);
  assert.equal(n.amount, 220000);
  assert.equal(n.studentName, "아이1·아이2");
  assert.equal(n.noticeKey, "invoice-bundle:inv-1,inv-2");
  assert.ok(n.body.startsWith("[스티즈농구교실] 12월 수강료 안내\n"), n.body);
  assert.match(n.body, /청구서 2장이 발행되었습니다/);
  assert.match(n.body, /■ 아이1 · 화요일 1교시 · 100,000원/);
  assert.match(n.body, /■ 아이2 · 화요일 2교시 · 120,000원/);
  assert.match(n.body, /■ 합계: 220,000원/);
  assert.match(n.body, /■ 납부 기한: 2026년 11월 30일/);
  assert.ok(n.body.includes(`청구서 확인하기: ${LINK}mypage/payments/checkout`), n.body);
  assert.ok(n.body.endsWith("문의: 031-000-0000"), n.body);
  const s = q.summarizeInvoicePlan({ notices, unlinked: [] });
  assert.deepEqual([s.invoices, s.messages, s.bundles], [2, 1, 1]);
  assert.equal(s.maxBodyBytes, bytes(n.body));
});

test("묶음: 열쇠는 청구서 순서와 상관없이 같다(정렬)", () => {
  assert.equal(q.invoiceBundleNoticeKey(["b", "a"]), q.invoiceBundleNoticeKey(["a", "b"]));
  assert.equal(q.invoiceBundleNoticeKey(["b", "a"], "2026-12-01"), "invoice-bundle:a,b:resend:2026-12-01");
  assert.equal(q.noticeKeyResendSuffix("invoice:x:resend:2026-12-01"), ":resend:2026-12-01");
  assert.equal(q.noticeKeyResendSuffix("invoice-bundle:a,b"), "");
});

test("묶음: 미가입(비회원 링크) 학부모는 청구서마다 그 링크 — 발급 실패한 장은 로그인 결제 화면", () => {
  const { notices } = q.planInvoiceNotices([sameParent("1", { payPath: "pay/AAA" }), sameParent("2", { payPath: null })], { month: 12, academyPhone: "", templateId: "" });
  const body = notices[0].body;
  assert.ok(body.includes(`■ 아이1 · 화요일 1교시 · 100,000원\n  ${LINK}pay/AAA`), body);
  assert.ok(body.includes(`■ 아이2 · 화요일 2교시 · 100,000원\n  ${LINK}payments/inv-2`), body);
  assert.ok(!body.includes("mypage/payments/checkout"), "한 번에 결제 링크는 로그인 학부모만");
  assert.match(body, /문의: 070-8824-5712/, "문의 번호가 비면 기본값");
});

test("묶음: 납부 기한이 다르면 줄마다 · 반이 없으면 줄에서 뺀다", () => {
  const { notices } = q.planInvoiceNotices([sameParent("1", { className: null }), sameParent("2", { dueYmd: "2026-12-10" })], { month: 12, academyPhone: "", templateId: "" });
  assert.match(notices[0].body, /■ 아이1 · 100,000원 \(기한 2026년 11월 30일\)/);
  assert.match(notices[0].body, /■ 아이2 · 화요일 2교시 · 100,000원 \(기한 2026년 12월 10일\)/);
  assert.doesNotMatch(notices[0].body, /■ 납부 기한/);
});

test("묶음: 번호가 없거나 틀 값이 빈 장은 예전처럼 장마다 앱 알림만 · 나머지만 묶는다", () => {
  const { notices } = q.planInvoiceNotices([
    sameParent("1"), sameParent("2"), sameParent("3", { studentName: "" }), sameParent("4", { phone: "" }),
  ], { month: 12, academyPhone: "", templateId: "" });
  assert.deepEqual(notices.map((n) => [n.channel, n.invoiceIds.join(",")]), [
    ["SMS", "inv-1,inv-2"], ["APP_ONLY", "inv-3"], ["APP_ONLY", "inv-4"],
  ]);
});

test("묶음: LMS 한도를 넘으면 둘 이상으로 나눈다 — 통마다 한도 이하·빠짐/겹침 없음·계획도 통마다 열쇠", () => {
  const token = "T".repeat(43);
  const items = [1, 2, 3, 4, 5, 6].map((k) => ({ invoiceId: `inv-${k}`, studentName: `아이${k}`, className: "화요일 5교시", amount: 100000, dueYmd: "2026-11-30", payPath: `pay/${token}` }));
  const whole = q.buildInvoiceBundleBodies(items, { month: 12, academyPhone: "" });
  assert.equal(whole.length, 1, "실제 최대(6장·비회원 링크)도 한 통에 들어간다");
  assert.ok(bytes(whole[0].body) <= q.INVOICE_BUNDLE_LMS_MAX_BYTES);
  const parts = q.buildInvoiceBundleBodies(items, { month: 12, academyPhone: "", maxBytes: 500 });
  assert.ok(parts.length >= 2, `${parts.length}통`);
  assert.deepEqual(parts.flatMap((p) => p.items.map((i) => i.invoiceId)), items.map((i) => i.invoiceId), "빠지거나 겹치는 청구서 없음");
  parts.forEach((p, i) => {
    assert.ok(p.body.includes(`(${i + 1}/${parts.length})`), p.body);
    assert.match(p.body, /■ 이 문자 합계/);
    assert.ok(bytes(p.body) <= 500, `${bytes(p.body)} 바이트`);
  });
});

test("묶음 중복 방지: 같은 묶음 재클릭 = 같은 열쇠 · 구성이 바뀌어도 청구서 단위로 두 번 안 나간다 · 실패하면 전부 다시 대상", async () => {
  const s = fakeStore();
  const calls = [];
  const reserveQueue = async (input) => { calls.push(input); return { batchId: `b-${calls.length}` }; };
  const opts = { month: 12, academyPhone: "", templateId: "" };
  const reserve = (notices) => q.reserveBillingNotices({ db: s.db, tx: s.tx, kind: "INVOICE", periodKey: "2026-12", notices, actorUserId: "a", reserveQueue, label: "x", newId: s.newId });

  const plan = q.planInvoiceNotices([sameParent("1"), sameParent("2"), sameParent("3")], opts);
  assert.equal(plan.notices.length, 1);
  const first = await reserve(plan.notices);
  assert.equal(first.queued.length, 1);
  assert.equal(calls[0].items.length, 1, "문자 1통");
  assert.equal(calls[0].items[0].guard, "BILLING_INVOICE_PARENT", "발송 직전 잠금·규칙 재확인은 그대로");

  // 재클릭(같은 묶음) — 막힌다
  assert.equal((await reserve(plan.notices)).queued.length, 0);
  // 구성이 바뀐 묶음(2장)·한 장 열쇠 — 청구서가 겹치면 막힌다
  const two = q.planInvoiceNotices([sameParent("1"), sameParent("2")], opts);
  const single = q.planInvoiceNotices([sameParent("3")], opts);
  const blocked = await reserve([...two.notices, ...single.notices]);
  assert.equal(blocked.queued.length, 0);
  assert.equal(blocked.skippedActive, 2);
  assert.equal(calls.length, 1, "대기열을 또 부르지 않는다");
  // 같은 날 강제 재발송은 일반 안내와 따로(재발송끼리만 막는다)
  const resend = q.planInvoiceNotices([sameParent("1"), sameParent("2"), sameParent("3")], { ...opts, resendYmd: "2026-12-01" });
  assert.equal(resend.notices[0].noticeKey, "invoice-bundle:inv-1,inv-2,inv-3:resend:2026-12-01");
  assert.equal((await reserve(resend.notices)).queued.length, 1);
  assert.equal((await reserve(resend.notices)).queued.length, 0, "같은 날 재발송 두 번 = 한 번");

  // 결과: 묶음 실패 → 세 장 모두 sentAt 안 찍힘 → 다시 누르면 다시 예약된다
  s.deliveries.set(s.notices[0].deliveryId, "FAILED");
  s.deliveries.set(s.notices[1].deliveryId, "FAILED");
  await q.applyBillingNoticeResults(s.db, s.tx, null);
  assert.equal(s.marked.filter((m) => m.table === "invoice" && m.ids.length > 0).length, 0, "실패한 묶음은 어느 청구서에도 sentAt 을 찍지 않는다");
  const retry = await reserve(plan.notices);
  assert.equal(retry.queued.length, 1);
  // 성공 → 포함된 청구서 각각에 sentAt
  s.deliveries.set(retry.queued[0].deliveryId, "SENT");
  await q.applyBillingNoticeResults(s.db, s.tx, null);
  const mark = s.marked.find((m) => m.table === "invoice" && m.ids.length > 0);
  assert.deepEqual([...mark.ids].sort(), ["inv-1", "inv-2", "inv-3"]);
});

test("묶음 연결: 발송과 확인창이 같은 대상 함수 · 앱 알림 학부모당 1건 · 확인창·진행 줄 «청구서 N장 → 문자 M통(묶음 K통)»", () => {
  const admin = read("src/app/actions/admin.ts");
  const send = admin.slice(admin.indexOf("export async function sendInvoiceLinksForMonth"), admin.indexOf("export async function sendUnpaidReminders"));
  assert.equal((send.match(/await loadInvoiceNoticeCandidates\(/g) ?? []).length, 2, "발송·미리보기 둘 다 같은 함수");
  assert.match(send, /GROUP BY i\."parentId"/, "앱 알림은 학부모당 1건");
  assert.match(send, /LEFT JOIN "Class" c ON c\.id = COALESCE\(i\."classId", p\."classId"\)/);
  const preview = send.slice(send.indexOf("export async function previewInvoiceNoticeCounts"));
  assert.match(preview, /await requireFinanceOwner\(\)/);
  assert.doesNotMatch(preview, /issueGuestPayPathsForNotices|reserveBillingNotices|INSERT|UPDATE/, "미리보기는 읽기만");
  const client = read("src/app/admin/finance/FinanceClient.tsx");
  assert.ok(client.includes("청구서 ${counts.invoices}장 → 문자 ${counts.messages}통(묶음 ${counts.bundles}통)"));
  assert.ok(client.includes("청구서 ${p.invoiceCount ?? 0}장 → 문자 ${p.messageCount ?? 0}통(묶음 ${p.bundleCount}통)"));
});
