import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 실제 사고(2026-08-09): 학부모 앱을 열면 ERR_TOO_MANY_REDIRECTS.
// /mypage 가드가 거절 → /auth/continue → 다시 /mypage → 거절 … 이 반복됐다.
// 두 가지를 못 박는다. (1) 거절한 화면으로 되돌려보내지 않는다
//                     (2) 학부모 앱은 제 영역(/mypage) 밖으로 나가지 않는다

const layout = await readFile("src/app/mypage/layout.tsx", "utf8");
const continuePage = await readFile("src/app/auth/continue/page.tsx", "utf8") + "\n" + await readFile("src/lib/auth/continue-destination.ts", "utf8");
const nextConfig = await readFile("next.config.ts", "utf8");
const middleware = await readFile("src/lib/supabase/middleware.ts", "utf8");

test("학부모 화면이 거절하면 되돌아올 목적지를 지운다", () => {
  // bounced=1 이 없으면 continue 가 다시 /mypage 로 보내 무한 반복이 된다.
  assert.match(layout, /requireVerifiedParent\(\)\.catch\(\(\) => redirect\("\/mypage\/continue\?bounced=1"\)\)/);
  assert.match(continuePage, /params\.bounced/);
  assert.match(continuePage, /const requestedPath = bounced \? undefined : requestedPathParam/);
});

test("거절 후 이동은 학부모 앱 영역 안에서 시작한다", () => {
  // /auth/continue 로 나가면 설치된 앱이 주소표시줄을 띄우며 브라우저로 샌다.
  assert.doesNotMatch(layout, /"\/auth\/continue/);
  assert.match(nextConfig, /source: "\/mypage\/continue"[\s\S]{0,200}destination: "\/auth\/continue"/);
});

test("보호 화면은 어디서든 같은 방식으로 거절한다", async () => {
  // 레이아웃만 고치면 하위 화면이 각자 옛 방식으로 되돌려보내 같은 사고가 난다.
  const guarded = [
    ["src/app/mypage/regular-absence/page.tsx", "/mypage/continue?bounced=1"],
    ["src/app/mypage/seasonal/page.tsx", "/mypage/continue?bounced=1"],
    // 선생님 앱도 같은 함정이 있었다(영역 밖인 /auth/continue 로 나감).
    ["src/app/staff/seasonal/page.tsx", "/staff/continue?bounced=1"],
  ];
  for (const [path, target] of guarded) {
    const source = await readFile(path, "utf8");
    assert.match(source, new RegExp(`redirect\\("${target.replace("?", "\\?")}"\\)`), `${path} 의 거절 경로`);
    assert.doesNotMatch(source, /redirect\("\/auth\/continue/, `${path} 는 앱 영역 밖으로 나가면 안 됩니다.`);
  }
});

test("역할 판별 경로는 리다이렉트 목적지로 다시 쓰이지 않는다", () => {
  // 판별 경로 자신을 목적지로 넘기면 그것만으로도 순환한다.
  assert.match(middleware, /bare === "\/mypage\/continue"/);
  assert.match(middleware, /bare === "\/staff\/continue"/);
  assert.match(middleware, /bare === "\/auth\/continue"/);
});
