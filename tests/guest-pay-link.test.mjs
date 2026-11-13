// 비회원 결제 링크(/pay/<토큰>, 2026-11-14) — 가입하지 않은 학부모가 받은 링크 하나로 «그 청구서 한 장만» 보고 결제한다.
// 1) 순수 규칙(guestPayLinkRules.ts)은 실제로 실행한다 — 토큰 모양·만료일(KST 경계)·이름 가리기·상태 판정·가입 판정.
// 2) 토큰(guestPayToken.ts)은 실제 crypto 로 — 원문이 아니라 해시만 저장·조회한다.
// 3) DB 연결부(guestPayLink.ts)는 메모리 가짜 DB 로 실행한다 — 발급·검증 실패 경로·사용 기록.
// 4) 안내 계획(noticeQueue.ts) — 미가입자에게 pay 링크가 들어가는지.
// 5) 소스 계약 — 소유권 우회 불가(다른 청구서 섞기·묶음 주문·화면이 보낸 청구서 id 무시), 공개 경로·머리글·마이그레이션.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const rules = await loadTsModule("src/lib/payments/guestPayLinkRules.ts");
const token = await loadTsModule("src/lib/payments/guestPayToken.ts");
const link = await loadTsModule("src/lib/payments/guestPayLink.ts");
const q = await loadTsModule("src/lib/billing/noticeQueue.ts");
const read = (p) => readFileSync(p, "utf8");

const BASE = "https://www.stiz-dasan.kr/";
const SAMPLE_TOKEN = "A".repeat(20) + "b-_" + "9".repeat(20); // 43자

// ───────────────────────────── 1) 순수 규칙 ─────────────────────────────

test("토큰 모양: base64url 정확히 43자만 — 아니면 DB 를 부르지 않는다", () => {
  assert.equal(SAMPLE_TOKEN.length, 43);
  assert.equal(rules.isGuestPayTokenShape(SAMPLE_TOKEN), true);
  assert.equal(rules.isGuestPayTokenShape(SAMPLE_TOKEN.slice(1)), false, "42자");
  assert.equal(rules.isGuestPayTokenShape(SAMPLE_TOKEN + "A"), false, "44자");
  assert.equal(rules.isGuestPayTokenShape("A".repeat(42) + "="), false, "패딩·기호");
  assert.equal(rules.isGuestPayTokenShape("A".repeat(42) + "/"), false);
  assert.equal(rules.isGuestPayTokenShape(null), false);
  assert.equal(rules.isGuestPayTokenShape(12345), false);
  assert.equal(rules.guestPayPath(SAMPLE_TOKEN), `pay/${SAMPLE_TOKEN}`);
});

test("만료일 = max(납부기한, 발급일) + 14일, 그날 하루 끝까지(다음 날 0시 KST 에 닫힘)", () => {
  // 기한 전 발급 → 기한 기준
  assert.equal(rules.guestPayLinkLastYmd("2026-12-10", "2026-12-01"), "2026-12-24");
  // 기한이 지난 미납 안내 → 발급일 기준(링크가 바로 죽지 않게)
  assert.equal(rules.guestPayLinkLastYmd("2026-11-01", "2026-11-20"), "2026-12-04");
  // 기한 당일 발급
  assert.equal(rules.guestPayLinkLastYmd("2026-11-20", "2026-11-20"), "2026-12-04");
  // 연말·월말·윤년 경계
  assert.equal(rules.guestPayLinkLastYmd("2026-12-25", "2026-12-01"), "2027-01-08");
  assert.equal(rules.guestPayLinkLastYmd("2028-02-20", "2028-02-01"), "2028-03-05", "2028 윤년 2월 29일 포함");
  assert.equal(rules.guestPayLinkLastYmd("2027-02-20", "2027-02-01"), "2027-03-06", "2027 평년");
  // 기한이 비었거나 형식이 틀리면 발급일 기준
  assert.equal(rules.guestPayLinkLastYmd(null, "2026-11-14"), "2026-11-28");
  assert.equal(rules.guestPayLinkLastYmd("2026/12/10", "2026-11-14"), "2026-11-28");
});

test("만료 시각은 마지막 날 다음 날 0시(KST) = 전날 15:00 UTC — 서버 시간대와 무관", () => {
  const ms = rules.guestPayLinkExpiresAtMs("2026-12-10", "2026-12-01");
  assert.equal(ms, Date.UTC(2026, 11, 24, 15, 0, 0), "12-24 하루 끝 = 12-25 00:00 KST = 12-24 15:00 UTC");
  // 연말: 2027-01-08 끝 = 2027-01-09 00:00 KST
  assert.equal(rules.guestPayLinkExpiresAtMs("2026-12-25", "2026-12-01"), Date.UTC(2027, 0, 8, 15, 0, 0));
  // 마지막 날 23:59 KST 에는 아직 열려 있고, 다음 날 0시에 닫힌다
  const lastMinute = Date.UTC(2026, 11, 24, 14, 59, 0); // 12-24 23:59 KST
  assert.ok(lastMinute < ms);
  assert.ok(Date.UTC(2026, 11, 24, 15, 0, 0) >= ms);
});

test("학생 이름 가운데 가리기", () => {
  assert.equal(rules.maskStudentName("권민호"), "권○호");
  assert.equal(rules.maskStudentName("김호"), "김○");
  assert.equal(rules.maskStudentName("남궁민수"), "남○○수");
  assert.equal(rules.maskStudentName("이"), "○");
  assert.equal(rules.maskStudentName("  박서준  "), "박○준");
  assert.equal(rules.maskStudentName(""), "");
  assert.equal(rules.maskStudentName(null), "");
  // 제목·설명 안의 이름도 가린다(관리자가 설명에 아이 이름을 적은 경우)
  assert.equal(rules.maskNameInText("권민호 12월 수강료 · 권민호 셔틀", "권민호"), "권○호 12월 수강료 · 권○호 셔틀");
  assert.equal(rules.maskNameInText("12월 수강료", "권민호"), "12월 수강료");
  assert.equal(rules.maskNameInText("이 반 수강료", "이"), "이 반 수강료", "한 글자 이름은 다른 낱말을 바꾸지 않게 그대로");
  assert.equal(rules.maskNameInText(null, "권민호"), "");
});

test("링크 상태: 폐기·만료 먼저 → 취소·환불 INVALID → 납부 PAID → 미납 PAYABLE", () => {
  const base = { revoked: false, expired: false, invoiceStatus: "SENT", paymentStatus: "PENDING" };
  assert.equal(rules.judgeGuestPayLink(base), "PAYABLE");
  assert.equal(rules.judgeGuestPayLink({ ...base, paymentStatus: "OVERDUE", invoiceStatus: "OVERDUE" }), "PAYABLE");
  assert.equal(rules.judgeGuestPayLink({ ...base, invoiceStatus: "PAID", paymentStatus: "PAID" }), "PAID");
  assert.equal(rules.judgeGuestPayLink({ ...base, paymentStatus: "PAID" }), "PAID", "결제만 먼저 반영된 경우");
  assert.equal(rules.judgeGuestPayLink({ ...base, invoiceStatus: "CANCELED" }), "INVALID", "청구 취소");
  assert.equal(rules.judgeGuestPayLink({ ...base, paymentStatus: "REFUNDED", invoiceStatus: "PAID" }), "INVALID", "환불은 납부보다 먼저");
  assert.equal(rules.judgeGuestPayLink({ ...base, paymentStatus: "CANCELED" }), "INVALID");
  assert.equal(rules.judgeGuestPayLink({ ...base, expired: true }), "INVALID");
  assert.equal(rules.judgeGuestPayLink({ ...base, expired: true, invoiceStatus: "PAID", paymentStatus: "PAID" }), "INVALID", "만료 뒤에는 납부 완료도 안 보인다");
  assert.equal(rules.judgeGuestPayLink({ ...base, revoked: true }), "INVALID");
  assert.equal(rules.judgeGuestPayLink({ ...base, invoiceStatus: null }), "INVALID", "상태를 모르면 막는다");
});

test("가입 판정: 학부모 연결 + 로그인 계정 없음(authUserId 없음)일 때만 비회원 링크", () => {
  assert.equal(rules.shouldUseGuestPayLink({ parentId: "u1", parentHasAccount: false }), true);
  assert.equal(rules.shouldUseGuestPayLink({ parentId: "u1", parentHasAccount: null }), true, "모르면 링크(가입자에게 가도 결제는 된다)");
  assert.equal(rules.shouldUseGuestPayLink({ parentId: "u1", parentHasAccount: true }), false);
  assert.equal(rules.shouldUseGuestPayLink({ parentId: null, parentHasAccount: false }), false, "학부모 미연결은 이번 범위 밖");
});

test("잘못된·만료 링크 문구는 하나 — 존재 여부를 구분하지 않는다", () => {
  assert.match(rules.GUEST_PAY_INVALID_MESSAGE, /링크가 만료됐거나 올바르지 않아요/);
  assert.match(rules.GUEST_PAY_INVALID_MESSAGE, /학원/);
});

// ───────────────────────────── 2) 토큰 ─────────────────────────────

test("토큰: 32바이트 base64url 43자 · 저장은 SHA-256 hex 64자 · 매번 다르다", () => {
  const a = token.createGuestPayToken();
  const b = token.createGuestPayToken();
  assert.equal(a.token.length, 43);
  assert.ok(rules.isGuestPayTokenShape(a.token));
  assert.match(a.hash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.hash, b.hash);
  assert.ok(!a.hash.includes(a.token), "해시에 원문이 섞이지 않는다");
  assert.equal(token.hashGuestPayToken(a.token), a.hash, "같은 원문 → 같은 해시");
  assert.equal(token.guestTokenHashOrNull(a.token), a.hash);
  assert.equal(token.guestTokenHashOrNull("short"), null);
  assert.equal(token.guestTokenHashOrNull(undefined), null);
});

test("토스 고객 키(비회원): 청구서 기반 고정 · 규격(2~50자 영문·숫자·-_) · 청구서 id 원문 없음", () => {
  const k1 = token.guestCustomerKey("inv-0001");
  const k2 = token.guestCustomerKey("inv-0002");
  assert.match(k1, /^stiz_g_[A-Za-z0-9_-]+$/);
  assert.ok(k1.length >= 2 && k1.length <= 50, String(k1.length));
  assert.equal(token.guestCustomerKey("inv-0001"), k1, "같은 청구서 → 같은 키");
  assert.notEqual(k1, k2);
  assert.ok(!k1.includes("inv-0001"));
});

// ───────────────────────────── 3) DB 연결부(가짜 DB) ─────────────────────────────

/** 메모리 가짜 DB — 청구서·결제·토큰 표. SQL 은 머리말로 구분한다. */
function fakeDb({ invoices = {}, now = Date.UTC(2026, 10, 14, 3, 0, 0) } = {}) {
  const tokens = [];
  const calls = [];
  return {
    tokens,
    calls,
    async $queryRawUnsafe(sql, ...args) {
      calls.push(sql);
      if (sql.includes(`FROM "PaymentInvoice" i`) && sql.includes(`"dueYmd"`)) {
        const inv = invoices[args[0]];
        // 발급 SQL 이 «학부모 연결된 청구서만» 조건을 걸었을 때만 미연결 청구서를 거른다(조건이 빠지면 테스트가 잡는다)
        if (inv && inv.parentId === null && sql.includes(`AND i."parentId" IS NOT NULL`)) return [];
        return inv ? [{ invoiceStatus: inv.invoiceStatus, paymentStatus: inv.paymentStatus, dueYmd: inv.dueYmd }] : [];
      }
      if (sql.includes(`FROM "PaymentInvoiceAccessToken" t`)) {
        const t = tokens.find((row) => row.tokenHash === args[0]);
        if (!t) return [];
        const inv = invoices[t.invoiceId];
        return [{
          tokenId: t.id, invoiceId: t.invoiceId, revoked: Boolean(t.revokedAt),
          expired: new Date(t.expiresAt).getTime() <= now,
          invoiceStatus: inv?.invoiceStatus ?? null, paymentStatus: inv?.paymentStatus ?? null,
        }];
      }
      throw new Error(`예상 못 한 SELECT: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql, ...args) {
      calls.push(sql);
      if (sql.includes(`INSERT INTO "PaymentInvoiceAccessToken"`)) {
        tokens.push({ id: `t${tokens.length + 1}`, invoiceId: args[0], tokenHash: args[1], expiresAt: args[2], source: args[3], createdByUserId: args[4], useCount: 0, revokedAt: null });
        return 1;
      }
      if (sql.includes(`SET "lastUsedAt" = NOW()`)) {
        const t = tokens.find((row) => row.id === args[0]);
        if (t) t.useCount += 1;
        return t ? 1 : 0;
      }
      if (sql.includes(`SET "revokedAt" = NOW()`)) {
        let n = 0;
        for (const t of tokens) if (t.invoiceId === args[0] && !t.revokedAt) { t.revokedAt = "now"; n += 1; }
        return n;
      }
      throw new Error(`예상 못 한 실행: ${sql.slice(0, 80)}`);
    },
  };
}

const NOW = Date.UTC(2026, 10, 14, 3, 0, 0); // 2026-11-14 12:00 KST

test("발급: 미납 청구서에만 · DB 에는 해시만 · 만료 시각은 KST 하루 끝", async () => {
  const db = fakeDb({ invoices: {
    inv1: { invoiceStatus: "SENT", paymentStatus: "PENDING", dueYmd: "2026-12-10" },
    paid: { invoiceStatus: "PAID", paymentStatus: "PAID", dueYmd: "2026-12-10" },
    canceled: { invoiceStatus: "CANCELED", paymentStatus: "CANCELED", dueYmd: "2026-12-10" },
  }, now: NOW });
  const issued = await link.issueGuestPayLink(db, { invoiceId: "inv1", source: "ADMIN_COPY", createdByUserId: "admin-1", nowMs: NOW });
  assert.ok(issued);
  assert.ok(rules.isGuestPayTokenShape(issued.token));
  assert.equal(issued.path, `pay/${issued.token}`);
  assert.equal(issued.lastYmd, "2026-12-24");
  assert.equal(db.tokens.length, 1);
  const row = db.tokens[0];
  assert.equal(row.tokenHash, token.hashGuestPayToken(issued.token), "저장값 = 해시");
  assert.notEqual(row.tokenHash, issued.token, "원문은 저장하지 않는다");
  assert.equal(new Date(row.expiresAt).getTime(), Date.UTC(2026, 11, 24, 15, 0, 0));
  assert.equal(row.source, "ADMIN_COPY");
  assert.equal(row.createdByUserId, "admin-1");

  assert.equal(await link.issueGuestPayLink(db, { invoiceId: "paid", source: "ADMIN_COPY", nowMs: NOW }), null, "납부 완료는 발급 안 함");
  assert.equal(await link.issueGuestPayLink(db, { invoiceId: "canceled", source: "ADMIN_COPY", nowMs: NOW }), null, "취소는 발급 안 함");
  assert.equal(await link.issueGuestPayLink(db, { invoiceId: "nope", source: "ADMIN_COPY", nowMs: NOW }), null, "없는 청구서");
  assert.equal(await link.issueGuestPayLink(db, { invoiceId: "  ", source: "ADMIN_COPY", nowMs: NOW }), null);
  assert.equal(db.tokens.length, 1);

  // 다시 발급하면 새 토큰 — 이전 링크는 폐기하지 않는다(이미 보낸 안내의 링크가 죽지 않게)
  const again = await link.issueGuestPayLink(db, { invoiceId: "inv1", source: "UNPAID_NOTICE", nowMs: NOW });
  assert.notEqual(again.token, issued.token);
  assert.equal(db.tokens.length, 2);
  assert.equal((await link.resolveGuestPayToken(db, issued.token)).state, "PAYABLE");
  assert.equal((await link.resolveGuestPayToken(db, again.token)).state, "PAYABLE");
});

test("검증 실패 경로: 모양 틀림(DB 안 부름)·없는 토큰·만료·폐기·취소 → 모두 INVALID 하나", async () => {
  const invoices = { inv1: { invoiceStatus: "SENT", paymentStatus: "PENDING", dueYmd: "2026-11-20" } };
  const db = fakeDb({ invoices, now: NOW });
  const issued = await link.issueGuestPayLink(db, { invoiceId: "inv1", source: "INVOICE_NOTICE", nowMs: NOW });

  db.calls.length = 0;
  assert.deepEqual(await link.resolveGuestPayToken(db, "짧은토큰"), { state: "INVALID" });
  assert.deepEqual(await link.resolveGuestPayToken(db, null), { state: "INVALID" });
  assert.equal(db.calls.length, 0, "모양이 틀리면 DB 를 부르지 않는다");

  assert.deepEqual(await link.resolveGuestPayToken(db, SAMPLE_TOKEN), { state: "INVALID" }, "없는 토큰");

  const ok = await link.resolveGuestPayToken(db, issued.token);
  assert.equal(ok.state, "PAYABLE");
  assert.equal(ok.invoiceId, "inv1");
  assert.equal(db.tokens[0].useCount, 1, "통과하면 사용 기록");
  await link.resolveGuestPayToken(db, issued.token, { touch: false });
  assert.equal(db.tokens[0].useCount, 1, "touch:false 는 기록 안 함(승인 재시도)");

  // 만료: 마지막 날(12-04) 다음 날 0시 KST 가 지난 시점의 DB
  const later = fakeDb({ invoices, now: Date.UTC(2026, 11, 4, 15, 0, 0) });
  later.tokens.push({ ...db.tokens[0] });
  assert.deepEqual(await link.resolveGuestPayToken(later, issued.token), { state: "INVALID" }, "만료");
  const justBefore = fakeDb({ invoices, now: Date.UTC(2026, 11, 4, 14, 59, 59) });
  justBefore.tokens.push({ ...db.tokens[0] });
  assert.equal((await link.resolveGuestPayToken(justBefore, issued.token)).state, "PAYABLE", "마지막 날 23:59:59 KST 는 아직 열림");

  // 납부 완료 → PAID(표시만) · 취소 → INVALID
  invoices.inv1 = { invoiceStatus: "PAID", paymentStatus: "PAID", dueYmd: "2026-11-20" };
  assert.equal((await link.resolveGuestPayToken(db, issued.token)).state, "PAID");
  invoices.inv1 = { invoiceStatus: "CANCELED", paymentStatus: "CANCELED", dueYmd: "2026-11-20" };
  assert.deepEqual(await link.resolveGuestPayToken(db, issued.token), { state: "INVALID" });

  // 폐기
  invoices.inv1 = { invoiceStatus: "SENT", paymentStatus: "PENDING", dueYmd: "2026-11-20" };
  assert.equal(await link.revokeGuestPayLinks(db, "inv1"), 1);
  assert.deepEqual(await link.resolveGuestPayToken(db, issued.token), { state: "INVALID" });
});

// ───────────────────────────── 4) 안내 계획 ─────────────────────────────

function invoiceRow(over = {}) {
  return {
    invoiceId: "inv-1", paymentId: "pay-1", studentId: "stu-1", studentName: "김하늘",
    parentId: "par-1", phone: "010-1234-5678", amount: 150000, dueYmd: "2026-12-10", hadPriorNotice: false,
    ...over,
  };
}

test("청구서 안내: 미가입자(payPath 있음)는 pay 링크 — 알림톡 버튼 변수·문자 본문 모두", () => {
  const path = `pay/${SAMPLE_TOKEN}`;
  const { notices } = q.planInvoiceNotices([
    invoiceRow({ payPath: path }),
    invoiceRow({ invoiceId: "inv-2", paymentId: "pay-2", payPath: null }),
  ], { month: 12, academyPhone: "031-000-0000", templateId: "KA01TP_X" });
  assert.equal(notices[0].kakao.buttons[0].linkMo, `${BASE}${path}`);
  assert.equal(notices[0].kakao.variables["#{청구서경로}"], path, "승인 틀 그대로 — 경로 변수만 바뀐다");
  assert.ok(notices[0].kakao.smsBody.endsWith(`${BASE}${path}`));
  assert.equal(notices[1].kakao.buttons[0].linkMo, `${BASE}payments/inv-2`, "가입자는 예전 로그인 링크");

  const sms = q.planInvoiceNotices([invoiceRow({ payPath: path })], { month: 12, academyPhone: "", templateId: "" });
  assert.ok(sms.notices[0].body.endsWith(`청구서 확인하기: ${BASE}${path}`), sms.notices[0].body);
});

test("미납 안내: 미납이 한 장일 때만 pay 링크, 여러 장이면 예전처럼 마이페이지 결제 화면", () => {
  const path = `pay/${SAMPLE_TOKEN}`;
  const base = { studentName: "김하늘", parentId: "par-1", phone: "01012345678", amount: 50000 };
  const one = q.planUnpaidNotices(
    [{ ...base, paymentId: "p1", invoiceId: "i1", studentId: "s1", payPath: path }],
    { kstYmd: "2026-11-14", academyPhone: "", templateId: "KA01TP_U", renderSms: () => "미납 안내" },
  );
  assert.equal(one.notices[0].kakao.buttons[0].linkMo, `${BASE}${path}`);
  const sms = q.planUnpaidNotices(
    [{ ...base, paymentId: "p1", invoiceId: "i1", studentId: "s1", payPath: path }],
    { kstYmd: "2026-11-14", academyPhone: "", templateId: "", renderSms: (v) => `미납 ${v.paymentLink}` },
  );
  assert.ok(sms.notices[0].body.includes(`${BASE}${path}`), sms.notices[0].body);

  const many = q.planUnpaidNotices(
    [
      { ...base, paymentId: "p1", invoiceId: "i1", studentId: "s1", payPath: path },
      { ...base, paymentId: "p2", invoiceId: "i2", studentId: "s1", payPath: null },
    ],
    { kstYmd: "2026-11-14", academyPhone: "", templateId: "KA01TP_U", renderSms: () => "x" },
  );
  assert.equal(many.notices[0].kakao.buttons[0].linkMo, `${BASE}mypage/payments`, "묶음은 이번 범위 밖");
});

test("알림톡 경로 정리(normalizeBillingPath)가 pay/<토큰> 을 그대로 통과시킨다(-·_ 포함)", async () => {
  const vault = await loadTsModule("src/lib/messaging/parent-alimtalk-templates.ts");
  for (let i = 0; i < 20; i += 1) {
    const { token: t } = token.createGuestPayToken();
    assert.equal(vault.normalizeBillingPath(`pay/${t}`), `pay/${t}`);
  }
  assert.equal(vault.normalizeBillingPath(`pay/${SAMPLE_TOKEN}`), `pay/${SAMPLE_TOKEN}`);
});

// ───────────────────────────── 5) 소스 계약(소유권 우회 불가) ─────────────────────────────

const ledger = read("src/lib/payment-ledger.ts");
const checkoutRoute = read("src/app/api/pay/checkout/route.ts");
const confirmRoute = read("src/app/api/pay/confirm/route.ts");

test("결제 시작: 토큰의 청구서와 요청 청구서가 다르면 거부 · 비회원 응답에 학부모 개인정보 없음", () => {
  assert.match(ledger, /if \(guest && guest\.invoiceId !== input\.invoiceId\) \{\s*return \{ ok: false as const, error: "청구서를 찾을 수 없습니다\." \};/);
  const guestReturn = ledger.slice(ledger.indexOf("if (guest) {\n        // 비회원 링크: 학부모 이름"), ledger.indexOf("// 결제창 고객 = 지금 결제하는 사람"));
  assert.ok(guestReturn.length > 0);
  assert.match(guestReturn, /customerKey: guestCustomerKey\(invoice\.invoiceId\)/);
  assert.doesNotMatch(guestReturn, /customerEmail|customerName|customerMobilePhone|payerPhone|payerEmail/, "이름·이메일·연락처를 브라우저로 보내지 않는다");
  // 금액은 서버 청구 금액(잠금 뒤 재확인) — 비회원도 같은 함수를 지난다
  assert.match(ledger, /checkoutAmountsStale\(\[\{ paymentId: invoice\.paymentId, amount: Number\(invoice\.amount\) \}\], freshAmounts\)/);
});

test("결제 승인: 비회원은 토큰의 청구서 «한 장짜리» 주문만(묶음·다른 청구서·다른 보호자 주문 거부) · 금액 비교·잠금 유지", () => {
  const start = ledger.indexOf("export async function confirmTossPayment(");
  const body = ledger.slice(start, ledger.indexOf("function readStoredTossApproval", start));
  assert.match(body, /if \(guest && input\.invoiceId && input\.invoiceId !== guest\.invoiceId\)/);
  assert.match(body, /AND tx\."invoiceId" = \$2/);
  assert.match(body, /AND tx\."parentId" = i\."parentId"/);
  assert.match(body, /"PaymentTransactionItem" it\s+WHERE it\."transactionId" = tx\.id AND it\."paymentId" <> tx\."paymentId"/);
  assert.match(body, /if \(Number\(tx\.amount\) !== Number\(input\.amount\)\)/, "화면 금액 ≠ 주문 금액이면 거부");
  assert.match(body, /claimTossConfirmInTx\(db,/, "승인 직전 청구 잠금(이중 결제 방지) 그대로");
  // 로그인 경로의 가족 연결 재확인은 비회원이 아닐 때만 건너뛰지 않는다
  assert.match(body, /if \(!isGuestInvoiceOwner\(input\.owner\)\) \{\s*const orderStudents/);
});

test("비회원 API: 화면이 보낸 청구서 id 를 쓰지 않고 토큰의 청구서만 · 실패는 같은 문구 + 지연 · 캐시 금지", () => {
  assert.doesNotMatch(checkoutRoute, /body\?\.invoiceId|body\.invoiceId/, "결제 시작은 본문 invoiceId 를 읽지 않는다");
  assert.match(checkoutRoute, /invoiceId: link\.invoiceId,\s*owner: \{ kind: "GUEST_INVOICE", invoiceId: link\.invoiceId, token \}/);
  assert.doesNotMatch(confirmRoute, /body\?\.invoiceId|body\.invoiceId/);
  assert.match(confirmRoute, /owner: \{ kind: "GUEST_INVOICE", invoiceId: link\.invoiceId, token \}/);
  for (const src of [checkoutRoute, confirmRoute]) {
    assert.match(src, /GUEST_PAY_INVALID_MESSAGE/);
    assert.match(src, /guestPayFailDelay\(\)/);
    assert.match(src, /guestPayRateLimitOk\(/);
    assert.match(src, /"Cache-Control": "no-store"/);
    assert.doesNotMatch(src, /requireVerifiedParent/, "로그인을 요구하지 않는다");
  }
});

test("공개 경로·머리글: /pay 는 로그인 미들웨어 대상 아님 · noindex·no-referrer·캐시 금지 · robots 차단", () => {
  const proxy = read("src/proxy.ts");
  assert.doesNotMatch(proxy, /"\/pay\b/, "proxy matcher 에 /pay 가 없어야 로그인 없이 열린다");
  const cfg = read("next.config.ts");
  const block = cfg.slice(cfg.indexOf(`source: "/pay/:path*"`), cfg.indexOf(`source: "/((?!staff`));
  assert.match(block, /"Referrer-Policy", value: "no-referrer"/);
  assert.match(block, /"X-Robots-Tag", value: "noindex, nofollow, noarchive"/);
  assert.match(block, /"Cache-Control", value: "private, no-store, max-age=0"/);
  assert.match(cfg, /apply\/trial\/pay\(\?:\/\|\$\)\|pay\(\?:\/\|\$\)\)/, "공통 머리글 규칙에서 /pay 제외(중복 방지)");
  assert.match(read("src/app/robots.ts"), /"\/pay\/"/);
  // 광고 추적(Meta 픽셀)이 주소(=결제 열쇠)를 외부로 보내지 않게
  assert.match(read("src/lib/privacy/trackingExclusion.ts"), /"\/pay\/", \/\/ 비회원 결제 링크/);
  const page = read("src/app/pay/[token]/page.tsx");
  assert.match(page, /robots: \{ index: false, follow: false/);
  assert.match(page, /referrer: "no-referrer"/);
  assert.match(page, /maskStudentName\(invoice\.studentName\)/);
  assert.doesNotMatch(page, /receiptUrl|parentName|parentPhone|parentEmail/, "영수증·학부모 정보 노출 금지");
  assert.match(page, /href="\/signup\/parent"/);
});

test("마이그레이션: 해시만·CHECK 집합 = 코드 상수 · 청구서 삭제 시 같이 삭제 · RLS · 재실행 안전", () => {
  const sql = read("prisma/migrations/20261114000000_payment_invoice_access_token/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "PaymentInvoiceAccessToken"/);
  assert.match(sql, /REFERENCES "PaymentInvoice"\("id"\) ON DELETE CASCADE/);
  assert.match(sql, /CHECK \("tokenHash" ~ '\^\[0-9a-f\]\{64\}\$'\)/);
  const checkSet = /CHECK \("source" IN \(([^)]*)\)\)/.exec(sql)[1].split(",").map((s) => s.trim().replace(/'/g, "")).sort();
  assert.deepEqual(checkSet, [...rules.GUEST_PAY_LINK_SOURCES].sort(), "DB 제약과 코드 상수가 같은 집합");
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS "PaymentInvoiceAccessToken_tokenHash_key"/);
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'PaymentInvoiceAccessToken_source_check'\)/);
  assert.match(sql, /FORCE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON TABLE "PaymentInvoiceAccessToken" FROM anon, authenticated/);
  assert.doesNotMatch(sql, /"token" text/, "원문 토큰 칸이 없다");
});

test("관리자 «결제 링크 복사»: 원장 권한·학생 일치·미납만·감사 기록(토큰 원문 없음)", () => {
  const action = read("src/app/actions/guest-pay-link.ts");
  assert.match(action, /^"use server";/);
  assert.match(action, /isFinanceOwnerRole\(admin\.appUserRole\)/);
  assert.match(action, /WHERE p\.id = \$1 AND p\."studentId" = \$2/);
  assert.match(action, /row\.status !== "PENDING" && row\.status !== "OVERDUE"/);
  assert.match(action, /action: "GUEST_PAY_LINK_ISSUED"/);
  const audit = action.slice(action.indexOf("await recordPaymentAudit("), action.indexOf("return { ok: true, url"));
  assert.doesNotMatch(audit, /link\.token|link\.url|link\.path/, "감사 기록에 링크 원문을 남기지 않는다");
  const ui = read("src/app/admin/students/[id]/StudentDetailClient.tsx");
  assert.match(ui, /label: "결제 링크 복사"/);
  assert.match(ui, /\{unpaidRow && canManageFinance && \(/, "메뉴는 원장 화면의 미납 행에만");
});

test("청구·미납 안내 발송: 가입 여부 = authUserId 기준 · 미가입자만 링크 발급 · 실패하면 예전 링크", () => {
  const admin = read("src/app/actions/admin.ts");
  assert.equal((admin.match(/\(u\."authUserId" IS NOT NULL\) AS "parentHasAccount"/g) ?? []).length, 2);
  assert.match(admin, /issueGuestPayPathsForNotices\(invoices, \{ source: "INVOICE_NOTICE"/);
  assert.match(admin, /source: "UNPAID_NOTICE"/);
  const svc = read("src/lib/payments/guestPayLinkService.ts");
  assert.match(svc, /if \(!shouldUseGuestPayLink\(row\)\) continue;/);
  assert.match(svc, /catch \(error\) \{\s*console\.error\("\[guest-pay\] 안내용 링크 발급 실패/);
});

// ───────────────────────────── 6) 검수 권장 반영(1·2·3) ─────────────────────────────

test("권장1: 학부모 미연결 청구서는 링크를 발급하지 않는다 · 미납 안내는 받는 사람 = 청구서 대표 보호자일 때만", async () => {
  const db = fakeDb({ invoices: {
    linked: { invoiceStatus: "SENT", paymentStatus: "PENDING", dueYmd: "2026-12-10", parentId: "par-1" },
    unlinked: { invoiceStatus: "SENT", paymentStatus: "PENDING", dueYmd: "2026-12-10", parentId: null },
  }, now: NOW });
  assert.equal(await link.issueGuestPayLink(db, { invoiceId: "unlinked", source: "ADMIN_COPY", nowMs: NOW }), null);
  assert.ok(await link.issueGuestPayLink(db, { invoiceId: "linked", source: "ADMIN_COPY", nowMs: NOW }));
  assert.equal(db.tokens.length, 1);
  const admin = read("src/app/actions/admin.ts");
  assert.match(admin, /i\."parentId" AS "invoiceParentId"/);
  assert.match(admin, /Boolean\(row\.invoiceParentId\) && row\.invoiceParentId === row\.parentId/);
});

test("권장2: «결제 링크 모두 닫기» — 원장 권한·학생 일치·감사 GUEST_PAY_LINK_REVOKED·«N개 닫음»·위험 확인창", async () => {
  // 실제 닫기 동작(살아 있는 링크만 닫고 개수 반환)
  const db = fakeDb({ invoices: { inv1: { invoiceStatus: "SENT", paymentStatus: "PENDING", dueYmd: "2026-12-10", parentId: "p" } }, now: NOW });
  const a = await link.issueGuestPayLink(db, { invoiceId: "inv1", source: "ADMIN_COPY", nowMs: NOW });
  await link.issueGuestPayLink(db, { invoiceId: "inv1", source: "INVOICE_NOTICE", nowMs: NOW });
  assert.equal(await link.revokeGuestPayLinks(db, "inv1"), 2);
  assert.equal(await link.revokeGuestPayLinks(db, "inv1"), 0, "두 번째는 0개");
  assert.deepEqual(await link.resolveGuestPayToken(db, a.token), { state: "INVALID" });

  const action = read("src/app/actions/guest-pay-link.ts");
  const fn = action.slice(action.indexOf("export async function revokeGuestPayLinksForPayment"));
  assert.match(fn, /isFinanceOwnerRole\(admin\.appUserRole\)/);
  assert.match(fn, /WHERE p\.id = \$1 AND p\."studentId" = \$2/);
  assert.match(fn, /revokeInvoiceGuestLinks\(row\.invoiceId\)/);
  assert.match(fn, /action: "GUEST_PAY_LINK_REVOKED"/);
  const ui = read("src/app/admin/students/[id]/StudentDetailClient.tsx");
  assert.match(ui, /label: "결제 링크 모두 닫기",[\s\S]{0,200}tone: "danger"/);
  const handler = ui.slice(ui.indexOf("async function revokeGuestPayLinks("), ui.indexOf("// 결제 상태 변경 — 취소"));
  assert.ok(handler.indexOf("await confirmDanger(") < handler.indexOf("revokeGuestPayLinksForPayment("), "확인창 뒤에만 닫는다");
  assert.match(handler, /if \(!ok\) return;/);
  assert.match(handler, /`결제 링크 \$\{result\.count\}개 닫음`/);
});

test("권장3: 비회원 화면·API 의 입금 계좌는 필요한 칸만(예금주 이름 제거)", () => {
  const full = { bankName: "국민", accountNumber: "123-45", customerName: "김엄마", amount: 150000, dueDate: "2027-02-06T05:30:00Z", dueLabel: "2027년 2월 6일 14:30", expired: false, extra: "x" };
  const view = rules.toGuestVirtualAccountView(full);
  assert.deepEqual(view, { bankName: "국민", accountNumber: "123-45", customerName: null, amount: 150000, dueDate: full.dueDate, dueLabel: full.dueLabel, expired: false });
  assert.ok(!("extra" in view), "모르는 칸도 넘기지 않는다");
  assert.equal(rules.toGuestVirtualAccountView(null), null);
  assert.match(read("src/app/pay/[token]/page.tsx"), /toGuestVirtualAccountView\(await getVirtualAccountState\(invoice\.invoiceId\)\)/);
  assert.match(checkoutRoute, /openVirtualAccount: toGuestVirtualAccountView\(result\.openVirtualAccount\)/);
  assert.match(confirmRoute, /virtualAccount: toGuestVirtualAccountView\(result\.virtualAccount\)/);
  assert.doesNotMatch(read("src/app/pay/[token]/success/page.tsx"), /bg-white/, "색은 토큰만(권장5)");
});
