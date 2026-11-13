// 학부모 «자주 쓰는 결제 방법»(2026-11-13 원장 결정 방식 ①) — 규칙을 실제로 실행해 확인한다.
//  ① 방법 코드 → 토스 결제창 요청(간편결제 = CARD+DIRECT+easyPay, 카드 = 통합창 DEFAULT)
//  ② 승인 응답(method·easyPay.provider) → 저장 값
//  ③ 바로가기 실패 시 통합창 전환 판정(취소는 재시도 안 함)
//  ④ 값 화이트리스트 + DB CHECK 제약과 같은 집합
//  ⑤ 승인 지점 연결·화면 연결(정적)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsModule } from "./_ts-module.mjs";

const m = await loadTsModule("src/lib/payments/preferredMethod.ts");
const read = (path) => readFileSync(path, "utf8");

test("① 간편결제 코드 = 토스 «간편결제사 코드» 영문 값(TOSSPAY·KAKAOPAY·NAVERPAY)", () => {
  assert.deepEqual({ ...m.EASY_PAY_CODES }, { TOSSPAY: "TOSSPAY", KAKAOPAY: "KAKAOPAY", NAVERPAY: "NAVERPAY" });
});

test("① 방법 → 결제창 요청: 간편결제는 바로가기, 카드·실패 후는 통합창, 계좌 방식은 그대로", () => {
  assert.deepEqual(m.tossRequestFor("TOSSPAY"), { method: "CARD", card: { flowMode: "DIRECT", easyPay: "TOSSPAY" } });
  assert.deepEqual(m.tossRequestFor("KAKAOPAY"), { method: "CARD", card: { flowMode: "DIRECT", easyPay: "KAKAOPAY" } });
  assert.deepEqual(m.tossRequestFor("NAVERPAY"), { method: "CARD", card: { flowMode: "DIRECT", easyPay: "NAVERPAY" } });
  assert.deepEqual(m.tossRequestFor("CARD"), { method: "CARD", card: { flowMode: "DEFAULT" } });
  assert.deepEqual(m.tossRequestFor("TOSSPAY", true), { method: "CARD", card: { flowMode: "DEFAULT" } }, "다시 열 때는 통합창");
  assert.deepEqual(m.tossRequestFor("TRANSFER"), { method: "TRANSFER" });
  assert.deepEqual(m.tossRequestFor("VIRTUAL_ACCOUNT"), { method: "VIRTUAL_ACCOUNT" });
  // 서버 결제 준비 API 에는 기존 3가지 방식만 간다(간편결제 = CARD)
  for (const v of ["TOSSPAY", "KAKAOPAY", "NAVERPAY", "CARD"]) assert.equal(m.serverMethodFor(v), "CARD");
  assert.equal(m.serverMethodFor("TRANSFER"), "TRANSFER");
  assert.equal(m.serverMethodFor("VIRTUAL_ACCOUNT"), "VIRTUAL_ACCOUNT");
});

test("① 큰 버튼 글: 받침에 따라 «로/으로»", () => {
  assert.equal(m.quickPayLabel("TOSSPAY"), "토스페이로 결제");
  assert.equal(m.quickPayLabel("CARD"), "카드로 결제");
  assert.equal(m.quickPayLabel("TRANSFER"), "계좌이체로 결제");
  assert.equal(m.quickPayLabel("VIRTUAL_ACCOUNT"), "무통장입금으로 결제");
});

test("② 승인 응답 → 저장 값: easyPay.provider 가 우선, 없으면 method", () => {
  const f = m.preferredMethodFromTossPayment;
  assert.equal(f({ method: "간편결제", easyPay: { provider: "토스페이" } }), "TOSSPAY");
  assert.equal(f({ method: "카드", easyPay: { provider: "토스페이" } }), "TOSSPAY", "토스페이로 낸 카드 결제도 토스페이");
  assert.equal(f({ method: "간편결제", easyPay: { provider: "카카오페이" } }), "KAKAOPAY");
  assert.equal(f({ method: "간편결제", easyPay: { provider: "네이버페이" } }), "NAVERPAY");
  assert.equal(f({ method: "EASY_PAY", easyPay: { provider: "NAVERPAY" } }), "NAVERPAY", "영문 형식도");
  assert.equal(f({ method: "간편결제", easyPay: { provider: "삼성페이" } }), "CARD", "바로가기 없는 간편결제는 통합창");
  assert.equal(f({ method: "카드", easyPay: null }), "CARD");
  assert.equal(f({ method: "계좌이체" }), "TRANSFER");
  assert.equal(f({ method: "가상계좌" }), "VIRTUAL_ACCOUNT");
  assert.equal(f({ method: "휴대폰" }), null, "모르는 방법은 저장 안 함");
  assert.equal(f({}), null);
  assert.equal(f(null), null);
});

test("③ 바로가기 실패 → 통합창 전환 판정", () => {
  const s = m.shouldFallbackToDefault;
  assert.equal(s("TOSSPAY", { code: "NOT_SUPPORTED_METHOD" }), true, "미계약·미지원");
  assert.equal(s("KAKAOPAY", { code: "INVALID_EASY_PAY" }), true);
  assert.equal(s("NAVERPAY", new Error("알 수 없음")), true, "코드 없는 오류도 통합창으로");
  assert.equal(s("TOSSPAY", { code: "USER_CANCEL" }), false, "사용자가 닫으면 재시도 안 함");
  assert.equal(s("TOSSPAY", { code: "PAY_PROCESS_CANCELED" }), false);
  assert.equal(s("CARD", { code: "NOT_SUPPORTED_METHOD" }), false, "카드는 이미 통합창");
  assert.equal(s("VIRTUAL_ACCOUNT", { code: "X" }), false);
  assert.equal(s("TOSSPAY", { code: "X" }, true), false, "한 번만 다시 연다");
});

test("③ requestTossWithFallback: 실패하면 안내 후 통합창으로 한 번, 취소는 그대로 던짐", async () => {
  const calls = [];
  const notes = [];
  let fail = true;
  await m.requestTossWithFallback("KAKAOPAY", async (part) => {
    calls.push(part);
    if (fail) { fail = false; throw Object.assign(new Error("미계약"), { code: "NOT_SUPPORTED_METHOD" }); }
  }, (msg) => notes.push(msg));
  assert.deepEqual(calls, [
    { method: "CARD", card: { flowMode: "DIRECT", easyPay: "KAKAOPAY" } },
    { method: "CARD", card: { flowMode: "DEFAULT" } },
  ]);
  assert.deepEqual(notes, ["이 결제 방법은 지금 쓸 수 없어요. 카드·간편결제 전체 화면으로 열게요."]);

  const cancelCalls = [];
  await assert.rejects(
    m.requestTossWithFallback("TOSSPAY", async (part) => { cancelCalls.push(part); throw Object.assign(new Error("취소되었습니다."), { code: "USER_CANCEL" }); }, () => assert.fail("취소는 안내 없음")),
    /취소되었습니다/,
  );
  assert.equal(cancelCalls.length, 1, "취소면 다시 열지 않는다");

  // 통합창도 실패하면 그 오류를 화면에 넘긴다(무한 반복 없음)
  const twice = [];
  await assert.rejects(m.requestTossWithFallback("NAVERPAY", async (part) => { twice.push(part); throw Object.assign(new Error("둘 다 실패"), { code: "X" }); }, () => {}), /둘 다 실패/);
  assert.equal(twice.length, 2);
});

test("④ 값 화이트리스트(대소문자·공백 정리, 모르는 값은 null) + DB CHECK 와 같은 집합", () => {
  const n = m.normalizePreferredPaymentMethod;
  assert.equal(n(" kakaopay "), "KAKAOPAY");
  assert.equal(n("CARD"), "CARD");
  assert.equal(n(""), null);
  assert.equal(n("PAYCO"), null);
  assert.equal(n("'; DROP TABLE"), null);
  assert.equal(n(42), null);
  assert.equal(n(null), null);
  const sql = read("prisma/migrations/20261113160000_parent_preferred_payment_method/migration.sql");
  const inList = sql.match(/IN \(([^)]+)\)/)[1].split(",").map((v) => v.trim().replace(/'/g, ""));
  assert.deepEqual([...inList].sort(), [...m.PREFERRED_PAYMENT_METHODS].sort(), "코드 상수 = DB 제약");
  assert.deepEqual(m.PAYMENT_METHOD_OPTIONS.map((o) => o.value), [...m.PREFERRED_PAYMENT_METHODS], "화면 버튼 = 저장 가능한 값");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "preferredPaymentMethod" TEXT/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "preferredPaymentMethodUpdatedAt" TIMESTAMPTZ/);
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /preferredPaymentMethod\s+String\?/);
  assert.match(schema, /preferredPaymentMethodUpdatedAt\s+DateTime\?\s+@db\.Timestamptz\(6\)/);
});

test("⑤ 승인 완료 지점에서 기억 · 저장 실패는 던지지 않는다 · 화면은 공통 부품", () => {
  const ledger = read("src/lib/payment-ledger.ts");
  const confirm = ledger.slice(ledger.indexOf("export async function confirmTossPayment("), ledger.indexOf("async function loadBundleCandidateRows("));
  assert.equal((confirm.match(/await rememberPaymentMethodFromToss\(tx\.parentId, /g) || []).length, 3, "승인·복구·무통장 계좌 발급");
  assert.ok(
    confirm.lastIndexOf("rememberPaymentMethodFromToss(tx.parentId, result)") > confirm.indexOf("const finalized = await finalizeVerifiedTossPayment"),
    "납부 반영이 끝난 뒤에 기억한다",
  );
  const store = read("src/lib/payments/preferredMethodStore.ts");
  assert.equal((store.match(/catch \(error\)/g) || []).length, 2, "읽기·쓰기 모두 실패를 삼킨다(결제 안 막음)");
  assert.match(store, /WHERE id = \$1 AND "withdrawnAt" IS NULL/);
  assert.doesNotMatch(store, /prisma\.\w+\.(update|findFirst|findUnique|upsert)/, "raw SQL 만");

  const single = read("src/app/payments/[invoiceId]/PaymentCheckoutClient.tsx");
  const bundle = read("src/app/mypage/payments/checkout/BundleCheckoutClient.tsx");
  for (const src of [single, bundle]) {
    assert.match(src, /<PaymentMethodPicker/);
    assert.match(src, /requestTossWithFallback\(/);
    assert.match(src, /serverMethodFor\(/);
  }
  assert.match(read("src/app/payments/[invoiceId]/page.tsx"), /readPreferredPaymentMethod\(user\.appUserId\)/);
  assert.match(read("src/app/mypage/payments/checkout/page.tsx"), /readPreferredPaymentMethod\(parent\.appUserId\)/);
  assert.match(read("src/app/mypage/settings/page.tsx"), /<PaymentMethodRow current=\{preferredMethod\} \/>/);
  // 브랜드 로고 이미지는 쓰지 않는다(글자 + Material Symbols)
  assert.doesNotMatch(read("src/components/parent/PaymentMethodPicker.tsx"), /<img|lucide/);
});
