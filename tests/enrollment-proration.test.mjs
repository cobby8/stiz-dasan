import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 반 변경 시 수강료 일할 계산. 원장 결정(2026-08-09): **수업 회차 기준**.
//
// ★ 나누는 기준은 달력이 아니라 **연간 계획표의 실제 수업일**이다.
//   원장이 구글 캘린더 "N월 M주차"로 월별 요일당 4회에 맞춰 운영한다.
//   달력만 세면 9월 화요일이 5회로 잡혀 회당 단가가 실제보다 싸진다.
// 돈이 걸린 계산이라 실제로 실행해서 숫자를 확인한다.

const source = await readFile("src/lib/enrollment/proration.ts", "utf8");
const transpiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { computeClassChangeProration, describeProration, countRemaining } = await import(
  `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`
);

// 2026-09 계획표(요일당 4회). 달력상 화요일은 5번이지만 학원은 4회만 운영한다.
const SEP_THU = ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24"];
const SEP_TUE = ["2026-09-01", "2026-09-08", "2026-09-15", "2026-09-22"];

test("기준일 이후 남은 회차를 센다", () => {
  assert.equal(countRemaining(SEP_THU, "2026-09-15"), 2);
  assert.equal(countRemaining(SEP_TUE, "2026-09-15"), 2);
  assert.equal(countRemaining(SEP_TUE, "2026-09-01"), 4);
});

test("계획표 기준으로 계산한다 — 달력의 5번째 화요일에 속지 않는다", () => {
  const result = computeClassChangeProration({
    effectiveFrom: "2026-09-15",
    from: { monthlyFee: 100000, classDates: SEP_THU },
    to: { monthlyFee: 120000, classDates: SEP_TUE },
  });
  assert.equal(result.fromTotalSessions, 4);
  assert.equal(result.toTotalSessions, 4); // 달력은 5회지만 계획표는 4회
  assert.equal(result.fromRemainingSessions, 2);
  assert.equal(result.toRemainingSessions, 2);
  assert.equal(result.fromCredit, 50000); // 100,000 ÷ 4 × 2
  assert.equal(result.toCharge, 60000); // 120,000 ÷ 4 × 2  (달력 기준이면 72,000 이었다)
  assert.equal(result.diff, 10000);
});

test("달 1일부터 바뀌면 일할 계산을 하지 않는다", () => {
  const result = computeClassChangeProration({
    effectiveFrom: "2026-09-01",
    from: { monthlyFee: 100000, classDates: SEP_THU },
    to: { monthlyFee: 120000, classDates: SEP_TUE },
  });
  assert.equal(result.needsProration, false);
  assert.equal(result.diff, 0);
  assert.match(describeProration(result, { from: "A", to: "B" })[0], /일할 계산이 없습니다/);
});

test("계획표에 그달 수업일이 없으면 추측하지 않는다", () => {
  // 돈이라서 모르면 0으로 두고 원장에게 알린다.
  const result = computeClassChangeProration({
    effectiveFrom: "2026-09-15",
    from: { monthlyFee: 100000, classDates: [] },
    to: { monthlyFee: 120000, classDates: SEP_TUE },
  });
  assert.equal(result.scheduleUnavailable, true);
  assert.equal(result.diff, 0);
  assert.equal(result.fromCredit, 0);
  assert.equal(result.toCharge, 0);
  assert.match(describeProration(result, { from: "A", to: "B" })[0], /연간 계획표에 없어 자동 계산할 수 없습니다/);
});

test("싼 반으로 옮기면 음수가 나온다(다음 달 청구에서 차감)", () => {
  const result = computeClassChangeProration({
    effectiveFrom: "2026-09-15",
    from: { monthlyFee: 120000, classDates: SEP_TUE },
    to: { monthlyFee: 100000, classDates: SEP_THU },
  });
  assert.equal(result.diff, -10000);
});

test("기준일을 양쪽에 똑같이 적용한다", () => {
  const result = computeClassChangeProration({
    effectiveFrom: "2026-09-15",
    from: { monthlyFee: 100000, classDates: SEP_TUE },
    to: { monthlyFee: 100000, classDates: SEP_TUE },
  });
  assert.equal(result.fromRemainingSessions, result.toRemainingSessions);
  assert.equal(result.diff, 0);
});

test("금액은 원 단위로 떨어진다", () => {
  // 3회 남았을 때처럼 나누어떨어지지 않는 경우에도 소수점이 남으면 안 된다.
  const result = computeClassChangeProration({
    effectiveFrom: "2026-09-08",
    from: { monthlyFee: 100000, classDates: ["2026-09-07", "2026-09-14", "2026-09-21"] },
    to: { monthlyFee: 110000, classDates: SEP_TUE },
  });
  assert.ok(Number.isInteger(result.fromCredit));
  assert.ok(Number.isInteger(result.toCharge));
  assert.ok(Number.isInteger(result.diff));
});

test("원장이 근거를 보고 발행할 수 있게 설명을 만든다", () => {
  const result = computeClassChangeProration({
    effectiveFrom: "2026-09-15",
    from: { monthlyFee: 100000, classDates: SEP_THU },
    to: { monthlyFee: 120000, classDates: SEP_TUE },
  });
  const lines = describeProration(result, { from: "목요일 3교시", to: "화요일 6교시" });
  assert.match(lines[0], /계획표상 그달 4회 중 남은 2회 → 50,000원 빼기/);
  assert.match(lines[1], /계획표상 그달 4회 중 듣는 2회 → 60,000원 더하기/);
});

// ── 3회 달(설 주간·연휴) — 원장 결정 2026-10-30: 회당 = 정가 ÷ 4 ──
// 3회 달은 청구 작업대가 1회분을 빼고 청구하므로(정가×3/4), 회당도 정가÷4 여야 맞는다.
const FEB_MON_3 = ["2027-02-01", "2027-02-15", "2027-02-22"]; // 2027-02 월요일(설 주간 휴무)

test("3회 달도 회당 단가는 정가÷4 — 그달 횟수로 나누면 33% 비싸진다", () => {
  const result = computeClassChangeProration({
    effectiveFrom: "2027-02-14",
    from: { monthlyFee: 100000, classDates: FEB_MON_3 },
    to: { monthlyFee: 120000, classDates: FEB_MON_3 },
  });
  assert.equal(result.fromTotalSessions, 3);
  assert.equal(result.fromRemainingSessions, 2);
  assert.equal(result.fromCredit, 50000); // 25,000 × 2 (예전 계산은 66,667)
  assert.equal(result.toCharge, 60000);   // 30,000 × 2
  assert.equal(result.diff, 10000);
});

test("3회 달 전체를 옮기면 그달 청구액(정가×3/4)과 같은 금액이 빠진다", () => {
  const result = computeClassChangeProration({
    effectiveFrom: "2027-02-02", // 1일이 아닌 날, 3회 모두 남음
    from: { monthlyFee: 100000, classDates: ["2027-02-03", "2027-02-17", "2027-02-24"] },
    to: { monthlyFee: 100000, classDates: ["2027-02-03", "2027-02-17", "2027-02-24"] },
  });
  assert.equal(result.fromRemainingSessions, 3);
  assert.equal(result.fromCredit, 75000);
});

test("4회 달은 예전과 같고, 5회 이상 잡힌 달만 그 횟수로 나눈다", async () => {
  const { sessionDivisor } = await import(`data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`);
  assert.equal(sessionDivisor(3), 4);
  assert.equal(sessionDivisor(4), 4);
  assert.equal(sessionDivisor(5), 5);
});

test("정가 기준 횟수는 청구 작업대와 같은 값이다", async () => {
  const workbench = await readFile("src/lib/billing/workbench.ts", "utf8");
  const proration = await readFile("src/lib/enrollment/proration.ts", "utf8");
  const pick = (s) => Number(/STANDARD_MONTHLY_SESSIONS = (\d+)/.exec(s)?.[1]);
  assert.equal(pick(workbench), 4);
  assert.equal(pick(proration), pick(workbench));
});
