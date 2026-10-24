import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const page = readFileSync("src/app/shuttle/location/[token]/page.tsx", "utf8");
const client = readFileSync("src/app/shuttle/location/[token]/RegularShuttleLocationClient.tsx", "utf8");
const admin = readFileSync("src/app/admin/shuttle/regular/RegularShuttleClient.tsx", "utf8");
const nextConfig = readFileSync("next.config.ts", "utf8");

test("정규 셔틀 위치 링크 페이지는 token을 공개 API에만 전달한다", () => {
  assert.match(page, /RegularShuttleLocationClient token=\{token\}/);
  assert.match(client, /\/api\/shuttle\/regular-location\/\$\{encodeURIComponent\(token\)\}/);
  assert.match(client, /cache: "no-store"/);
});

test("학부모는 등원·하원 현재값과 동일 위치 선택, 지도 검색·현재위치를 사용할 수 있다", () => {
  assert.match(client, /PICKUP · 등원/);
  assert.match(client, /DROPOFF · 하원/);
  assert.match(client, /하원 하차 위치도 등원 탑승 위치와 같아요/);
  assert.match(client, /<LocationPickerModal/);
  assert.match(client, /locationTitle/);
  assert.match(client, /locationAddress/);
});

test("저장은 동의 버전과 서버 계약을 보내고 서버 재조회 결과를 완료 화면에 표시한다", () => {
  assert.match(client, /purpose: "REGULAR_SHUTTLE_LOCATION"/);
  assert.match(client, /consentVersion: SHUTTLE_LOCATION_CONSENT_VERSION/);
  assert.match(client, /name: value\.placeName \?\? null/);
  assert.match(client, /placeName: value\.name \?\? undefined/);
  assert.match(client, /result\.locations\?\.PICKUP/);
  assert.match(client, /result\.submittedAt/);
  assert.match(client, /셔틀 위치 저장 완료/);
});

test("만료·취소·무효 링크를 구분해 학부모에게 안내한다", () => {
  assert.match(client, /result\?\.status === "EXPIRED"/);
  assert.match(client, /result\?\.status === "REVOKED"/);
  assert.match(client, /유효하지 않은 링크입니다/);
});

test("관리자는 학생 ID로 링크를 만들고 직접 전달하며 자동 문자는 발송하지 않는다", () => {
  assert.match(admin, /\/api\/admin\/shuttle\/regular-location-links/);
  assert.match(admin, /JSON\.stringify\(\{ studentId \}\)/);
  assert.match(admin, /실제 문자는 발송되지 않습니다/);
  assert.doesNotMatch(admin, /regular-location-links[^\n]+sendTrackedSms/);
});

test("관리자는 학생별 링크 상태를 조회하고 취소·재발급할 수 있다", () => {
  assert.match(admin, /regular-location-links", \{ cache: "no-store" \}/);
  assert.match(admin, /ACTIVE" \| "SUBMITTED" \| "EXPIRED" \| "REVOKED/);
  assert.match(admin, /method: "DELETE"/);
  assert.match(admin, /링크 재발급/);
  assert.match(admin, /기존 링크는 즉시 사용할 수 없게 됩니다/);
});

test("공개 위치 링크만 현재 위치 권한을 허용하고 검색·리퍼러 노출을 막는다", () => {
  assert.match(nextConfig, /source: "\/shuttle\/location\/:path\*"/);
  assert.match(nextConfig, /geolocation=\(self\)/);
  assert.match(nextConfig, /shuttle\/location\(\?:\/\|\$\)/);
  assert.match(page, /robots: \{ index: false, follow: false, nocache: true \}/);
  assert.match(page, /referrer: "no-referrer"/);
});
