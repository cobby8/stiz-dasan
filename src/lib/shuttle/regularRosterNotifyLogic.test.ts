import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error -- Node's type-stripping runner needs the runtime extension.
import { buildRosterChangeNotice, changeCellsLabel, nextRunDateInMonth, normalizeChangeCells, ROSTER_NOTICE_BUNDLE_MS, rosterChangeLink } from "./regularRosterNotifyLogic.ts";

// 명단 변경 기사님 알림(D5) — 다음 운행일(월말·연말·오늘 포함)·링크·묶음 키.

test("다음 운행일: 오늘 포함, 그 달 안에서만, 미래 달은 1일부터 · 지난 달은 null", () => {
  // 2026-11-09 는 월요일
  assert.equal(nextRunDateInMonth("2026-11", 1, "2026-11-09"), "2026-11-09");
  assert.equal(nextRunDateInMonth("2026-11", 4, "2026-11-09"), "2026-11-12");
  assert.equal(nextRunDateInMonth("2026-11", 0, "2026-11-09"), "2026-11-15");
  // 월말: 11/30(월) 이후 목요일은 12월이라 11월 명단 변경으로는 null
  assert.equal(nextRunDateInMonth("2026-11", 4, "2026-11-30"), null);
  assert.equal(nextRunDateInMonth("2026-11", 1, "2026-11-30"), "2026-11-30");
  // 미래 달: 12월 1일(화)부터
  assert.equal(nextRunDateInMonth("2026-12", 2, "2026-11-20"), "2026-12-01");
  assert.equal(nextRunDateInMonth("2026-12", 1, "2026-11-20"), "2026-12-07");
  // 연말 → 다음 해 1월
  assert.equal(nextRunDateInMonth("2027-01", 1, "2026-12-31"), "2027-01-04");
  // 지난 달·잘못된 입력
  assert.equal(nextRunDateInMonth("2026-10", 1, "2026-11-09"), null);
  assert.equal(nextRunDateInMonth("2026-11", 7, "2026-11-09"), null);
  assert.equal(nextRunDateInMonth("bad", 1, "2026-11-09"), null);
});

test("칸 정리·문구·링크", () => {
  const cells = normalizeChangeCells([{ weekday: 3, direction: "ALIGHT" }, { weekday: 1, direction: "BOARD" }, { weekday: 3, direction: "ALIGHT" }, { weekday: 2, direction: "PIVOT" }, { weekday: 0, direction: "BOARD" }]);
  assert.deepEqual(cells, [{ weekday: 1, direction: "BOARD" }, { weekday: 3, direction: "ALIGHT" }, { weekday: 0, direction: "BOARD" }]);
  assert.equal(changeCellsLabel(cells), "월 등원·수 하원·일 등원");
  assert.equal(rosterChangeLink("2026-11-12", "BOARD"), "/staff/run?date=2026-11-12&focus=BOARD");
  assert.equal(rosterChangeLink(null, null), "/staff/run");
});

test("알림: 가장 빠른 다음 운행일 칸으로 링크, 같은 칸 10분 안 변경은 같은 키(묶음), 칸이 없으면 null", () => {
  const now = Date.UTC(2026, 10, 9, 5, 0, 0); // KST 14:00
  const n = buildRosterChangeNotice({ month: "2026-11", cells: [{ weekday: 4, direction: "BOARD" }, { weekday: 2, direction: "ALIGHT" }], summary: "허재원 학생 정류장 변경", todayYmd: "2026-11-09", nowMs: now });
  assert.ok(n);
  assert.equal(n.title, "셔틀 명단 변경 · 화 하원·목 등원");
  assert.match(n.message, /^11월 화 하원·목 등원 — 허재원 학생 정류장 변경\./);
  assert.equal(n.linkUrl, "/staff/run?date=2026-11-10&focus=ALIGHT"); // 화 11/10 이 목 11/12 보다 먼저
  const same = buildRosterChangeNotice({ month: "2026-11", cells: [{ weekday: 2, direction: "ALIGHT" }, { weekday: 4, direction: "BOARD" }], summary: "다른 변경", todayYmd: "2026-11-09", nowMs: now + 60_000 });
  assert.equal(same!.stableEventKey, n.stableEventKey);
  const later = buildRosterChangeNotice({ month: "2026-11", cells: [{ weekday: 2, direction: "ALIGHT" }, { weekday: 4, direction: "BOARD" }], summary: "x", todayYmd: "2026-11-09", nowMs: now + ROSTER_NOTICE_BUNDLE_MS });
  assert.notEqual(later!.stableEventKey, n.stableEventKey);
  assert.equal(buildRosterChangeNotice({ month: "2026-11", cells: [], summary: "x", todayYmd: "2026-11-09", nowMs: now }), null);
});
