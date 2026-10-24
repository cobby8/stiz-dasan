import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// 정규 배차 손편집(2단계) 연결과 방학특강 회귀 방지를 소스 수준에서 고정한다.
// 계산 자체는 src/lib/regular/regularRouteEdit.test.ts 가 실제로 돌려 검증한다.
const routeSection = readFileSync("src/components/seasonal/RouteSection.tsx", "utf8");
const regularClient = readFileSync("src/app/admin/shuttle/regular-dispatch/RegularDispatchClient.tsx", "utf8");
const seasonalClient = readFileSync("src/app/admin/seasonal/dispatch/DispatchClient.tsx", "utf8");

test("방학특강 화면은 정규 손편집을 켜지 않는다(기본값 false)", () => {
  assert.match(routeSection, /regularEditing = false/);
  assert.doesNotMatch(seasonalClient, /regularEditing/);
  // 방학특강의 기존 삭제 버튼·문구는 그대로
  assert.match(routeSection, /🗑 노선 삭제/);
  assert.match(routeSection, /이 요일의 저장된 노선을 삭제할까요\?/);
});

test("정규 배차는 두 방향 모두 손편집을 켜고 세부 조정을 기본으로 펼친다", () => {
  assert.equal((regularClient.match(/regularEditing onDirtyChange=/g) ?? []).length, 2);
  assert.match(regularClient, /<details open/);
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
test("배차 월을 바꾸면 두 방향 모두 새 달 노선을 다시 불러오고, 불러오기 전엔 저장·초기화를 막는다", () => {
  assert.match(regularClient, /const monthRefreshKey = Number\(serviceMonth\.replace/);
  assert.equal((regularClient.match(/refreshKey=\{monthRefreshKey\}/g) ?? []).length, 2);
  assert.doesNotMatch(regularClient, /refreshKey=\{0\}/);
  assert.match(routeSection, /setRouteReady\(false\);\s*\n\s*void switchTo\(date\)/);
  assert.match(routeSection, /const saveBlocked = !routeReady \|\| loading \|\| rerouting \|\| recalcing \|\| pendingReroute/);
  assert.match(routeSection, /if \(saving \|\| !sug\.date \|\| saveBlocked\) return;\n\s*\/\/ 정규 모드: 정원 초과/);
  assert.match(routeSection, /disabled=\{saving \|\| saveBlocked \|\| sug\.vehicles\.length === 0\}/);
});

test("저장 요청 중에 생긴 편집은 「저장 안 됨」을 지우지 않는다", () => {
  assert.match(routeSection, /function markDirty\(\) \{ editSeq\.current \+= 1; setDirty\(true\); \}/);
  assert.match(routeSection, /const seqAtStart = editSeq\.current;/);
  assert.match(routeSection, /if \(editSeq\.current === seqAtStart\) setDirty\(false\);/);
  assert.match(routeSection, /verified\?\.saved\?\.savedAt !== j.savedAt/); // 응답뿐 아니라 재조회 결과까지 일치해야 저장 완료
});

test("손편집 계산은 setSug updater 안에서, 다른 수업시간 회차 이동은 확인을 받는다", () => {
  assert.match(routeSection, /setSug\(\(prev\) => \{\n\s*const r = edit\(prev\);/);
  assert.match(routeSection, /runTimeChange\(sug\.vehicles\[vIdx\], sug\.vehicles\[toV\], isPickup\)/);
  assert.match(routeSection, /수업시간이 다른 회차입니다/);
  assert.match(routeSection, /기사님 화면 '확정 전' 칸에 계속 보입니다/);
});
