import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 정규 셔틀 «하나의 운행표» 1단계(2026-11-09) — 순수 조립 함수 buildRegularRunRows 추출.
// 기사님 화면은 **한 글자도** 바뀌면 안 된다(리팩터). 그래서 종전 서버 코드가 하던 조립을
// 이 테스트 안에 «기준(reference)»으로 그대로 옮겨 적고, 새 함수 결과와 통째로(deepEqual) 비교한다.
// 저장 노선이 있는 칸 · 없는 칸 · 노선에 없는 승객 칸 · 노선 학생이 명단에 없는 경우를 모두 본다.

const logic = await loadTsModule("src/lib/shuttle/regularDriverRouteLogic.ts");
const unified = await loadTsModule("src/lib/shuttle/unifiedDriverRunLogic.ts");
const { buildRegularRunRows, buildRegularRunClasses } = await loadTsModule("src/lib/shuttle/regularRunRows.ts");

// ── 종전 getRegularDriverClasses(2026-11-09 이전)의 조립 순서 그대로 ──────────────
function referenceClasses({ stops, weekday, isAbsent, absentLabelOf, saved, rowIdsByStudentId, exceptions, matches, describe }) {
  const dayRows = logic.selectDriverDayRows(stops, weekday);
  const classes = logic.assembleRegularDriverClasses({ dayRows, isAbsent, saved, rowIdsByStudentId });
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

const EMPTY = new Map();
function inputs({ saved, rowIdsByStudentId }) {
  const shared = { stops: STOPS, weekday: 4, isAbsent, absentLabelOf, saved, rowIdsByStudentId };
  return {
    // 종전 서버 코드의 인자 모양
    ref: { ...shared, exceptions, matches, describe },
    // 새 순수 함수의 인자 모양(서버 regularDriverRoute.ts 가 넘기는 것과 같은 모양)
    next: { ...shared, dayNotes: { exceptions, matches, describe } },
  };
}

function assertSame(label, { saved, rowIdsByStudentId }) {
  const { ref, next } = inputs({ saved, rowIdsByStudentId });
  const expectedClasses = referenceClasses(ref);
  // 섹션 단계 동일(기사님 서버 → buildUnifiedRun 으로 넘어가는 값)
  assert.deepEqual(buildRegularRunClasses(next), expectedClasses, `${label}: 섹션이 종전과 다르다`);
  // 카드 단계 동일(방학특강 없는 날 기사님 화면 목록 = buildUnifiedRun({ regular }))
  const expectedRows = unified.buildUnifiedRun({ seasonal: [], regular: expectedClasses });
  assert.deepEqual(buildRegularRunRows(next), expectedRows, `${label}: 카드 목록이 종전과 다르다`);
  return expectedRows;
}

test("저장 노선 없는 칸(명단 그대로) — 새 조립 결과가 종전 기사님 화면과 글자 그대로 같다", () => {
  const rows = assertSame("폴백", { saved: { PICKUP: null, DROPOFF: null }, rowIdsByStudentId: { PICKUP: EMPTY, DROPOFF: EMPTY } });
  // 내용도 확인: 시각순, 시간 미정(D빌라)은 맨 끝, 탑승 체크 키 = 명단 행 id, PIVOT·다른 요일·이름 없는 행 제외.
  assert.deepEqual(rows.map((r) => [r.label, r.time]), [
    ["A아파트 정문", "16:30"], ["B초 후문", "16:40"], ["C마을", "17:35"], ["A아파트 정문", "18:10"], ["C마을", "19:10"], ["D빌라", null],
  ]);
  assert.deepEqual(rows[0].riders.map((r) => r.checkId), ["r1", "r2"]);
  assert.equal(rows[0].riders[1].absent, true);
  assert.equal(rows[0].riders[1].absentLabel, "결석");
  assert.equal(rows.find((r) => r.time === "19:10").riders[0].shuttleNote, "오늘 셔틀 안 탐");
  assert.ok(rows.every((r) => r.pending && !r.warn));
  const ids = rows.flatMap((r) => r.riders.map((x) => x.checkId));
  for (const gone of ["p1", "x1", "n1"]) assert.ok(!ids.includes(gone), `${gone} 는 기사님 화면에 없어야 한다`);
});

test("저장 노선 있는 칸 + 노선에 없는 승객 칸 + 노선 학생이 명단에 없는 경우 — 종전과 같다", () => {
  // 등원만 저장 노선(하원은 명단 폴백). 노선엔 가나·마바·명단에없는학생, 명단의 다라·사아는 노선에 없음.
  const saved = {
    PICKUP: { vehicles: [{ vehicleName: "1호차", tripLabel: "1회차", stops: [
      { label: "B초 후문", etaLabel: "16:20 승차", lat: 37.62, lng: 127.16, students: [{ requestId: "stu-maba", name: "마바" }] },
      { label: "차고지", etaLabel: "16:00", students: [] },
      { label: "A아파트정문", etaManual: 995, students: [{ requestId: "stu-gana", name: "가나" }, { requestId: "stu-ghost", name: "유령", parentPhone: "010-9" }] },
    ] }] },
    DROPOFF: null,
  };
  const rowIdsByStudentId = {
    PICKUP: new Map([["stu-gana", ["r1"]], ["stu-maba", ["r3"]], ["stu-dara", ["r2"]], ["stu-saa", ["r4"]]]),
    DROPOFF: EMPTY,
  };
  const rows = assertSame("저장 노선", { saved, rowIdsByStudentId });

  const routeRows = rows.filter((r) => r.groupLabel === "🚐 1호차 · 1회차 · 등원");
  assert.deepEqual(routeRows.map((r) => [r.label, r.time]), [["B초 후문", "16:20"], ["A아파트정문", "16:35"]]);
  // 명단에 없는 노선 학생도 숨기지 않고 고정 대체키로 보인다.
  assert.deepEqual(routeRows[1].riders.map((r) => r.checkId), ["r1", "route:stu-ghost"]);
  // 노선에 안 실린 명단 행은 «노선에 없는 승객» 칸(warn)으로 뒤에 붙는다 — 아무도 사라지지 않는다.
  const leftover = rows.filter((r) => r.warn);
  assert.deepEqual(leftover.flatMap((r) => r.riders.map((x) => x.checkId)).sort(), ["r2", "r4"]);
  assert.ok(leftover.every((r) => r.groupLabel === "⚠️ 노선에 없는 승객 · 등원"));
  // 하원은 명단 폴백(수업시간 칸) 그대로.
  assert.deepEqual(rows.filter((r) => r.direction === "DROPOFF").map((r) => r.groupLabel), ["🕒 17:00~18:00 수업 · 하원", "🕒 18:00~19:00 수업 · 하원", "🕒 17:00~18:00 수업 · 하원"]);
});

test("등원·하원 둘 다 저장 노선 — 종전과 같다(하원 노선은 비어 있으면 폴백)", () => {
  const saved = {
    PICKUP: { vehicles: [{ vehicleName: "1호차", stops: [{ label: "A아파트 정문", etaLabel: "16:31", students: [{ requestId: "stu-gana" }, { requestId: "stu-dara" }] }] }] },
    DROPOFF: { vehicles: [{ vehicleName: "2호차", stops: [{ label: "C마을", etaLabel: "19:05", students: [{ requestId: "stu-saa" }] }, { label: "A아파트 정문", etaLabel: "18:12", students: [{ requestId: "stu-gana" }] }] }] },
  };
  const rowIdsByStudentId = {
    PICKUP: new Map([["stu-gana", ["r1"]], ["stu-dara", ["r2"]]]),
    DROPOFF: new Map([["stu-gana", ["r5"]], ["stu-saa", ["r7"]]]),
  };
  assertSame("양방향 저장 노선", { saved, rowIdsByStudentId });
  // 빈 저장본(학생 0명)은 폴백 — 이 판정도 종전과 같아야 한다.
  assertSame("빈 저장본", { saved: { PICKUP: { vehicles: [{ stops: [{ label: "x", students: [] }] }] }, DROPOFF: { vehicles: [] } }, rowIdsByStudentId: { PICKUP: EMPTY, DROPOFF: EMPTY } });
});

test("기본값(결석·저장 노선·오늘만 변경 끔) = 관리자 «월+요일» 기본형 — 종전 관리자 보기와 같은 묶음", () => {
  const NOT_ABSENT = () => false;
  // 관리자 「기사님 화면」 보기(DriverOrderView)가 쓰던 조립: buildFallbackClasses(selectDriverDayRows(stops, weekday), NOT_ABSENT)
  const adminClasses = logic.attachAbsenceLabels(logic.buildFallbackClasses(logic.selectDriverDayRows(STOPS, 4), NOT_ABSENT), () => null);
  assert.deepEqual(buildRegularRunClasses({ stops: STOPS, weekday: 4 }), adminClasses);
  assert.deepEqual(buildRegularRunRows({ stops: STOPS, weekday: 4 }), unified.buildUnifiedRun({ regular: adminClasses }));
  // 결석을 끄면 결석 표시가 없다.
  assert.ok(buildRegularRunRows({ stops: STOPS, weekday: 4 }).every((r) => r.riders.every((x) => !x.absent && !x.shuttleNote)));
  // 운행 없는 요일은 빈 목록.
  assert.deepEqual(buildRegularRunRows({ stops: STOPS, weekday: 0 }), []);
});

test("배선 가드 — 기사님 서버는 순수 조립 함수에 맡기고, 기사님 화면은 RunBoard(mode=driver)로 그린다", async () => {
  const route = await readFile("src/lib/shuttle/regularDriverRoute.ts", "utf8");
  assert.match(route, /import \{ buildRegularRunClasses \} from "\.\/regularRunRows"/);
  assert.match(route, /return buildRegularRunClasses\(\{/);
  // 서버가 조립을 따로 하면 관리자 운행표와 어긋난다 — 직접 호출 금지.
  assert.doesNotMatch(route, /assembleRegularDriverClasses\(|attachShuttleDayNotes\(|attachAbsenceLabels\(/);

  const pure = await readFile("src/lib/shuttle/regularRunRows.ts", "utf8");
  assert.doesNotMatch(pure, /from "@\/lib\/prisma"|from "react"|"use client"|"server-only"/, "순수 모듈이어야 한다(브라우저에서도 쓴다)");

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
