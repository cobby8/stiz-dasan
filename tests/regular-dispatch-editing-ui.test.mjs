import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 정규 배차 손편집(2단계) 연결과 방학특강 회귀 방지를 소스 수준에서 고정한다.
// 계산 자체는 src/lib/regular/regularRouteEdit.test.ts 가 실제로 돌려 검증한다.
const routeSection = readFileSync("src/components/seasonal/RouteSection.tsx", "utf8");
// 2026-11-09 원장 결정: 정규 배차 화면은 기사님과 같은 운행표(RegularRunEditor)로 바꿨다 — RouteSection 정규 손편집은 더 쓰지 않는다.
const regularClient = readFileSync("src/app/admin/shuttle/regular-dispatch/RegularRunEditor.tsx", "utf8");
const seasonalClient = readFileSync("src/app/admin/seasonal/dispatch/DispatchClient.tsx", "utf8");

test("방학특강 화면은 정규 손편집·시간순 모드를 켜지 않는다(기본값 false)", () => {
  assert.match(routeSection, /regularEditing = false/);
  assert.doesNotMatch(seasonalClient, /regularEditing/);
  assert.doesNotMatch(seasonalClient, /timeOrdered/);
  // 방학특강의 기존 삭제 버튼·문구는 그대로
  assert.match(routeSection, /🗑 노선 삭제/);
  assert.match(routeSection, /이 요일의 저장된 노선을 삭제할까요\?/);
});

// 2026-11-09: 자동 제안(T맵)·차량 이동·⇄ 제거 — 정규 화면은 RouteSection 을 쓰지 않고, 접는 영역 없이 운행표를 늘 펼친다.
test("정규 배차는 RouteSection(자동 제안·차량 이동) 없이 운행표를 늘 펼치고 이탈 확인은 유지한다", () => {
  assert.doesNotMatch(regularClient, /RouteSection|regularEditing|timeOrdered/);
  // 2026-11-12: f9265bc5 가 «배차 필요 · 시각 미입력» 경고 목록만 접는 칸으로 붙였다(운행표 아님).
  // 그 경고 한 덩어리만 빼고 보면 여전히 접는 영역이 없어야 하고, 그 덩어리 안에 운행표가 들어가면 안 된다.
  const missingTimeWarning = regularClient.match(/<details[^>]*>\s*<summary[^>]*>배차 필요 · 시각 미입력[\s\S]*?<\/details>/)?.[0] ?? "";
  assert.doesNotMatch(missingTimeWarning, /운행표|lg:grid/);
  assert.doesNotMatch(regularClient.replace(missingTimeWarning, ""), /<details/);
  assert.match(regularClient, /confirmLeave\(\)/);
});

test("정규 손편집은 순수 모듈로 계산하고 바뀐 차량만 시각·경로를 다시 계산한다", () => {
  assert.match(routeSection, /from "@\/lib\/regular\/regularRouteEdit"/);
  assert.match(routeSection, /moveStopToVehicle\(/);
  assert.match(routeSection, /moveStudentToVehicle\(/);
  assert.match(routeSection, /removeStudentFromRoute\(/);
  assert.match(routeSection, /touched\.forEach\(\(vi\) => scheduleReroute\(vi\)\)/);
});

test("정규 손편집 안전장치: 명단 안내·정원 경고·자동 제안 확인·저장 안 됨·이탈 경고·모바일 순서 버튼", () => {
  assert.match(routeSection, /「셔틀 명단」에서 빼야 다음 자동 제안에서도 빠집니다/);
  assert.match(routeSection, /overCapacityVehicles\(sug\.vehicles\)/);
  assert.match(routeSection, /손으로 고친 순서·시각·배정이 사라집니다\. 계속할까요\?/);
  assert.match(routeSection, /↺ 자동 제안으로 초기화/);
  assert.match(routeSection, /● 저장 안 됨/);
  assert.match(routeSection, /addEventListener\("beforeunload"/);
  assert.match(routeSection, /reorderStop\(vIdx, sIdx, sIdx - 1\)/);
  assert.match(routeSection, /reorderStop\(vIdx, sIdx, sIdx \+ 1\)/);
  assert.match(routeSection, /sm:hidden/);
});

// ── 2단계 리뷰 수정(2026-10-02) ──
test("(방학특강 RouteSection) 노선을 다시 불러오기 전엔 저장·초기화를 막는다", () => {
  assert.match(routeSection, /setRouteReady\(false\);\s*\n\s*void switchTo\(date\)/);
  assert.match(routeSection, /const saveBlocked = !routeReady \|\| loading \|\| rerouting \|\| recalcing \|\| pendingReroute/);
  assert.match(routeSection, /if \(saving \|\| !sug\.date \|\| saveBlocked\) return;\n\s*\/\/ 정규 모드: 정원 초과/);
  assert.match(routeSection, /disabled=\{saving \|\| saveBlocked \|\| sug\.vehicles\.length === 0\}/);
});

test("저장 요청 중에 생긴 편집은 「저장 안 됨」을 지우지 않는다", () => {
  // 2026-11-05: 사람 편집 표시(setUserEdited)가 같이 켜지고 꺼진다 — 「저장 안 됨」 규칙은 그대로.
  assert.match(routeSection, /function markDirty\(\) \{ editSeq\.current \+= 1; setDirty\(true\); setUserEdited\(true\); \}/);
  assert.match(routeSection, /const seqAtStart = editSeq\.current;/);
  assert.match(routeSection, /if \(editSeq\.current === seqAtStart\) \{ setDirty\(false\); setUserEdited\(false\); \}/);
  assert.match(routeSection, /verified\?\.saved\?\.savedAt !== j.savedAt/); // 응답뿐 아니라 재조회 결과까지 일치해야 저장 완료
});

test("손편집 계산은 setSug updater 안에서, 다른 수업시간 회차 이동은 확인을 받는다", () => {
  assert.match(routeSection, /setSug\(\(prev\) => \{\n\s*const r = edit\(prev\);/);
  assert.match(routeSection, /runTimeChange\(sug\.vehicles\[vIdx\], sug\.vehicles\[toV\], isPickup\)/);
  assert.match(routeSection, /수업시간이 다른 회차입니다/);
  assert.match(routeSection, /기사님 화면 '확정 전' 칸에 계속 보입니다/);
});
