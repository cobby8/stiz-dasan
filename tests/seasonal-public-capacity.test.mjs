import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const service = readFileSync("src/lib/seasonal/service.ts", "utf8");
const planning = readFileSync("src/lib/seasonal/planning.ts", "utf8");
const types = readFileSync("src/components/seasonal/types.ts", "utf8");
const detail = readFileSync("src/components/seasonal/SeasonalDetailClient.tsx", "utf8");
const apply = readFileSync("src/components/seasonal/SeasonalApplyClient.tsx", "utf8");
const list = readFileSync("src/components/seasonal/SeasonalListClient.tsx", "utf8");
const migration = readFileSync(
  "prisma/migrations/20260722153000_allow_open_null_capacity/migration.sql",
  "utf8",
);

test("public seasonal pages hide open offerings until capacity is confirmed", () => {
  assert.match(service, /capacity: \{ not: null \}/);
  const publicOfferingSource = service.slice(service.indexOf("function publicOffering"), service.indexOf("function publicSeason"));
  assert.doesNotMatch(publicOfferingSource, /offering\.capacity === null/);
  assert.doesNotMatch(service, /capacity: byId\.get/);
  // 공개 응답은 남은 자리 숫자 대신 3단계(정원 미확정이면 null) — 2026-11-13 f9
  assert.match(service, /const level = capacity === null \? null : seatLevel\(capacity - enrolled\)/);
  assert.match(service, /waitlistEnabled: capacity !== null/);
});

test("seasonal planning and public UI still handle unspecified capacity defensively", () => {
  assert.match(planning, /capacity: number \| null/);
  assert.match(planning, /offering\.capacity !== null &&/);
  assert.match(types, /seatLevel: SeatLevel \| null/);
  assert.match(detail, /item\.capacity === null/);
  assert.match(apply, /function isFull\(item: SeasonalClass\)/);
  assert.match(apply, /function remainingText\(item: SeasonalClass\)/);
  assert.match(list, /hasOpenCapacity/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "SpecialProgramOffering_open_capacity_check"/);
});
