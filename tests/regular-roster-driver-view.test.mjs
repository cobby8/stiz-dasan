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
  // 기사님 화면 서버도 같은 요일 행 선택 함수를 쓴다(조립은 순수 함수 regularRunRows 로 옮겼다).
  assert.match(driverRoute, /return buildRegularRunClasses\(\{/);
  assert.match(read("src/lib/shuttle/regularRunRows.ts"), /selectDriverDayRows\(input\.stops, input\.weekday\)/);
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

// 2026-11-09 원장 결정: 관리자 배차 화면 = 기사님 화면과 똑같이 보이고 같은 화면에서 직접 수정.
// → 같은 순수 조립(buildRegularRunRows)·같은 카드 틀(RunBoard)·같은 CSS(DriverWorkspace) — 자체 묶음·자동 제안 금지.
test("정규 운행표(관리자): 기사님과 같은 조립 함수·카드 틀로 그리고, 고치기는 명단 편집 API 만 쓴다", () => {
  const editor = read("src/app/admin/shuttle/regular-dispatch/RegularRunEditor.tsx");
  const dialogs = read("src/app/admin/shuttle/regular-dispatch/RunEditDialogs.tsx");
  const page = read("src/app/admin/shuttle/regular-dispatch/page.tsx");
  assert.match(editor, /import RunBoard from "@\/components\/shuttle\/run\/RunBoard"/);
  assert.match(editor, /import \{ buildRegularRunRows \} from "@\/lib\/shuttle\/regularRunRows"/);
  assert.match(editor, /buildRegularRunRows\(\{ stops, weekday \}\)/);
  assert.match(editor, /<RunBoard[\s\S]*mode="admin"[\s\S]*renderRider=\{renderRider\}/);
  assert.match(editor, /styles\.workspace/);
  // 자체 묶음 함수·옛 배차 부품·자동 제안 없음
  assert.doesNotMatch(editor, /function group\w*\(|buildFallbackClasses|RouteSection|regular\/dispatch|computeRegularDispatch|\btmap\w*\(/);
  assert.doesNotMatch(page, /getRegularDispatchForView|RegularDispatchClient|computeRegularDispatch/);
  // 순서·시각 저장 = 묶음별 reorder, 학생 칸 = editStudent, 정류장 = editStop, 빼기 = DELETE(범위 포함)
  assert.match(editor, /action: "reorder", serviceMonth, scope: orderScope, weekday, classTime: head\.classTime/);
  assert.match(dialogs, /export const ROSTER_API = "\/api\/admin\/shuttle\/regular-roster";/);
  assert.match(dialogs, /action: "editStudent", serviceMonth, scope, studentId/);
  assert.match(dialogs, /action: "editStop", serviceMonth, scope, id:/);
  assert.match(dialogs, /rosterCall\("DELETE", \{ serviceMonth, scope, ids \}\)/);
  // 지도로 정류장을 정할 땐 장소명 필수(주소가 정류장 이름이 되지 않게)
  assert.equal((dialogs.match(/<LocationPickerModal[\s\S]*?requirePlaceName/g) ?? []).length, 2);
  // 탑승 체크 API 는 관리자 화면에서 부르지 않는다
  assert.doesNotMatch(editor + dialogs, /\/api\/shuttle\/regular-boarding|\/api\/shuttle\/regular-order/);
});

// 2026-11-13 원장 결정: 옛 규칙(«옮기면 시각 칸은 자리에 남고 정류장만 바뀜»)을 바꿨다.
// 이제 순서를 옮기면 그 묶음 시각을 다시 계산한다(등원 첫 탑승·하원 학원 출발 고정 + 지도 이동 시간 — routeRetime.ts).
// 관리자 운행표와 기사님 화면이 같은 부품(useRouteRetime)을 쓰고, 계산할 수 없을 때만 옛 방식으로 둔다.
test("정규 운행표 순서 편집(관리자·기사님) = 같은 묶음 안에서만 · 옮기면 시각 다시 계산(같은 부품)", () => {
  const editor = read("src/app/admin/shuttle/regular-dispatch/RegularRunEditor.tsx");
  const driver = read("src/components/shuttle/UnifiedDriverClient.tsx");
  assert.match(editor, /const same = ordered\.filter\(\(r\) => r\.groupKey === row\.groupKey && !r\.isTerminal\);/);
  assert.match(editor, /if \(!from \|\| from\.groupKey !== target\.groupKey \|\| from\.isTerminal \|\| target\.isTerminal\) return;/);
  for (const src of [editor, driver]) {
    assert.match(src, /import \{ useRouteRetime \} from "@\/components\/shuttle\/run\/useRouteRetime";/);
    // 위·아래 이동과 끌어 옮기기 둘 다 같은 reorderGroup 을 거친다.
    assert.equal((src.match(/reorderGroup\((same|sameGroup), next\);/g) ?? []).length, 2);
    // 계산이 되면 거기서 끝, 못 하면(좌표 없음 등) 옛 방식으로 둔다.
    assert.match(src, /const done = retime\(groupKey, saved, (same|sameGroup), next, displayTime,/);
    // 손으로 시각을 고치면 늦게 온 지도 계산이 덮어쓰지 않게 막는다.
    assert.match(src, /onTimeChange=\{\(row, value\) => \{ cancelRetime\(\);/);
    // 옛 «시각 칸 맞바꾸기»는 남아 있지 않다.
    assert.doesNotMatch(src, /\[row\.key\]: otherTime \?\? "", \[other\.key\]: rowTime \?\? ""/);
  }
  // 방학특강 행은 다시 계산하지 않는다(정규만 저장되는 화면).
  assert.match(driver, /if \(next\[0\]\.kind === "REGULAR"\) \{/);
});
