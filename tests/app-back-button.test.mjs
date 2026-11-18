import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backButtonSource = await readFile("src/components/AppBackButton.tsx", "utf8");
const standaloneBackButtonSource = await readFile("src/components/StandaloneBackButton.tsx", "utf8");
const rootLayoutSource = await readFile("src/app/layout.tsx", "utf8");
const publicHeaderSource = await readFile("src/components/PublicHeader.tsx", "utf8");
const adminShellSource = await readFile("src/app/admin/AdminShellClient.tsx", "utf8");
const staffLayoutSource = await readFile("src/app/staff/layout.tsx", "utf8");
const mypageLayoutSource = await readFile("src/app/mypage/layout.tsx", "utf8");

test("공통 뒤로가기 버튼은 앱 내부 이력 우선, 없으면 fallback으로 이동한다", () => {
  assert.match(backButtonSource, /router\.back\(\)/);
  // 기록 없이 한 단계 위로 갈 땐 바꿔 끼우기(replace) — 쌓으면 위 화면의 «←» 가 방금 화면으로 되돌아간다(2026-11-17 운영 재현)
  assert.match(backButtonSource, /router\.replace\(action\.href\)/);
  assert.doesNotMatch(backButtonSource, /router\.push\(action\.href\)/);
  assert.match(backButtonSource, /document\.referrer/);
  assert.match(backButtonSource, /window\.history\.state\?\.idx/);
  // 어디로 갈지 정하는 규칙은 순수 모듈로 옮겼다. 조합별 동작은 실제로 실행해서
  // 검증한다 → tests/app-back-button-scope.test.mjs
  assert.match(backButtonSource, /resolveBackAction/);
});

test("공개, 관리자, 스태프, 마이페이지 헤더에 뒤로가기 버튼이 배치된다", () => {
  // 속성이 늘어도 깨지지 않게 fallbackHref 값만 확인한다(설치 앱용 scopeHref 등이 붙는다).
  assert.match(publicHeaderSource, /<AppBackButton[^>]*fallbackHref="\/"[^>]*size="sm"/);
  assert.match(adminShellSource, /<AppBackButton[^>]*fallbackHref="\/admin"/);
  assert.match(staffLayoutSource, /<AppBackButton[^>]*fallbackHref="\/staff"/);
  // 2026-11-15 원장 결정: 학부모 화면은 돌아갈 기록이 없으면 학부모 홈(/mypage)으로
  assert.match(mypageLayoutSource, /<AppBackButton[^>]*fallbackHref="\/mypage"[^>]*size="sm"/);
  assert.equal((mypageLayoutSource.match(/<AppBackButton/g) || []).length, 2, "모바일·데스크탑 헤더 둘 다");
});

test("헤더가 없는 단독 화면은 전역 보조 뒤로가기 버튼으로 보완한다", () => {
  assert.match(rootLayoutSource, /<StandaloneBackButton \/>/);
  // 2026-11-17: 옛 설치 안내(/teacher-app)는 /install 로 넘어가 화면이 열리지 않는다 → 목록은 /install 기준
  for (const prefix of ["/login", "/invite", "/payments", "/account/activate", "/auth/continue", "/signup/parent", "/install"]) {
    assert.ok(standaloneBackButtonSource.includes(`"${prefix}"`), `${prefix} should render standalone back button`);
  }
});

test("떠 있는 뒤로 버튼 목록은 실제로 열리는 화면만 — 설치 안내는 /install 하나, 돌아갈 곳은 공개 홈", async () => {
  const prefixes = [.../const STANDALONE_PREFIXES = \[([\s\S]*?)\];/.exec(standaloneBackButtonSource)[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(prefixes.includes("/install"));
  // /install 로 넘어가기만 하는 옛 주소는 목록에 두지 않는다(next.config redirects 의 source 와 대조)
  const config = await readFile("next.config.ts", "utf8");
  const redirected = [...config.matchAll(/source:\s*"([^"]+)",\s*destination:\s*"\/install"/g)].map((m) => m[1]);
  assert.ok(redirected.includes("/teacher-app") && redirected.length >= 5, "옛 설치 안내 주소 묶음을 못 찾았다 — 검사식을 고친다");
  for (const old of redirected) assert.equal(prefixes.includes(old), false, `${old} 는 /install 로 넘어가 화면이 없다`);
  // 옛 /teacher-app → /staff 분기는 없앴다. /install 은 따로 분기하지 않아 기본값(공개 홈 /)을 쓴다
  const fallback = /function fallbackFor\(pathname: string\) \{([\s\S]*?)\n\}/.exec(standaloneBackButtonSource)[1].replace(/\/\/.*$/gm, ""); // 주석은 빼고 본다
  assert.doesNotMatch(fallback, /teacher-app|\/staff/);
  assert.doesNotMatch(fallback, /\/install"/);
  assert.match(fallback, /return "\/";\s*$/);
  // /install 화면에는 자체 머리줄·뒤로 버튼이 없다(있으면 중복이라 목록에서 빼야 한다)
  assert.doesNotMatch(await readFile("src/app/install/page.tsx", "utf8"), /PublicHeader|AppBackButton/);
});
