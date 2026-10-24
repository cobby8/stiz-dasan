import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildFallbackClasses, selectDriverDayRows } from "../src/lib/shuttle/regularDriverRouteLogic.ts";
import { buildReorderUpdates } from "../src/lib/shuttle/regularRosterEditLogic.ts";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const view = read("src/app/admin/shuttle/regular/DriverOrderView.tsx");
const client = read("src/app/admin/shuttle/regular/RegularShuttleClient.tsx");
const driverRoute = read("src/lib/shuttle/regularDriverRoute.ts");

// 원장 결정(2026-10-02): 「셔틀 명단」 = 기사님 화면. 관리자가 보는 운행 순서가 기사님 화면과 어긋나면 안 된다.
// → 관리자 「기사님 화면」 보기는 기사님 화면과 **같은 순수 함수**를 써야 한다(별도 묶음 로직 금지).
test("관리자 기사님 화면 보기는 기사님 화면과 같은 순수 함수로 만든다", () => {
  assert.match(view, /import \{[^}]*buildFallbackClasses[^}]*\} from "@\/lib\/shuttle\/regularDriverRouteLogic"/);
  assert.match(view, /import \{[^}]*selectDriverDayRows[^}]*\} from "@\/lib\/shuttle\/regularDriverRouteLogic"/);
  assert.match(view, /buildFallbackClasses\(selectDriverDayRows\(stops, weekday\), NOT_ABSENT\)/);
  // 자체 정류장 묶음 함수를 새로 만들지 않는다(RegularRouteSection 의 groupStops 같은 사본 금지).
  assert.doesNotMatch(view, /function group\w*\(/);
  // 기사님 화면 서버도 같은 요일 행 선택 함수를 쓴다.
  assert.match(driverRoute, /selectDriverDayRows\(stops, weekday\)/);
  // 셔틀 명단 화면에 보기 전환이 붙어 있다.
  assert.match(client, /<DriverOrderView/);
  assert.match(client, /기사님 화면\(운행 순서\)/);
});

test("기사님 화면 보기 저장은 regular-roster reorder 액션으로 간다", () => {
  assert.match(view, /action: "reorder"/);
  assert.match(view, /\/api\/admin\/shuttle\/regular-roster/);
  assert.match(view, /● 저장 안 됨/);
  const route = read("src/app/api/admin/shuttle/regular-roster/route.ts");
  assert.match(route, /b\.action === "reorder"/);
  const lib = read("src/lib/shuttle/regularRosterEdit.ts");
  assert.match(lib, /export async function reorderRosterStops[\s\S]{0,200}await requireAdmin\(\)/);
  assert.match(lib, /"REGULAR_ROSTER_REORDER"/);
});

// 실제 왕복: 기사님 화면 순서를 바꿔 저장 → 같은 함수로 다시 그리면 바뀐 순서가 그대로 나온다.
test("순서 저장 결과를 기사님 화면 함수로 다시 그리면 바뀐 정차 순서·시각이 나온다", () => {
  const base = { weekdayLabel: "수", studentPhone: null, parentPhone: null, note: null, latitude: null, longitude: null, serviceMonth: "2026-10" };
  const rows = [
    { ...base, id: "a", weekday: 3, classTime: "17:00~18:00", arriveTime: "16:30", stopName: "A동", direction: "BOARD", studentName: "가", sortOrder: 1 },
    { ...base, id: "x", weekday: 3, classTime: "18:00~19:00", arriveTime: "17:30", stopName: "X동", direction: "BOARD", studentName: "다른반", sortOrder: 2 },
    { ...base, id: "b", weekday: 3, classTime: "17:00~18:00", arriveTime: "16:40", stopName: "B동", direction: "BOARD", studentName: "나", sortOrder: 3 },
    { ...base, id: "b2", weekday: 3, classTime: "17:00~18:00", arriveTime: "16:40", stopName: "B동", direction: "BOARD", studentName: "다", sortOrder: 4 },
  ];
  const before = buildFallbackClasses(selectDriverDayRows(rows, 3), () => false);
  assert.deepEqual(before[0].board.map((s) => s.label), ["A동", "B동"]);

  // 관리자 화면이 보내는 것과 같은 모양: B동(두 학생) → A동, 시각도 바꿈.
  const [bStop, aStop] = [before[0].board[1], before[0].board[0]];
  const updates = buildReorderUpdates({
    weekday: 3, classTime: "17:00~18:00", direction: "BOARD",
    stops: [
      { rowIds: bStop.rows.map((r) => r.rowId), arriveTime: "16:20" },
      { rowIds: aStop.rows.map((r) => r.rowId), arriveTime: "16:35" },
    ],
  }, rows.map((r) => ({ id: r.id, weekday: r.weekday, direction: r.direction, classTime: r.classTime, sortOrder: r.sortOrder, studentId: null, studentName: r.studentName })));
  const byId = new Map(updates.map((u) => [u.id, u]));
  const after = rows.map((r) => (byId.has(r.id) ? { ...r, sortOrder: byId.get(r.id).sortOrder, arriveTime: byId.get(r.id).arriveTime } : r));

  const redrawn = buildFallbackClasses(selectDriverDayRows(after, 3), () => false);
  assert.deepEqual(redrawn[0].board.map((s) => [s.label, s.arriveTime, s.rows.map((r) => r.name)]), [["B동", "16:20", ["나", "다"]], ["A동", "16:35", ["가"]]]);
  // 다른 수업 칸은 그대로.
  assert.deepEqual(redrawn[1].board.map((s) => [s.label, s.arriveTime]), [["X동", "17:30"]]);
  assert.equal(after.find((r) => r.id === "x").sortOrder, 2);
});

test("정규 배차: 기사님 화면이 바뀐다는 배너와 첫 저장 확인창(정규 모드 안에서만)", () => {
  const dispatchClient = read("src/app/admin/shuttle/regular-dispatch/RegularDispatchClient.tsx");
  assert.match(dispatchClient, /저장한 노선은 선택한 월·요일·방향의 기사님 화면에 반영됩니다/);
  assert.match(dispatchClient, /저장 전 변경은 기사님에게 보이지 않습니다/);
  const routeSection = read("src/components/seasonal/RouteSection.tsx");
  // 현재 노선과 저장 기준 시각이 모두 없을 때만 첫 저장 영향을 확인한다.
  // 기존 저장본에서 자동 제안을 새로 만든 경우는 첫 저장으로 오인하지 않는다.
  const saveBody = routeSection.slice(routeSection.indexOf("async function saveRoute()"), routeSection.indexOf("function setDriver("));
  assert.match(saveBody, /if \(regularEditing\) \{[\s\S]*if \(!loadedFromSaved && !savedAt && !window\.confirm\("지금 기사님 화면은 「셔틀 명단」 순서로 운행 중입니다/);
  assert.match(saveBody, /여기서 저장하면 이 요일·방향의 기사님 화면이 이 노선으로 바뀝니다/);
});
