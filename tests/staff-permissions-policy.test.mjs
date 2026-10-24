import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const config = readFileSync(
  new URL("../next.config.ts", import.meta.url),
  "utf8",
);

test("교사용 화면과 API에만 카메라와 마이크를 허용한다", () => {
  assert.match(config, /source: "\/staff\/:path\*"/);
  assert.match(config, /source: "\/api\/staff\/:path\*"/);
  assert.match(config, /camera=\(self\), microphone=\(self\), geolocation=\(\)/);
});

test("나머지 경로는 교사용 경로와 겹치지 않는 규칙으로 권한을 차단한다", () => {
  assert.match(config, /\(\?!staff\(\?:\/\|\$\)\|api\/staff\(\?:\/\|\$\)\|admin\(\?:\/\|\$\)\|shuttle\/location\(\?:\/\|\$\)\)/);
  assert.match(config, /camera=\(\), microphone=\(\), geolocation=\(\)/);
  assert.doesNotMatch(config, /source: "\/\(\.\*\)"/);
});

test("기존 공통 보안 헤더를 교사용 경로에도 유지한다", () => {
  const staffPolicy = config.slice(
    config.indexOf('source: "/staff/:path*"'),
    config.indexOf('source: "/api/staff/:path*"'),
  );
  assert.match(staffPolicy, /X-Frame-Options/);
  assert.match(staffPolicy, /X-Content-Type-Options/);
  assert.match(staffPolicy, /Referrer-Policy/);
});

test("관리자 셔틀 위치 선택 화면은 현재 위치 권한을 허용한다", () => {
  const adminStart = config.indexOf('source: "/admin/:path*"');
  const adminPolicy = config.slice(
    adminStart,
    config.indexOf('source: "/staff/install"', adminStart),
  );
  assert.match(adminPolicy, /Permissions-Policy/);
  assert.match(adminPolicy, /geolocation=\(self\)/);
});
