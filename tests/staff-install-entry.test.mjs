import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configSource = await readFile("next.config.ts", "utf8");
const middlewareSource = await readFile("src/lib/supabase/middleware.ts", "utf8");
const manifest = JSON.parse(await readFile("public/manifest-staff.json", "utf8"));
const serviceWorkerSource = await readFile("public/sw.js", "utf8");

test("공유용 /staff/install 주소는 스토어 앱 설치 안내(/install)로 넘어간다", () => {
  // 2026-11-17 원장 승인: 설치 안내는 /install 하나. 옛 주소 다섯 개는 전부 임시 이동(permanent: false)으로 넘긴다.
  for (const source of ["/app", "/staff/install", "/mypage/install", "/teacher-app", "/parent-app"]) {
    assert.ok(
      configSource.includes(`{ source: "${source}", destination: "/install", permanent: false },`),
      `${source} → /install`,
    );
  }
  // 옛 화면을 빌려 쓰던 주소 바꿔 주기(rewrite)는 없다
  assert.doesNotMatch(configSource, /destination:\s*["']\/(teacher-app|parent-app|mypage\/install)["']/);
  // 미들웨어의 «로그인 없이 보기» 예외는 그대로 둔다(이동이 먼저 적용되지만, 되돌릴 때 필요하다)
  assert.match(middlewareSource, /isStaffInstall\s*=\s*pathname === ["']\/staff\/install["']/);
  assert.match(
    middlewareSource,
    /isStaffPath && !isStaffLogin && !isStaffInstall/,
  );
});

test("설치 안내와 교사용 manifest는 브라우저에 저장하지 않는다", () => {
  const staffPermissionIndex = configSource.indexOf('source: "/staff/:path*"');
  const installPermissionIndex = configSource.indexOf('source: "/staff/install"', staffPermissionIndex);

  assert.match(
    configSource,
    /source:\s*["']\/manifest-staff\.json["'][\s\S]*?no-cache, no-store, must-revalidate/,
  );
  assert.match(
    configSource,
    /source:\s*["']\/staff\/install["'][\s\S]*?no-cache, no-store, must-revalidate/,
  );
  assert.match(
    configSource,
    /source:\s*["']\/teacher-app["'][\s\S]*?no-cache, no-store, must-revalidate/,
  );
  assert.match(
    configSource,
    /source:\s*["']\/staff\/install["'][\s\S]*?noindex, nofollow[\s\S]*?camera=\(\), microphone=\(\)/,
  );
  assert.ok(
    staffPermissionIndex >= 0 && installPermissionIndex > staffPermissionIndex,
    "설치 화면의 권한 차단 규칙은 일반 staff 허용 규칙보다 뒤에서 적용되어야 합니다.",
  );
  assert.match(serviceWorkerSource, /const PRIVATE_PATH_PREFIXES[\s\S]*?["']\/staff["']/);
});

test("앱 시작 주소와 바로가기에 초대 토큰을 포함하지 않는다", () => {
  assert.equal(manifest.start_url, "/staff");
  assert.equal(manifest.scope, "/staff");
  assert.equal(JSON.stringify(manifest).includes("token"), false);
  assert.equal(JSON.stringify(manifest).includes("invite"), false);
});
