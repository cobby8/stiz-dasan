import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const client = readFileSync("src/app/admin/shuttle/regular/RegularShuttleClient.tsx", "utf8");
const routeSection = readFileSync("src/components/shuttle/RegularRouteSection.tsx", "utf8");
const noticeRoute = readFileSync("src/app/api/admin/shuttle/regular-notice/route.ts", "utf8");
const geocodePanel = readFileSync("src/components/shuttle/RegularStopGeocodePanel.tsx", "utf8");
const dispatchPage = readFileSync("src/app/admin/shuttle/regular-dispatch/page.tsx", "utf8");
const seasonalRouteSection = readFileSync("src/components/seasonal/RouteSection.tsx", "utf8");
const regularDispatch = readFileSync("src/lib/regular/shuttle-dispatch.ts", "utf8");
const regularPayload = readFileSync("src/lib/regular/regularDispatchPayload.ts", "utf8");
// 2026-11-09: 정규 배차 화면 = 기사님과 같은 운행표(RegularRunEditor) — 옛 RouteSection 배차 화면은 없앴다.
const regularDispatchClient = readFileSync("src/app/admin/shuttle/regular-dispatch/RegularRunEditor.tsx", "utf8");
const rosterRoute = readFileSync("src/app/api/admin/shuttle/regular-roster/route.ts", "utf8");
const rosterLib = readFileSync("src/lib/shuttle/regularRosterEdit.ts", "utf8");

test("정규 셔틀 월 선택은 한국시간과 가장 가까운 이전 월을 사용한다", () => {
  assert.match(client, /timeZone: "Asia\/Seoul"/);
  assert.match(client, /month < serviceMonth/);
  assert.match(client, /closestPreviousMonth/);
  assert.match(noticeRoute, /compareMonth >= serviceMonth/);
});

test("모바일에서도 정차 순서를 위아래 버튼으로 바꿀 수 있다", () => {
  assert.match(routeSection, /aria-label=\{`\$\{g\.label\} 위로 이동`\}/);
  assert.match(routeSection, /reorder\(i, i - 1\)/);
  assert.match(routeSection, /aria-label=\{`\$\{g\.label\} 아래로 이동`\}/);
  assert.match(routeSection, /reorder\(i, i \+ 1\)/);
});

test("정차 순서 저장은 현재 선택한 운영 월을 함께 보내 다른 월 수정을 막는다", () => {
  assert.match(routeSection, /body: JSON\.stringify\(\{ serviceMonth, updates \}\)/);
});

// 2026-10-02 셔틀 명단 화면 교체: 시트 가져오기·배차 지도·월 비교/문자 미리보기 UI 를 명단 화면에서 뺐다.
// (문자 원장 API 는 남아 있어 아래 테스트가 계속 지킨다.)
test("셔틀 명단 화면은 자동 발송 없이 앱 편집과 별도 안내 확인 패널을 쓴다", () => {
  assert.doesNotMatch(client, /regular-import|RegularRouteSection|regular-notice|docs\.google\.com/);
  assert.match(client, /\/api\/admin\/shuttle\/regular-roster/);
  assert.match(client, /정규 배차 화면에서 새 학생을 차량에 배정하고 저장해야 기사님 화면에 반영됩니다/);
  assert.match(client, /href="\/admin\/shuttle\/regular-dispatch"/);
  assert.match(client, /\/api\/admin\/shuttle\/regular-run-link/);
  assert.match(client, /<RegularShuttleNoticePanel/);
});

test("셔틀 명단 편집은 관리자 가드·raw SQL·변경 기록을 지킨다", () => {
  assert.match(rosterRoute, /requireAdmin\(\)/);
  assert.match(rosterLib, /await requireAdmin\(\)/);
  assert.doesNotMatch(rosterLib, /prisma\.regularShuttleStop|tx\.regularShuttleStop|\.shuttleAuditLog\./);
  assert.match(rosterLib, /INSERT INTO "ShuttleAuditLog"/);
  assert.match(rosterLib, /pg_advisory_xact_lock/);
  // 다음 달 만들기는 대상 달에 명단이 있으면 덮어쓰지 않는다
  assert.match(rosterLib, /명단이 이미 있습니다/);
});

test("문자 원장은 변경 시 승인을 무효화하고 승인된 최신 payload만 한 번 발송한다", () => {
  assert.match(noticeRoute, /RegularShuttleNoticeBatch/);
  assert.match(noticeRoute, /getRegularShuttleStops\(compareMonth\)/);
  assert.match(noticeRoute, /diffRegularShuttleMonths/);
  assert.match(noticeRoute, /status='CANCELLED'/);
  assert.match(noticeRoute, /PAYLOAD_CHANGED/);
  assert.match(noticeRoute, /status='HELD'/);
  assert.match(noticeRoute, /status='APPROVED'/);
  assert.match(noticeRoute, /WHERE "payloadHash"=\$1 AND status='APPROVED'/);
  assert.match(noticeRoute, /status='UNCERTAIN'/);
  assert.match(noticeRoute, /status='SENT'/);
  assert.match(noticeRoute, /eventId: payload\.payloadHash/);
});

test("정규 셔틀 좌표는 정류장별 후보와 지도 핀을 확인한 뒤 한 곳씩 저장한다", () => {
  assert.match(geocodePanel, /검색 후보를 선택하세요/);
  assert.match(geocodePanel, /draggable: true/);
  assert.match(geocodePanel, /이 위치 확인 후 저장/);
  assert.match(geocodePanel, /entries: \[\{ stopName: selectedName/);
  assert.match(dispatchPage, /totalStopCount/);
});

test("정규 셔틀 좌표는 검색 없이 지도를 직접 눌러 지정할 수 있다", () => {
  assert.match(geocodePanel, /addListener\(map, "click"/);
  assert.match(geocodePanel, /지도에서 실제 승하차 위치를 누르세요/);
  assert.match(geocodePanel, /지도에서 직접 지정/);
  assert.match(geocodePanel, /장소를 찾기 어려울 때만 검색을 사용하세요/);
});

test("정규 배차의 좌표 누락 명단은 기본 접고 설정 화면으로 안내한다", () => {
  assert.match(seasonalRouteSection, /href="#regular-stop-coordinate-setup"/);
  assert.match(seasonalRouteSection, /누락 학생 확인/);
});

test("정규 셔틀 자동 제안은 등원 시작·하원 종료 시각별로 학생을 분리한다", () => {
  assert.match(regularDispatch, /direction === "PICKUP" \? rider\.classStart : rider\.classEnd/);
  assert.match(regularDispatch, /orderedGroups/);
  assert.match(regularDispatch, /timeGroupLabel: label/);
  assert.match(regularDispatch, /timeGroups: suggestions\.map/);
});

test("시간대별 실행은 순서 변경과 저장 후에도 자기 수업시간 앵커를 유지한다", () => {
  assert.match(seasonalRouteSection, /run\.classStart \?\? cur\.classStart/);
  assert.match(seasonalRouteSection, /run\.classEnd \?\? cur\.classEnd/);
  assert.match(regularPayload, /timeOrMissing\(vehicle\.classStart\)/);
  assert.match(regularPayload, /timeOrMissing\(vehicle\.classEnd\)/);
});

test("등원과 하원 수업시간이 다르면 자동 수정하지 않고 관리자에게 표시한다", () => {
  assert.match(regularDispatchClient, /const mismatches = useMemo\(/);
  assert.match(regularDispatchClient, /등원·하원 수업시간이 다른 학생/);
  assert.match(regularDispatchClient, /자동으로 고치지 않는다/);
});

// 2026-11-05 원장 지시: 「등원·하원이 나뉘어 보이는데 시간대별로 보이게. 시간순 노선은 필요 없어」.
// 예전엔 위에 요약 표(시간순 노선·하루 운행 흐름) + 아래 「방향별 세부 조정」(등원 묶음 → 하원 묶음)이었다.
// 이제 요약 표는 없애고, 두 방향 회차 카드를 한 목록에 시간순(그 차의 실제 출발 시각 순, 같으면 등원 먼저)으로 섞는다.
// 순서 계산 자체는 src/lib/regular/regularDispatchOrder.test.ts 가 실제로 돌려 검증한다.
test("정규 배차 화면은 등원·하원 회차 카드를 한 목록에 시간순으로 섞어 보여준다", () => {
  assert.doesNotMatch(regularDispatchClient, /시간순 노선/);
  assert.doesNotMatch(regularDispatchClient, /하루 운행 흐름/);
  assert.doesNotMatch(regularDispatchClient, /buildTimelineRows/);
  assert.doesNotMatch(regularDispatchClient, /방향별 세부 조정 열기/);
  // 2026-11-09: 정규는 기사님과 같은 운행표(시각순 한 목록) — RouteSection 시간순 모드를 더 쓰지 않는다.
  assert.doesNotMatch(regularDispatchClient, /timeOrdered|regularEditing/);
  assert.match(regularDispatchClient, /<RunBoard/);
  // 공용 섹션(방학특강·옛 정규 모드 코드는 그대로): 시간순 모드에서만 겉 상자를 풀고 카드에 순서 값·방향 배지·방향이 적힌 저장 버튼
  assert.match(seasonalRouteSection, /timeOrdered = false/);
  assert.match(seasonalRouteSection, /order: runTimelineOrder\(v, isPickup, vIdx\)/);
  assert.match(seasonalRouteSection, /`💾 \$\{dirLabel\} 저장`/);
  assert.match(seasonalRouteSection, /\{timeOrdered && <span[^>]*>\{dirLabel\}<\/span>\}/);
});

// 2026-11-09 원장 결정: 정규는 차량 개념을 없앴다(기사님 1명·모두 같은 운행표) — 차량별 담당 기사 선택은 방학특강만.
test("정규 운행표는 차량·담당 기사를 고르지 않는다 · 방학특강 RouteSection 의 담당 기사는 그대로", () => {
  assert.doesNotMatch(dispatchPage, /WHERE role='DRIVER'|drivers=\{drivers\}/);
  assert.doesNotMatch(regularDispatchClient, /drivers=\{drivers\}|moveStopToVehicle|moveStudentToVehicle/);
  assert.match(seasonalRouteSection, /담당 기사/);
  assert.match(seasonalRouteSection, /driverUserId/);
});
