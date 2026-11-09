import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const picker = fs.readFileSync("src/components/maps/LocationPickerModal.tsx", "utf8");
// 옛 노선 편성 화면 삭제(2026-10-02) — 저장 중 표시는 지금 위치를 저장하는 학생 상세 화면으로 검사한다.
const studentDetail = fs.readFileSync("src/app/admin/students/[id]/StudentDetailClient.tsx", "utf8");

test("location picker starts near Dasan instead of Seoul city hall", () => {
  assert.match(picker, /DEFAULT_MAP_CENTER = \{ latitude: 37\.624, longitude: 127\.151 \}/);
  assert.doesNotMatch(picker, /37\.5665/);
});

test("location picker shows clear states while saving or locating", () => {
  assert.match(picker, /confirmPending = false/);
  assert.match(picker, /isLocating/);
  assert.match(picker, /aria-busy=\{confirmPending \|\| isLocating\}/);
  assert.match(picker, /confirmPending \? "저장 중\.\.\." : isLocating \? "현재 위치 확인 중\.\.\." : placeNameMissing \? "장소명을 적어 주세요" : location \? "이 위치로 선택" : "위치 선택 필요"/);
  assert.match(studentDetail, /confirmPending=\{shuttleSaving\}/);
});

test("[장소명 필수 2026-11-09] 켠 곳(원생 등록·학부모 셔틀 링크)만 이름이 비면 «위치 선택»을 끄고 안내한다", () => {
  assert.match(picker, /requirePlaceName = false/, "기본은 꺼짐 — 학원 위치·정류장 편집은 그대로");
  assert.match(picker, /const placeNameMissing = requirePlaceName && !hasShuttlePlaceName\(placeName\)/);
  assert.match(picker, /disabled=\{confirmPending \|\| placeNameMissing\}/);
  assert.match(picker, /\{placeNameMissing && \(\s*<p id=\{`\$\{titleId\}-place-name-hint`\}[^>]*>\{SHUTTLE_PLACE_NAME_REQUIRED_MESSAGE\}<\/p>/);
  assert.match(picker, /if \(requirePlaceName && !trimmedName\) \{/, "확정 함수도 한 번 더 막는다");
  const modal = fs.readFileSync("src/app/admin/students/StudentRegisterModal.tsx", "utf8");
  const parent = fs.readFileSync("src/app/shuttle/location/[token]/RegularShuttleLocationClient.tsx", "utf8");
  assert.match(modal, /<LocationPickerModal[\s\S]*?requirePlaceName[\s\S]*?\/>/);
  assert.match(parent, /<LocationPickerModal[^>]*requirePlaceName/);
});

test("location picker explains why confirm cannot save without coordinates", () => {
  assert.match(picker, /function confirmSelection/);
  assert.match(picker, /현재 위치 확인이 끝나거나 지도를 움직여 위치를 선택해주세요/);
  assert.match(picker, /현재 위치를 확인하고 있습니다\. 잠시 후 다시 눌러주세요/);
  assert.doesNotMatch(picker, /disabled=\{!location \|\| confirmPending\}/);
});
