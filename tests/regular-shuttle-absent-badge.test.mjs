import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { absenceBadgeLabel, matchAbsentee } from "../src/lib/regular/regularAbsenceMatch.ts";
import { assembleRegularDriverClasses, attachAbsenceLabels } from "../src/lib/shuttle/regularDriverRouteLogic.ts";
import {
  buildUnifiedRun,
  countProgress,
  riderBoardingView,
  riderDefaultStatus,
  stopAbsenceSummary,
} from "../src/lib/shuttle/unifiedDriverRunLogic.ts";

// 원장 지시(2026-11-09): «질병·부상 결석 아이를 기사님 셔틀 명단에서 빼지 말고 결석 뱃지가 잘 보이게».
// 결석 학생(학부모 신고·출석부 질병·부상 모두)은 명단에 그대로 남고, «결석·질병» 같은 뱃지 + 흐린 행 +
// 기본 상태 «결석»으로 보인다. 탑승 버튼은 그대로 누를 수 있다(실제로 탔으면 체크).

function sheetRow(id, name, { direction = "BOARD", stopName = "푸르지오 정문", classTime = "17:00", sortOrder = 0, parentPhone = "010-1111-2222" } = {}) {
  return { id, weekday: 1, direction, studentName: name, stopName, arriveTime: "16:40", classTime, sortOrder, parentPhone, studentPhone: null, latitude: 37.6, longitude: 127.1 };
}

test("결석 뱃지 문구 — 사유를 짧게 붙이고, 모르는 사유는 «결석»", () => {
  assert.equal(absenceBadgeLabel("ILLNESS_INJURY"), "결석·질병");
  assert.equal(absenceBadgeLabel("PERSONAL"), "결석·개인사정");
  assert.equal(absenceBadgeLabel("FAMILY_TRIP"), "결석·가족여행");
  assert.equal(absenceBadgeLabel("SCHOOL_EVENT"), "결석·학교행사");
  assert.equal(absenceBadgeLabel("ETC"), "결석");
  assert.equal(absenceBadgeLabel(null), "결석");
  assert.equal(absenceBadgeLabel(undefined), "결석");
});

test("매칭 결과에 사유가 그대로 실려 온다(뱃지 문구 근거)", () => {
  const hit = matchAbsentee({ name: "김 하늘", phone: "010-1111-2222" }, [{ name: "김하늘", phone: "01011112222", reason: "ILLNESS_INJURY" }]);
  assert.equal(hit?.reason, "ILLNESS_INJURY");
});

test("결석 학생은 기사님 명단에서 빠지지 않고 순서 그대로 남는다 — 뱃지 문구가 붙는다", () => {
  const dayRows = [sheetRow("r1", "가나", { sortOrder: 0 }), sheetRow("r2", "다라", { sortOrder: 1 }), sheetRow("r3", "마바", { sortOrder: 2, stopName: "학원 앞" })];
  const absentees = [{ name: "다라", phone: "010-1111-2222", reason: "ILLNESS_INJURY" }];
  const isAbsent = (p) => matchAbsentee(p, absentees) !== null;
  const classes = assembleRegularDriverClasses({
    dayRows, isAbsent, saved: { PICKUP: null, DROPOFF: null }, rowIdsByStudentId: { PICKUP: new Map(), DROPOFF: new Map() },
  });
  const labeled = attachAbsenceLabels(classes, (p) => {
    const hit = matchAbsentee(p, absentees);
    return hit ? absenceBadgeLabel(hit.reason) : null;
  });
  const rows = labeled.flatMap((c) => c.board.flatMap((s) => s.rows));
  assert.deepEqual(rows.map((r) => r.name), ["가나", "다라", "마바"], "결석 학생도 명단 순서 그대로");
  assert.equal(rows[1].absent, true);
  assert.equal(rows[1].absentLabel, "결석·질병");
  assert.equal(rows[0].absentLabel, undefined, "결석 아닌 학생엔 뱃지 문구를 붙이지 않는다");
});

test("매칭 문구를 못 찾아도 결석 행은 «결석» 기본 문구", () => {
  const classes = [{ classTime: "17:00", board: [{ label: "A", arriveTime: null, lat: null, lng: null, direction: "BOARD", rows: [{ rowId: "r1", name: "가", parentPhone: null, studentPhone: null, absent: true }] }], alight: [] }];
  assert.equal(attachAbsenceLabels(classes, () => null)[0].board[0].rows[0].absentLabel, "결석");
});

test("기사님 통합 행까지 결석 표시·뱃지 문구가 이어진다", () => {
  const rows = buildUnifiedRun({ regular: [{ classTime: "17:00", board: [{ label: "A", arriveTime: "16:40", lat: null, lng: null, direction: "BOARD", rows: [
    { rowId: "r1", name: "가", parentPhone: null, studentPhone: null, absent: true, absentLabel: "결석·질병" },
    { rowId: "r2", name: "나", parentPhone: null, studentPhone: null },
  ] }], alight: [] }] });
  assert.equal(rows[0].riders.length, 2, "결석 학생이 행에서 사라지지 않는다");
  assert.equal(rows[0].riders[0].absentLabel, "결석·질병");
  assert.equal(rows[0].riders[1].absentLabel, null);
});

test("탑승자 화면 상태 — 정규 결석은 기본 «결석», 탑승을 누르면 흐림이 풀린다", () => {
  const absent = { kind: "REGULAR", absent: true };
  assert.deepEqual(riderBoardingView(absent, undefined), { absentReported: true, status: "NOSHOW", absentDefault: true, dimmed: true });
  assert.deepEqual(riderBoardingView(absent, "BOARDED"), { absentReported: true, status: "BOARDED", absentDefault: false, dimmed: false });
  assert.deepEqual(riderBoardingView(absent, "SELF"), { absentReported: true, status: "SELF", absentDefault: false, dimmed: false });
  assert.deepEqual(riderBoardingView(absent, "NOSHOW"), { absentReported: true, status: "NOSHOW", absentDefault: false, dimmed: true });
  // 결석 아닌 학생·특강 «결석예정»은 종전대로(기본 상태 없음 = 체크 대기)
  assert.deepEqual(riderBoardingView({ kind: "REGULAR", absent: false }, null), { absentReported: false, status: null, absentDefault: false, dimmed: false });
  assert.deepEqual(riderBoardingView({ kind: "SEASONAL", absent: true }, null), { absentReported: false, status: null, absentDefault: false, dimmed: false });
  assert.equal(riderDefaultStatus(absent), "NOSHOW");
  assert.equal(riderDefaultStatus({ kind: "SEASONAL", absent: true }), null);
});

test("정차 결석 요약 — 결석 수, 전원 결석이면 «정차 안 해도 됨», 한 명이라도 탔으면 아님", () => {
  const r = (key, absent, kind = "REGULAR") => ({ key, checkId: key, kind, direction: "PICKUP", name: key, grade: null, parentPhone: null, studentPhone: null, absent });
  assert.deepEqual(stopAbsenceSummary([r("a", true), r("b", true)], {}), { absentCount: 2, allSkippable: true });
  assert.deepEqual(stopAbsenceSummary([r("a", true), r("a", true)], {}), { absentCount: 1, allSkippable: true }, "같은 학생 중복은 1명");
  assert.deepEqual(stopAbsenceSummary([r("a", true), r("b", false)], {}), { absentCount: 1, allSkippable: false });
  assert.deepEqual(stopAbsenceSummary([r("a", true), r("b", true)], { b: "BOARDED" }), { absentCount: 2, allSkippable: false });
  assert.deepEqual(stopAbsenceSummary([r("a", true, "SEASONAL")], {}), { absentCount: 0, allSkippable: false });
  assert.deepEqual(stopAbsenceSummary([], {}), { absentCount: 0, allSkippable: false });
});

test("진행률 — 결석 학생은 분모에 남고 기록이 없으면 «결석»으로 센다", () => {
  const rows = buildUnifiedRun({ regular: [{ classTime: "17:00", board: [{ label: "A", arriveTime: "16:40", lat: null, lng: null, direction: "BOARD", rows: [
    { rowId: "r1", name: "가", parentPhone: null, studentPhone: null, absent: true },
    { rowId: "r2", name: "나", parentPhone: null, studentPhone: null, absent: true },
    { rowId: "r3", name: "다", parentPhone: null, studentPhone: null },
  ] }], alight: [] }] });
  assert.deepEqual(countProgress(rows, { "R:r2": "BOARDED" }), { total: 3, boarded: 1, noshow: 1, self: 0 });
});

test("화면 가드 — 결석 학생도 탑승 버튼·연락처가 보이고, 결석 뱃지는 12px 이상 + CSS 변수 색", async () => {
  const src = await readFile("src/components/shuttle/UnifiedDriverClient.tsx", "utf8");
  assert.doesNotMatch(src, /lockedAbsent/, "결석 학생을 잠그는(버튼 숨김) 옛 분기가 남아 있으면 안 된다");
  assert.doesNotMatch(src, /line-through/, "이름에 취소선을 긋지 않는다(흐리게만)");
  assert.doesNotMatch(src, /사전 결석 · 체크 대상 없음/);
  assert.match(src, /const status = boarding\[rider\.key\] \?\? riderDefaultStatus\(rider\);/);
  assert.match(src, /riderBoardingView\(rider, stored\)/);
  assert.match(src, /stopAbsenceSummary\(row\.riders, boarding\)/);
  assert.match(src, /정차 안 해도 됨/);
  // 뱃지: 진한 위험색 바탕 + on-primary 글자, 14px, 아이콘은 Material Symbols
  assert.match(src, /bg-\[var\(--color-academy-danger\)\] px-2 py-0\.5 text-\[14px\] font-black text-\[var\(--color-academy-on-primary\)\]">\s*<span aria-hidden="true" className="material-symbols-outlined[^"]*">event_busy<\/span>\{rider\.absentLabel \|\| "오늘 결석"\}/);
  // 버튼 묶음이 결석 조건으로 감싸이지 않는다
  assert.doesNotMatch(src, /\? \(\s*<span[^>]*>미\{isPickup/);
});

test("서버 조회가 결석 사유를 함께 읽는다(뱃지 문구) — 결석 학생을 걸러내는 조건은 없다", async () => {
  const run = await readFile("src/lib/shuttle/regularRun.ts", "utf8");
  assert.match(run, /ra\."reason" AS "reason"/);
  assert.match(run, /ra\."status" IN \('REPORTED','CONFIRMED'\)/);
  const route = await readFile("src/lib/shuttle/regularDriverRoute.ts", "utf8");
  assert.match(route, /attachAbsenceLabels\(classes, absentLabelOf\)/);
  assert.match(route, /absenceBadgeLabel\(hit\.reason\)/);
});
