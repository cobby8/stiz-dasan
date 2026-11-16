// 대회준비반 수강료 공개 숨김(2026-11-16 원장 지시)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const m = await loadTsModule("src/lib/programs/publicPrice.ts");

test("대회준비반만 공개 금액을 숨긴다", () => {
  assert.equal(m.isPublicPriceHidden("대회준비반"), true);
  assert.equal(m.isPublicPriceHidden(" 대회준비반 "), true);
  assert.equal(m.isPublicPriceHidden("주중취미반"), false);
  assert.equal(m.isPublicPriceHidden(null), false);
});

test("프로그램 소개 화면과 상담 챗봇이 같은 판정을 쓴다", () => {
  const page = readFileSync("src/app/programs/page.tsx", "utf8");
  assert.match(page, /isPublicPriceHidden\(program\.name\) \?/);
  const chat = readFileSync("src/app/api/chat/route.ts", "utf8");
  assert.match(chat, /const priceHidden = isPublicPriceHidden\(p\.name\);/);
  for (const key of ["priceWeek2", "priceWeek3", "priceDaily"]) assert.match(chat, new RegExp(`!priceHidden && p\.${key} != null`));
});
