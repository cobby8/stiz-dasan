import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";

// 아이폰 유니버설 링크 확인 파일. 팀 ID 가 없으면 404, 있으면 정해진 앱 하나·좁은 경로만 내보내는지 못박는다.
function load(file) {
  const exports = {};
  const js = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("exports", "process", js)(exports, process);
  return exports;
}
const aasa = load("src/lib/app-site-association.ts");
const nextConfig = fs.readFileSync("next.config.ts", "utf8");
const route = fs.readFileSync("src/app/api/apple-app-site-association/route.ts", "utf8");

test("규격 주소(확장자 없음)로 서빙된다", () => {
  assert.match(nextConfig, /source: "\/\.well-known\/apple-app-site-association"/);
  assert.match(nextConfig, /destination: "\/api\/apple-app-site-association"/);
  assert.match(route, /status: 404/);
});

test("팀 ID 가 없거나 형식이 틀리면 내보내지 않는다(404)", () => {
  for (const value of [undefined, "", "ABC", "AB12CD34EF1", "AB12CD34E!", "가나다라마바사아자차"]) {
    assert.equal(aasa.buildAppleAppSiteAssociation({ APPLE_TEAM_ID: value }), null, String(value));
  }
});

test("팀 ID 가 있으면 업턴랩스 정식 앱 하나와 정해진 좁은 경로만 연결한다", () => {
  const body = aasa.buildAppleAppSiteAssociation({ APPLE_TEAM_ID: " ab12cd34ef " });
  const appID = "AB12CD34EF.kr.co.upturnlabs.stizdasan";
  const paths = ["/auth/native/return", "/payments/????????-????-????-????-????????????", "/mypage", "/mypage/payments", "/login", "/store-app"];
  assert.deepEqual(body.applinks.details, [{ appIDs: [appID], components: paths.map((path) => ({ "/": path })) }]);
  // 토스 결제 완료·실패 복귀 주소를 앱이 빼앗으면 웹 결제 확인이 끊긴다 — 와일드카드로 넓히지 않는다.
  for (const path of paths) assert.ok(!path.includes("*"), path);
  assert.ok(!paths.some((path) => /success|fail|done|checkout/.test(path)));
  assert.deepEqual(body.webcredentials, { apps: [appID] });
  // 웹 전체(/*)를 앱이 가로채면 학부모 웹·결제 화면이 앱으로 튄다 — 금지.
  assert.ok(!JSON.stringify(body).includes('"/*"'));
});

test("유니버설 링크 준비가 운영 간편로그인을 켜지 않는다", () => {
  // 2026-11-13 a1: 운영 간편로그인은 서버 스위치(NATIVE_AUTH_ENABLED)로만 켜진다. 개발 복귀 주소는 운영에서 열리지 않는다.
  const policy = fs.readFileSync("src/lib/native-auth/policy.ts", "utf8");
  assert.match(policy, /if \(env\.NATIVE_AUTH_ENABLED !== "true"\) \{\s*throw new NativeAuthError\(503/);
  assert.match(policy, /env\.NATIVE_AUTH_DEVELOPMENT_CALLBACKS_ENABLED === "true" && env\.NODE_ENV !== "production"/);
});
