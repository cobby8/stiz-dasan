// 학부모 «청구·수납» 결제 불가 안내의 입금 계좌 — 원장 확인 번호(2026-11-09)와 서버 전용 경로를 못박는다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const mod = readFileSync(new URL("../src/lib/payments/academy-bank-account.ts", import.meta.url), "utf8");
const page = readFileSync(new URL("../src/app/mypage/payments/page.tsx", import.meta.url), "utf8");
const client = readFileSync(new URL("../src/app/mypage/payments/PaymentRequestClient.tsx", import.meta.url), "utf8");
const rental = readFileSync(new URL("../src/lib/rental/gym-rental-notify.ts", import.meta.url), "utf8");

const accountOf = (src) => src.match(/"하나은행 (\d+) \(예금주 권혜미\)"/)?.[1];

test("원장이 확인한 계좌번호 55491019425407", () => {
  assert.equal(accountOf(mod), "55491019425407");
});

test("대관 화면 계좌와 같은 번호(한쪽만 바뀌지 않게)", () => {
  assert.equal(accountOf(rental), accountOf(mod));
});

test("서버 전용 모듈이고, 화면(클라이언트)은 import 하지 않는다", () => {
  assert.match(mod, /^import "server-only";/);
  assert.match(page, /academyBankAccount\(\)/);
  assert.doesNotMatch(client, /academy-bank-account/);
});
