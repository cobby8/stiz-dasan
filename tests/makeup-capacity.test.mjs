import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeMakeupSql,
  computeRemainingSeats,
  isMakeupSlotFull,
  formatSeatLabel,
  MAKEUP_CAPACITY_FULL_MESSAGE,
} from "../src/lib/makeup/capacity.ts";

// 2026-08-05 사고 재발 방지.
//
// 무슨 일이 있었나:
//   보강 예약 모달이 잔여석을 계산하지 않고 **총정원을 그대로** 잔여석처럼 보여줬다
//   (remaining: c.capacity). 원장이 그 숫자를 "빈 자리"로 읽고 예약을 넣어 정원 초과가 났다.
//
// 그래서 잠그는 것 세 가지:
//   ① 잔여석 = 정원 − 수강 인원 − 그 날 활성 보강 수. 취소된 보강은 자리를 차지하지 않는다.
//   ② 모르는 값을 최대값으로 낙관 표시하지 않는다.
//   ③ 화면 표시뿐 아니라 **저장 시점에 서버가 다시 검증**한다(두 예약 경로 모두).

const queries = readFileSync(new URL("../src/lib/queries.ts", import.meta.url), "utf8");
const adminActions = readFileSync(new URL("../src/app/actions/admin.ts", import.meta.url), "utf8");
const makeupClient = readFileSync(
  new URL("../src/app/admin/makeup/MakeupClient.tsx", import.meta.url),
  "utf8",
);

// ── ① 계산식 ────────────────────────────────────────────────────────────────

test("① 잔여석 = 정원 − 수강 인원 − 그 날 활성 보강 수", () => {
  assert.equal(
    computeRemainingSeats({ capacity: 10, enrolled: 6, bookedMakeups: 2 }),
    2,
  );
  assert.equal(
    computeRemainingSeats({ capacity: 8, enrolled: 8, bookedMakeups: 0 }),
    0,
  );
});

test("① 정원을 넘겨도 음수가 아니라 0(마감)으로 본다", () => {
  assert.equal(computeRemainingSeats({ capacity: 5, enrolled: 5, bookedMakeups: 3 }), 0);
  assert.equal(isMakeupSlotFull({ capacity: 5, enrolled: 5, bookedMakeups: 3 }), true);
});

test("① 잔여석이 0이면 마감, 1 이상이면 예약 가능", () => {
  assert.equal(isMakeupSlotFull({ capacity: 10, enrolled: 9, bookedMakeups: 1 }), true);
  assert.equal(isMakeupSlotFull({ capacity: 10, enrolled: 9, bookedMakeups: 0 }), false);
});

test("① 값이 비어 있어도(null/undefined) 계산이 깨지지 않는다", () => {
  assert.equal(
    computeRemainingSeats({ capacity: 6, enrolled: undefined, bookedMakeups: null }),
    6,
  );
});

test("① 취소된 보강은 자리를 차지하지 않는다 — 활성 판정은 status <> 'CANCELLED'", () => {
  // 기존 중복 방지 로직(regular-absence-admin)과 동일한 판정을 써야 한다.
  assert.equal(activeMakeupSql("ms"), `ms.status <> 'CANCELLED'`);
  // 조회/저장 검증 SQL 모두 이 조건을 통해 CANCELLED 를 제외한다.
  assert.match(queries, /activeMakeupSql\("ms"\)/);
  assert.match(adminActions, /activeMakeupSql\("ms"\)/);
});

// ── ② 낙관 표시 금지 ────────────────────────────────────────────────────────

test("② 잔여석을 모르면 총정원을 잔여석처럼 보여주지 않는다", () => {
  const label = formatSeatLabel({ capacity: 12, enrolled: 0, bookedMakeups: 0 }, false);
  assert.match(label, /확인 중/);
  assert.doesNotMatch(label, /잔여 12석/);
});

test("② 잔여석을 알면 '잔여 N석 · 정원 M명', 마감이면 '정원 마감'", () => {
  assert.equal(
    formatSeatLabel({ capacity: 12, enrolled: 9, bookedMakeups: 1 }, true),
    "잔여 2석 · 정원 12명",
  );
  assert.match(
    formatSeatLabel({ capacity: 12, enrolled: 12, bookedMakeups: 0 }, true),
    /정원 마감/,
  );
});

test("② 모달이 remaining 에 총정원을 넣던 코드가 남아 있지 않다", () => {
  assert.doesNotMatch(makeupClient, /remaining:\s*c\.capacity/);
  // 표시는 공용 계산식(formatSeatLabel)을 그대로 쓴다.
  assert.match(makeupClient, /formatSeatLabel\(slot, seatsLoaded\)/);
  // 마감된 슬롯은 선택 자체가 막힌다.
  assert.match(makeupClient, /disabled=\{full\}/);
});

test("② 날짜 기준으로 잔여석을 다시 조회한다", () => {
  assert.match(makeupClient, /loadMakeupSlotAvailability\(/);
  // 그 날의 보강만 세도록 makeupDate 로 필터한다.
  // 2026-11-14 검수: makeupDate 는 timestamptz, DB 는 UTC — 한국 날짜로 바꿔 센다(학부모 예약은 KST 자정 = 전날 15:00Z 로 저장된다)
  assert.match(queries, /\(ms\."makeupDate" AT TIME ZONE 'Asia\/Seoul'\)::date = \$1::date/);
  assert.doesNotMatch(queries, /ms\."makeupDate"::date/, "UTC 날짜로 세면 학부모 예약이 하루 앞 날짜로 잡힌다");
});

// ── ③ 저장 시점 서버 재검증 ─────────────────────────────────────────────────

test("③ 예약 저장 전에 서버가 정원을 다시 확인한다", () => {
  assert.match(adminActions, /async function assertMakeupSeatAvailable/);
  const bookIndex = adminActions.indexOf("export async function bookMakeupSession");
  assert.ok(bookIndex > 0, "bookMakeupSession 이 있어야 한다");
  const body = adminActions.slice(bookIndex, bookIndex + 2500);
  const guardAt = body.indexOf("assertMakeupSeatAvailable(data.makeupClassId");
  const insertAt = body.indexOf('INSERT INTO "MakeupSession"');
  assert.ok(guardAt > 0, "저장 전에 정원 검증을 호출해야 한다");
  assert.ok(guardAt < insertAt, "정원 검증은 INSERT 보다 먼저여야 한다");
});

test("③ 정원 초과 거부 문구는 원장이 다음 행동을 알 수 있어야 한다", () => {
  assert.match(MAKEUP_CAPACITY_FULL_MESSAGE, /정원이 찼습니다/);
  assert.match(MAKEUP_CAPACITY_FULL_MESSAGE, /다른 날짜나 반/);
  assert.match(adminActions, /throw new Error\(MAKEUP_CAPACITY_FULL_MESSAGE\)/);
});

test("③ 결석 신고 → 보강 지정 경로도 같은 검증을 통과한다", () => {
  const absenceAdmin = readFileSync(
    new URL("../src/app/actions/regular-absence-admin.ts", import.meta.url),
    "utf8",
  );
  // 이 경로는 bookMakeupSession 을 재사용하므로 정원 검증이 함께 적용된다.
  assert.match(absenceAdmin, /await bookMakeupSession\(\{/);
  // 기존 중복 방지(같은 학생·원래반·결석일)는 그대로 유지되어야 한다.
  assert.match(absenceAdmin, /이미 지정된 보강이 있습니다/);
});

test("③ 수강 인원 판정은 출결 화면과 같은 기준(ACTIVE + 통합 학생 제외)", () => {
  // 조회와 저장 검증이 같은 기준을 써야 화면·저장이 어긋나지 않는다.
  for (const source of [queries, adminActions]) {
    assert.match(source, /WHERE e\."classId" = c\.id AND e\.status = 'ACTIVE'/);
  }
  assert.match(adminActions, /JOIN "Student" s ON s\.id = e\."studentId" AND \$\{notMergedStudent\("s"\)\}/);
});
