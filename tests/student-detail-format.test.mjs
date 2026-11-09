import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 관리자 학생 상세 — 셔틀 희망 시각 표기·«이번 달 요약» 달 고르기를 실제로 돌려 본다.
const { toHhmm, pickMonthSummary } = await loadTsModule("src/lib/studentDetailFormat.ts");

test("셔틀 희망 시각은 24시간 «HH:MM» 으로 줄인다", () => {
  assert.equal(toHhmm("오후 3:45:00"), "15:45");
  assert.equal(toHhmm("오후 12:30:00"), "12:30");
  assert.equal(toHhmm("오전 12:10"), "00:10");
  assert.equal(toHhmm("오전 9:05:00"), "09:05");
  assert.equal(toHhmm("9:05"), "09:05");
  assert.equal(toHhmm("PM 3:45"), "15:45");
  assert.equal(toHhmm("3:45 PM"), "15:45");
  assert.equal(toHhmm("17:00"), "17:00");
  // 시각 모양이 아니면 원문 유지, 빈 값은 null
  assert.equal(toHhmm("하교 후"), "하교 후");
  assert.equal(toHhmm("25:00"), "25:00");
  assert.equal(toHhmm(""), null);
  assert.equal(toHhmm(null), null);
});

test("요약 달 — 이번 달(KST) 기록이 있으면 그 달, 없으면 최근 달을 «이번 달 아님»으로", () => {
  const rows = [{ year: 2026, month: 9, id: "9" }, { year: 2026, month: 8, id: "8" }];
  // 11월인데 9월이 최신 → 이번 달 아님(제목을 «최근 장부 요약»으로 바꾼다)
  assert.deepEqual(pickMonthSummary(rows, "2026-11-09"), { row: rows[0], isThisMonth: false });
  // 9월이면 이번 달
  assert.deepEqual(pickMonthSummary(rows, "2026-09-30"), { row: rows[0], isThisMonth: true });
  // 최신이 아니어도 이번 달 기록이면 그 달
  assert.deepEqual(pickMonthSummary(rows, "2026-08-01"), { row: rows[1], isThisMonth: true });
  // 연도가 다르면 같은 월이라도 이번 달이 아니다
  assert.equal(pickMonthSummary(rows, "2027-09-01").isThisMonth, false);
  assert.equal(pickMonthSummary([], "2026-11-09"), null);
});

test("학생 상세는 이번 달을 KST 오늘로 고르고, 이번 달이 아니면 «이번 달» 라벨을 쓰지 않는다", () => {
  const detail = readFileSync("src/app/admin/students/[id]/StudentDetailClient.tsx", "utf8");
  assert.match(detail, /pickMonthSummary\(monthlyHistory, todayKst\(\)\)/);
  // 서버(UTC)·브라우저 시계에 따라 달이 바뀌는 옛 계산을 다시 쓰지 않는다
  assert.doesNotMatch(detail, /now\.getMonth\(\) \+ 1/);
  assert.match(detail, /isThisMonth \? "이번 달 요약" : "최근 장부 요약"/);
  assert.match(detail, /isThisMonth \? "이번 달 수납" : "최근 장부 수납"/);
  // 셔틀 «신청서 희망» 시각은 24시간 표기
  assert.match(detail, /const hopeTime = toHhmm\(hope\.preferredTime\)/);
  assert.doesNotMatch(detail, /\(\$\{currentMonthHistory\.shuttle\.preferredTime\}\)/);
});
