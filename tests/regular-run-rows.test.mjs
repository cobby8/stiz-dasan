import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 정규 셔틀 «하나의 운행표» — 순수 조립 함수 buildRegularRunRows(1단계 추출 · 5단계 명단 전용).
// 5단계(2026-11-09 원장 결정): 셔틀 명단이 유일한 운행 정본 — 저장 노선(RegularDispatchRoute)은 입력조차 없다.
// 기준(reference) = 명단 폴백 조립(buildFallbackClasses)에 «확정 전»(pending) 표시만 끈 것. 새 함수 결과와 통째로 비교한다.

const logic = await loadTsModule("src/lib/shuttle/regularDriverRouteLogic.ts");
const unified = await loadTsModule("src/lib/shuttle/unifiedDriverRunLogic.ts");
const { buildRegularRunRows, buildRegularRunClasses } = await loadTsModule("src/lib/shuttle/regularRunRows.ts");

// ── 기준 조립: 요일 고르기 → 명단 묶음(pending 끔) → 결석 뱃지 → «오늘만» 변경 ──────────────
function referenceClasses({ stops, weekday, isAbsent, absentLabelOf, exceptions, matches, describe }) {
  const dayRows = logic.selectDriverDayRows(stops, weekday);
  const classes = logic.buildFallbackClasses(dayRows, isAbsent).map((c) => ({ ...c, pending: false }));
  return logic.attachShuttleDayNotes(logic.attachAbsenceLabels(classes, absentLabelOf), exceptions, matches, describe);
}

// ── 픽스처: 목요일(4) 명단 — 두 수업 칸, 등원·하원, 다른 요일·PIVOT·이름 없는 행 섞음 ──
const base = { weekdayLabel: "목", studentPhone: null, note: null, serviceMonth: "2026-11" };
const row = (id, o) => ({ ...base, id, weekday: 4, latitude: 37.61, longitude: 127.15, parentPhone: `010-0000-${id.padStart(4, "0").slice(-4)}`, ...o });
const STOPS = [
  row("r1", { classTime: "17:00~18:00", arriveTime: "16:30", stopName: "A아파트 정문", direction: "BOARD", studentName: "가나", sortOrder: 1 }),
  row("r2", { classTime: "17:00~18:00", arriveTime: "16:30", stopName: "A아파트 정문", direction: "BOARD", studentName: "다라", sortOrder: 2 }),
  row("r3", { classTime: "17:00~18:00", arriveTime: "16:40", stopName: "B초 후문", direction: "BOARD", studentName: "마바", sortOrder: 3, latitude: null, longitude: null }),
  row("p1", { classTime: "17:00~18:00", arriveTime: "16:50", stopName: "학원", direction: "PIVOT", studentName: "", sortOrder: 4 }),
  row("r4", { classTime: "18:00~19:00", arriveTime: "17:35", stopName: "C마을", direction: "BOARD", studentName: "사아", sortOrder: 5 }),
  row("r5", { classTime: "17:00~18:00", arriveTime: "18:10", stopName: "A아파트 정문", direction: "ALIGHT", studentName: "가나", sortOrder: 6 }),
  row("r6", { classTime: "17:00~18:00", arriveTime: null, stopName: "D빌라", direction: "ALIGHT", studentName: "자차", sortOrder: 7 }),
  row("r7", { classTime: "18:00~19:00", arriveTime: "19:10", stopName: "C마을", direction: "ALIGHT", studentName: "사아", sortOrder: 8 }),
  row("x1", { classTime: "17:00~18:00", arriveTime: "16:30", stopName: "다른요일", direction: "BOARD", studentName: "카타", sortOrder: 1, weekday: 3 }),
  row("n1", { classTime: "17:00~18:00", arriveTime: "16:45", stopName: "이름없음", direction: "BOARD", studentName: "", sortOrder: 9 }),
];

// 결석·«오늘만» 변경(서버가 주입하는 것과 같은 모양 — 이름 매칭으로 단순화)
const ABSENT = new Set(["다라"]);
const isAbsent = (p) => ABSENT.has(p.name ?? "");
const absentLabelOf = (p) => (isAbsent(p) ? "결석" : null);
const exceptions = [{ name: "사아", phone: null, direction: "DROPOFF", kind: "SKIP", location: null }];
const matches = (r, entry) => r.name === entry.name;
const describe = (entry) => (entry.kind === "SKIP" ? "오늘 셔틀 안 탐" : `오늘 ${entry.location}`);

function inputs() {
  const shared = { stops: STOPS, weekday: 4, isAbsent, absentLabelOf };
  return {
    ref: { ...shared, exceptions, matches, describe },
    // 새 순수 함수의 인자 모양(서버 regularDriverRoute.ts 가 넘기는 것과 같은 모양)
    next: { ...shared, dayNotes: { exceptions, matches, describe } },
  };
}

test("명단 그대로 — 기사님 화면 조립 결과가 명단 순서·시각 그대로, «순서 확인 필요» 없음", () => {
  const { ref, next } = inputs();
  const expectedClasses = referenceClasses(ref);
  assert.deepEqual(buildRegularRunClasses(next), expectedClasses);
  const rows = buildRegularRunRows(next);
  assert.deepEqual(rows, unified.buildUnifiedRun({ seasonal: [], regular: expectedClasses }));
  // 내용도 확인: 시각순, 시간 미정(D빌라)은 맨 끝, 탑승 체크 키 = 명단 행 id, PIVOT·다른 요일·이름 없는 행 제외.
  assert.deepEqual(rows.map((r) => [r.label, r.time]), [
    ["A아파트 정문", "16:30"], ["B초 후문", "16:40"], ["C마을", "17:35"], ["A아파트 정문", "18:10"], ["C마을", "19:10"], ["D빌라", null],
  ]);
  assert.deepEqual(rows[0].riders.map((r) => r.checkId), ["r1", "r2"]);
  assert.equal(rows[0].riders[1].absent, true);
  assert.equal(rows[0].riders[1].absentLabel, "결석");
  assert.equal(rows.find((r) => r.time === "19:10").riders[0].shuttleNote, "오늘 셔틀 안 탐");
  // 명단이 정본이라 «임시 순서·확정 전»도, «노선에 없는 승객»도 없다.
  assert.ok(rows.every((r) => !r.pending && !r.warn));
  assert.deepEqual([...new Set(rows.map((r) => r.groupLabel))].sort(), ["🕒 17:00~18:00 수업", "🕒 18:00~19:00 수업"]);
  const ids = rows.flatMap((r) => r.riders.map((x) => x.checkId));
  for (const gone of ["p1", "x1", "n1"]) assert.ok(!ids.includes(gone), `${gone} 는 기사님 화면에 없어야 한다`);
});

test("저장 노선을 넘겨도 무시한다(입력 자체가 없음) — 명단을 고치면 기사님 화면이 바로 바뀐다", () => {
  const { next } = inputs();
  const withSaved = { ...next, saved: { PICKUP: { vehicles: [{ vehicleName: "1호차", stops: [{ label: "B초 후문", etaLabel: "16:20", students: [{ requestId: "stu-maba" }] }] }] }, DROPOFF: null } };
  assert.deepEqual(buildRegularRunRows(withSaved), buildRegularRunRows(next));
  // 명단의 시각·순서를 바꾸면 그대로 반영된다(예전엔 저장 노선 요일은 안 바뀌었다).
  const edited = STOPS.map((s) => (s.id === "r3" ? { ...s, arriveTime: "16:20", sortOrder: 0 } : s));
  const rows = buildRegularRunRows({ ...next, stops: edited });
  assert.deepEqual(rows.slice(0, 2).map((r) => [r.label, r.time]), [["B초 후문", "16:20"], ["A아파트 정문", "16:30"]]);
});

test("기본값(결석·오늘만 변경 끔) = 관리자 «월+요일» 기본형 — 기사님 화면과 같은 카드(결석 표시만 없음)", () => {
  const NOT_ABSENT = () => false;
  const adminClasses = logic.attachAbsenceLabels(logic.buildFallbackClasses(logic.selectDriverDayRows(STOPS, 4), NOT_ABSENT).map((c) => ({ ...c, pending: false })), () => null);
  assert.deepEqual(buildRegularRunClasses({ stops: STOPS, weekday: 4 }), adminClasses);
  assert.deepEqual(buildRegularRunRows({ stops: STOPS, weekday: 4 }), unified.buildUnifiedRun({ regular: adminClasses }));
  // 관리자 화면 = 기사님 화면: 결석·오늘만 변경 표시를 빼면 카드 순서·시각·묶음·탑승 키가 같다.
  const strip = (rows) => rows.map((r) => ({ ...r, riders: r.riders.map((x) => ({ ...x, absent: false, absentLabel: null, shuttleNote: null })) }));
  assert.deepEqual(strip(buildRegularRunRows({ stops: STOPS, weekday: 4 })), strip(buildRegularRunRows(inputs().next)));
  // 결석을 끄면 결석 표시가 없다.
  assert.ok(buildRegularRunRows({ stops: STOPS, weekday: 4 }).every((r) => r.riders.every((x) => !x.absent && !x.shuttleNote)));
  // 운행 없는 요일은 빈 목록.
  assert.deepEqual(buildRegularRunRows({ stops: STOPS, weekday: 0 }), []);
});

test("배선 가드 — 기사님 서버는 순수 조립 함수에 맡기고, 기사님 화면은 RunBoard(mode=driver)로 그린다", async () => {
  const route = await readFile("src/lib/shuttle/regularDriverRoute.ts", "utf8");
  assert.match(route, /import \{ buildRegularRunClasses \} from "\.\/regularRunRows"/);
  assert.match(route, /= buildRegularRunClasses\(\{/); // 2026-11-14: 휴무 안내와 함께 돌려주려고 변수에 담는다
  // 서버가 조립을 따로 하면 관리자 운행표와 어긋난다 — 직접 호출 금지.
  assert.doesNotMatch(route, /assembleRegularDriverClasses\(|attachShuttleDayNotes\(|attachAbsenceLabels\(/);
  // 5단계: 저장 노선을 읽지 않는다(명단만).
  assert.doesNotMatch(route, /getSavedRegularDispatchRoute|regularDispatchRoute"|rowIdsByStudentId|getRegularShuttleRiders/);

  const pure = await readFile("src/lib/shuttle/regularRunRows.ts", "utf8");
  assert.doesNotMatch(pure, /from "@\/lib\/prisma"|from "react"|"use client"|"server-only"/, "순수 모듈이어야 한다(브라우저에서도 쓴다)");
  assert.doesNotMatch(pure, /assembleRegularDriverClasses|saved\?:|rowIdsByStudentId/, "저장 노선 입력은 없앴다(5단계)");

  const client = await readFile("src/components/shuttle/UnifiedDriverClient.tsx", "utf8");
  assert.match(client, /import RunBoard from "@\/components\/shuttle\/run\/RunBoard"/);
  assert.match(client, /<RunBoard[\s\S]*mode="driver"[\s\S]*renderRider=\{renderRider\}/);
  // 카드 목록을 화면 안에 다시 그리지 않는다(사본 금지).
  assert.doesNotMatch(client, /<ol className="space-y-2\.5">/);
  assert.doesNotMatch(client, /tmapNavigationCoordinateUrl/);

  const board = await readFile("src/components/shuttle/run/RunBoard.tsx", "utf8");
  // 카드 틀은 탑승 저장 API 를 모른다(그건 기사님 화면 renderRider 의 일).
  assert.doesNotMatch(board, /\/api\/shuttle/);
  assert.match(board, /export type RunBoardMode = "driver" \| "admin"/);
});
