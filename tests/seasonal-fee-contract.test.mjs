import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const service = await readFile(new URL("../src/lib/seasonal/service.ts", import.meta.url), "utf8");
const adminRoute = await readFile(new URL("../src/app/api/admin/seasonal/route.ts", import.meta.url), "utf8");

test("public application saves tuition and shuttle fee snapshots with the final total", () => {
  assert.match(service, /tuitionPriceSnapshot:\s*assignment\.priceSnapshot/);
  assert.match(service, /shuttleFeeSnapshot/);
  assert.match(service, /priceSnapshot:\s*assignment\.priceSnapshot \+ shuttleFeeSnapshot/);
  assert.match(service, /hasSeasonalShuttleSelection\(requested\?\.shuttle\)/);
});

test("admin offering writes validate a non-negative configurable shuttle fee", () => {
  assert.match(adminRoute, /shuttleFee:\s*nonNegativeInt\(data\.shuttleFee \?\? 0,\s*"셔틀비"\)/);
  assert.match(adminRoute, /update\.shuttleFee = nonNegativeInt\(data\.shuttleFee,\s*"셔틀비"\)/);
});

test("admin reassignment preserves a valid shuttle request and recomputes the final snapshot", () => {
  assert.match(adminRoute, /include:\s*\{\s*application:\s*true,\s*offering:\s*true,\s*shuttleRequest:\s*true\s*\}/);
  // 셔틀비 계산은 공개 신청과 같은 resolveShuttleFee로 통일했다(중복 구현 제거).
  //   (2026-11-18 날짜 모드 중간 합류: 그 값에 공개 신청과 같은 남은 회차 비율 proratedPrice 를 얹는다)
  assert.match(adminRoute, /const normalShuttleFee = resolveShuttleFee\(offering,\s*Boolean\(before\.shuttleRequest\)\)/);
  assert.match(adminRoute, /const shuttleFeeSnapshot = assignment\.proration\s*\?\s*proratedPrice\(normalShuttleFee,[^)]*\)\s*:\s*normalShuttleFee;/);
  assert.match(adminRoute, /priceSnapshot:\s*assignment\.priceSnapshot \+ shuttleFeeSnapshot/);
});
