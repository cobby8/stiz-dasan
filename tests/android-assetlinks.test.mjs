import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

// Digital Asset Links — 안드로이드 TWA 가 이 도메인을 제 것으로 인정받는 파일.
// 틀리면 앱이 「검증 실패」로 주소표시줄을 띄우는데, 오류 메시지가 없어 원인을 찾기 매우 어렵다.
// 그래서 형식 검사와 «값이 없으면 404» 를 테스트로 못박는다.

const route = fs.readFileSync("src/app/api/assetlinks/route.ts", "utf8");
const nextConfig = fs.readFileSync("next.config.ts", "utf8");

test("규격 주소로 서빙된다", () => {
  // 이 주소는 안드로이드가 고정으로 찾는 곳이라 바꿀 수 없다.
  assert.match(nextConfig, /source: "\/\.well-known\/assetlinks\.json"/);
  assert.match(nextConfig, /destination: "\/api\/assetlinks"/);
});

test("지문이 없으면 404 — 잘못된 값을 서빙하지 않는다", () => {
  // placeholder 를 넣어 두면 TWA 가 조용히 깨진다. 파일이 없는 편이 낫다.
  assert.match(route, /if \(!packageName \|\| fingerprints\.length === 0\)/);
  assert.match(route, /status: 404/);
});

test("SHA-256 지문 형식을 검사한다", () => {
  // "AA:BB:...:FF" 32바이트. 공백·소문자·잘린 값이 그대로 나가면 검증이 실패한다.
  assert.match(route, /\^\(\[0-9A-F\]\{2\}:\)\{31\}\[0-9A-F\]\{2\}\$/);
  assert.match(route, /toUpperCase\(\)/);
  // 콤마로 여러 개 — 앱 서명 키와 업로드 키를 모두 넣어야 한다.
  assert.match(route, /\.split\(","\)/);
});

test("응답이 Digital Asset Links 규격을 지킨다", () => {
  assert.match(route, /"delegate_permission\/common\.handle_all_urls"/);
  assert.match(route, /namespace: "android_app"/);
  assert.match(route, /package_name: packageName/);
  assert.match(route, /sha256_cert_fingerprints: fingerprints/);
  // 최상위가 배열이어야 한다(객체로 내보내면 안드로이드가 읽지 못한다).
  assert.match(route, /const body = \[\s*\n?\s*\{/);
});

test("캐시가 너무 길지 않다", () => {
  // 지문을 고친 뒤 오래 캐시되면 검증이 풀리지 않는다.
  const match = /max-age=(\d+)/.exec(route);
  assert.ok(match, "Cache-Control 이 없다");
  assert.ok(Number(match[1]) <= 3600, `캐시가 ${match[1]}초로 너무 길다`);
});

test("지문 형식 검사가 실제로 쓰레기 값을 걸러낸다", () => {
  // 라우트의 정규식을 그대로 가져와 돌려 본다 — 통과만 하는 테스트는 장식이다.
  const re = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/;
  const good = Array.from({ length: 32 }, () => "AB").join(":");
  assert.ok(re.test(good), "정상 지문을 거부하면 안 된다");
  for (const bad of [
    "",
    "AB",
    Array.from({ length: 31 }, () => "AB").join(":"), // 한 바이트 짧음
    Array.from({ length: 33 }, () => "AB").join(":"), // 한 바이트 김
    `${Array.from({ length: 31 }, () => "AB").join(":")}:ZZ`, // 16진수 아님
    good.toLowerCase(), // 소문자(라우트는 대문자로 올린 뒤 검사한다)
    `${good} `, // 공백(라우트는 trim 한다)
  ]) {
    assert.ok(!re.test(bad), `잘못된 지문을 통과시켰다: ${JSON.stringify(bad)}`);
  }
});
