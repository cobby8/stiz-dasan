import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const picker = fs.readFileSync("src/components/maps/LocationPickerModal.tsx", "utf8");
const apply = fs.readFileSync("src/components/seasonal/SeasonalApplyClient.tsx", "utf8");

test("지도 SDK는 필요할 때만 불러오고 API 키가 없으면 텍스트 입력으로 복구한다", () => {
  assert.match(picker, /NEXT_PUBLIC_KAKAO_MAP_JS_KEY/);
  assert.match(picker, /autoload=false&libraries=services/);
  assert.match(picker, /현재 지도를 사용할 수 없습니다/);
  assert.match(picker, /텍스트로 입력하기/);
});

test("승하차 지도 위치와 별도 위치 동의가 신청 payload에 포함된다", () => {
  assert.match(apply, /pickupLocationData/);
  assert.match(apply, /dropoffLocationData/);
  assert.match(apply, /locationConsent:/);
  assert.match(apply, /locationConsentVersion:/);
  assert.match(apply, /\(!hasMapSelection \|\| locationConsent\)/);
});

test("선택한 특강 일정의 요일을 기존 필수 신청 계약에 포함한다", () => {
  assert.match(apply, /const \[selectedWeekdayKeys, setSelectedWeekdayKeys\]/);
  assert.match(apply, /function toggleWeekday/);
  assert.match(apply, /const selectedWeekdays = selectedWeekdayKeys\.filter/);
  // 2026-11-18: 날짜 모드도 «주N회»로 반을 고르게 되어 matchingOfferingForWeekdays → matchingOfferingForCount(요일 모드는 요일 수)
  assert.match(apply, /matchingOfferingForCount\(offerings, item, frequencyCount\)/);
  assert.match(apply, /const frequencyCount = isDateMode \? \(weeklyFrequency \?\? 0\) : selectedWeekdays\.length/);
  assert.match(apply, /selectedWeekdays,/);
});

test("고정 신청 버튼 주변에 미완료 항목을 안내하고 오류를 alert로 알린다", () => {
  assert.match(apply, /const incompleteItems = \[/);
  assert.match(apply, /미완료: \{incompleteItems\.join\(" · "\)\}/);
  assert.match(apply, /aria-describedby=\{incompleteItems\.length > 0 \? "seasonal-apply-incomplete"/);
  assert.match(apply, /role=\{submitState === "error" \? "alert" : "status"\}/);
  assert.match(apply, /aria-live=\{submitState === "error" \? "assertive" : "polite"\}/);
  assert.match(apply, /flex-wrap items-center gap-3 sm:flex-nowrap/);
  assert.match(apply, /order-first w-full text-xs.*sm:order-none/);
});

test("주소 텍스트를 고쳐도 지도 핀 좌표는 지우지 않는다", () => {
  // 예전에는 텍스트가 주소의 정본이라, 손으로 고치면 좌표를 지워 불일치를 막았다.
  // 지금은 반대다 — 텍스트는 "상세 설명(선택)"이고 **지도 핀이 실제 위치의 기준**이다.
  // 여기서 좌표를 지우면 기사님이 핀을 잃는다.
  assert.match(apply, /function updateLocationText/);
  assert.match(apply, /\[kind === "pickup" \? "pickupLocation" : "dropoffLocation"\]: value/);
  assert.doesNotMatch(apply, /\[kind === "pickup" \? "pickupLocationData" : "dropoffLocationData"\]: undefined/);
});

test("사용자가 지도를 조작하기 전에는 기본 서울 좌표를 선택값으로 만들지 않는다", () => {
  assert.match(picker, /selectionEnabledRef = useRef\(Boolean\(initialValue\)\)/);
  assert.match(picker, /if \(selectionEnabledRef\.current\) reverseGeocode/);
  assert.doesNotMatch(picker, /map\.relayout\(\); updateCenter\(\)/);
});

test("가장 최근의 역지오코딩 응답만 선택 위치에 반영한다", () => {
  assert.match(picker, /requestSequence = \+\+geocodeSequenceRef\.current/);
  assert.match(picker, /requestSequence !== geocodeSequenceRef\.current/);
});

test("지도 모달은 최초 포커스, 탭 순환, 포커스 복원을 제공한다", () => {
  assert.match(picker, /searchInputRef\.current/);
  assert.match(picker, /event\.key !== "Tab"/);
  assert.match(picker, /previousFocusRef\.current\?\.focus\(\)/);
});

test("새 지도 상호작용은 이전 선택과 진행 중인 비동기 응답을 즉시 무효화한다", () => {
  assert.match(picker, /interactionSequenceRef\.current \+= 1/);
  assert.match(picker, /setLocation\(undefined\)/);
  assert.match(picker, /interactionSequence !== interactionSequenceRef\.current/);
  assert.match(picker, /requestSequence !== geocodeSequenceRef\.current/);
});

test("검색 위치의 장소 ID는 지도 중심 주소 확인 뒤에도 유지된다", () => {
  assert.match(picker, /pendingSearchRef\.current = \{ sequence: interactionSequence/);
  assert.match(picker, /placeId: pendingSearch\?\.placeId/);
  assert.doesNotMatch(picker, /setLocation\(\{[\s\S]{0,500}pendingSearchRef\.current = null/);
});
