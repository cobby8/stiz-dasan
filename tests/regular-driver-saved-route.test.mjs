import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  assembleRegularDriverClasses,
  buildSavedDriverSections,
  buildFallbackClasses,
  pickRegularRouteSource,
  savedStopTimeLabel,
} from "../src/lib/shuttle/regularDriverRouteLogic.ts";

// 정규 셔틀 기사님 화면이 "원장이 저장한 배차 노선"을 우선 쓰고, 없으면 시트 명단으로 폴백하는지,
// 그리고 무엇보다 **탑승 체크 키(시트 정차행 id)가 그대로 유지되는지**를 못박는다.

const noAbsent = () => false;

// 시트 행 헬퍼 — RegularShuttleStop 모양(필요한 필드만).
function sheet(id, { dir = "BOARD", name, stop, ct = "17:00~18:00", at = "16:30", order = 0, lat = 37.6, lng = 127.1 } = {}) {
  return {
    id, weekday: 1, weekdayLabel: "월", classTime: ct, arriveTime: at, stopName: stop,
    direction: dir, studentName: name, studentPhone: null, parentPhone: "010-0000-0000",
    note: null, sortOrder: order, latitude: lat, longitude: lng,
  };
}

test("저장 노선이 비어 있으면 폴백 — 기사님 화면이 비지 않는다", () => {
  assert.equal(pickRegularRouteSource(null), "FALLBACK");
  assert.equal(pickRegularRouteSource({}), "FALLBACK");
  assert.equal(pickRegularRouteSource({ vehicles: [] }), "FALLBACK");
  assert.equal(pickRegularRouteSource({ vehicles: [{ stops: [] }] }), "FALLBACK");
  assert.equal(pickRegularRouteSource({ vehicles: [{ stops: [{ label: "A", students: [] }] }] }), "FALLBACK");
  assert.equal(pickRegularRouteSource({ vehicles: [{ stops: [{ label: "A", students: [{ requestId: "s1" }] }] }] }), "SAVED");
});

test("저장 노선의 학생은 시트 정차행 id로 되돌려 탑승 체크 기록이 끊기지 않는다", () => {
  const rows = [
    sheet("row-a", { name: "김하준", stop: "다산푸르지오 정문", order: 0 }),
    sheet("row-b", { name: "이서준", stop: "롯데캐슬 정문", order: 1 }),
  ];
  const { sections, leftoverRows } = buildSavedDriverSections({
    // 원장이 순서를 뒤집어 저장한 노선(이서준 → 김하준)
    vehicles: [{
      vehicleName: "1호차", tripLabel: "1회차",
      stops: [
        { label: "롯데캐슬 정문", lat: 37.61, lng: 127.15, etaLabel: "16:20 승차", students: [{ requestId: "student-2", name: "이서준" }] },
        { label: "다산푸르지오 정문", lat: 37.62, lng: 127.16, etaMinutes: 16 * 60 + 35, students: [{ requestId: "student-1", name: "김하준" }] },
      ],
    }],
    direction: "PICKUP",
    rowIdsByStudentId: new Map([["student-1", ["row-a"]], ["student-2", ["row-b"]]]),
    sheetRows: rows,
    isAbsent: noAbsent,
  });

  assert.equal(sections.length, 1);
  const stops = sections[0].board;
  assert.deepEqual(stops.map((s) => s.label), ["롯데캐슬 정문", "다산푸르지오 정문"]);
  // 탑승 체크 키 = 시트 정차행 id (studentId 가 아니다)
  assert.deepEqual(stops.map((s) => s.rows[0].rowId), ["row-b", "row-a"]);
  assert.deepEqual(stops.map((s) => s.arriveTime), ["16:20", "16:35"]);
  assert.equal(sections[0].pending, false);
  assert.equal(leftoverRows.length, 0);
});

test("같은 학생이 시트에 여러 행이면 정류장 이름이 같은 행을 먼저 소비한다(행이 뒤바뀌지 않음)", () => {
  const rows = [
    sheet("row-1", { name: "박주원", stop: "별빛초등학교 후문", at: "14:40", order: 0 }),
    sheet("row-2", { name: "박주원", stop: "1호점 앞 버스정류장", at: "14:55", order: 1 }),
  ];
  const { sections, leftoverRows } = buildSavedDriverSections({
    vehicles: [{
      vehicleName: "1호차",
      stops: [
        // 노선 순서상 '1호점'이 먼저지만, 이름이 일치하는 row-2 를 골라야 한다.
        { label: "1호점 앞 버스정류장", students: [{ requestId: "s-park" }] },
        { label: "별빛초등학교 후문", students: [{ requestId: "s-park" }] },
      ],
    }],
    direction: "PICKUP",
    rowIdsByStudentId: new Map([["s-park", ["row-1", "row-2"]]]),
    sheetRows: rows,
    isAbsent: noAbsent,
  });
  assert.deepEqual(sections[0].board.map((s) => s.rows[0].rowId), ["row-2", "row-1"]);
  assert.equal(leftoverRows.length, 0);
});

test("저장 노선에 안 실린 시트 승객은 사라지지 않고 '노선에 없는 승객'으로 남는다", () => {
  const rows = [
    sheet("row-a", { name: "김하준", stop: "다산푸르지오 정문", order: 0 }),
    sheet("row-b", { name: "이서준", stop: "롯데캐슬 정문", order: 1 }),
  ];
  const classes = assembleRegularDriverClasses({
    dayRows: rows,
    isAbsent: noAbsent,
    saved: {
      PICKUP: { vehicles: [{ vehicleName: "1호차", stops: [{ label: "다산푸르지오 정문", students: [{ requestId: "student-1" }] }] }] },
      DROPOFF: null,
    },
    rowIdsByStudentId: { PICKUP: new Map([["student-1", ["row-a"]], ["student-2", ["row-b"]]]), DROPOFF: new Map() },
  });
  const allRowIds = classes.flatMap((c) => [...c.board, ...c.alight]).flatMap((s) => s.rows.map((r) => r.rowId));
  assert.ok(allRowIds.includes("row-a"));
  assert.ok(allRowIds.includes("row-b"), "노선에 없는 승객도 화면에 남아야 한다");
  const leftover = classes.find((c) => c.classTime === "PICKUP#leftover");
  assert.ok(leftover, "노선 미반영 섹션이 있어야 한다");
  assert.equal(leftover.pending, true);
});

test("시트 행을 못 찾은 저장 노선 학생도 숨기지 않고 고정 키로 표시한다", () => {
  const { sections } = buildSavedDriverSections({
    vehicles: [{ vehicleName: "1호차", stops: [{ label: "어딘가", students: [{ requestId: "ghost", name: "유령" }] }] }],
    direction: "PICKUP",
    rowIdsByStudentId: new Map(),
    sheetRows: [],
    isAbsent: noAbsent,
  });
  assert.equal(sections[0].board[0].rows[0].rowId, "route:ghost");
  assert.equal(sections[0].board[0].rows[0].name, "유령");
});

test("두 방향 모두 저장본이 없으면 종전 화면 그대로(수업시간별 등원+하원) + 확정 전 표시", () => {
  const rows = [
    sheet("row-a", { name: "김하준", stop: "다산푸르지오 정문", order: 0 }),
    sheet("row-c", { dir: "ALIGHT", name: "김하준", stop: "다산푸르지오 정문", at: "18:05", order: 2 }),
  ];
  const classes = assembleRegularDriverClasses({
    dayRows: rows,
    isAbsent: noAbsent,
    saved: { PICKUP: null, DROPOFF: null },
    rowIdsByStudentId: { PICKUP: new Map(), DROPOFF: new Map() },
  });
  assert.deepEqual(classes, buildFallbackClasses(rows, noAbsent));
  assert.equal(classes.length, 1);
  assert.equal(classes[0].classTime, "17:00~18:00");
  assert.equal(classes[0].pending, true);
  assert.equal(classes[0].board[0].rows[0].rowId, "row-a");
  assert.equal(classes[0].alight[0].rows[0].rowId, "row-c");
});

test("결석자는 저장 노선을 써도 그대로 결석 표시된다", () => {
  const rows = [sheet("row-a", { name: "김하준", stop: "다산푸르지오 정문", order: 0 })];
  const isAbsent = (p) => p.name === "김하준";
  const { sections } = buildSavedDriverSections({
    vehicles: [{ vehicleName: "1호차", stops: [{ label: "다산푸르지오 정문", students: [{ requestId: "student-1" }] }] }],
    direction: "PICKUP",
    rowIdsByStudentId: new Map([["student-1", ["row-a"]]]),
    sheetRows: rows,
    isAbsent,
  });
  assert.equal(sections[0].board[0].rows[0].absent, true);
});

test("확정 시각 라벨은 수동확정 → 자동값 순으로 HH:MM 을 뽑는다", () => {
  assert.equal(savedStopTimeLabel({ etaLabel: "8:53 승차" }), "08:53");
  assert.equal(savedStopTimeLabel({ etaManual: 9 * 60 + 5, etaMinutes: 100 }), "09:05");
  assert.equal(savedStopTimeLabel({ etaMinutes: 16 * 60 }), "16:00");
  assert.equal(savedStopTimeLabel({}), null);
});

test("기사님 화면이 저장 노선 게이트웨이를 쓰고, 탑승 체크 경로는 그대로다", async () => {
  // 기사님 화면 3개 진입점은 통합 화면 하나로 위임한다(같은 화면을 세 벌 유지하지 않는다).
  for (const page of [
    "src/app/driver/[token]/page.tsx",
    "src/app/shuttle/regular/[token]/page.tsx",
    "src/app/shuttle/run/[token]/page.tsx",
  ]) {
    const src = await readFile(page, "utf8");
    assert.match(src, /UnifiedDriverRunPage/);
  }
  // 그날 무엇을 띄울지는 게이트웨이 한곳에서만 만든다.
  const loader = await readFile("src/lib/shuttle/unifiedDriverRun.ts", "utf8");
  assert.match(loader, /getRegularDriverClasses/);
  // 조회 실패를 빈 미체크로 숨기지 않는 공통 reader로 이미 전환되었다.
  assert.match(loader, /readDriverBoarding\(viewDate, "REGULAR"\)/);
  assert.match(loader, /boardingReliable = reads\.every\(\(read\) => read\.status === "fulfilled"\)/);
  // 화면이 시트 명단을 직접 정렬해 그리던 옛 경로는 남아 있으면 안 된다(중복 판정 방지).
  assert.doesNotMatch(loader, /groupDriverStops/);
  const runSrc = await readFile("src/lib/shuttle/regularRun.ts", "utf8");
  assert.match(runSrc, /"shuttleRequestId"/);
  assert.match(runSrc, /REGULAR_DIR = "REGULAR"/);
});
