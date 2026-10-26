import assert from "node:assert/strict";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const { getStizIdentityBypass, STIZ_IDENTITY_LOGO_URL } = await loadTsModule("src/lib/identity/brand.ts");

test("인증창에는 HTTPS 공식 STIZ 로고를 전달하고 상점·채널은 변경하지 않는다", () => {
  const request = getStizIdentityBypass();
  assert.equal(new URL(STIZ_IDENTITY_LOGO_URL).protocol, "https:");
  assert.equal(new URL(STIZ_IDENTITY_LOGO_URL).hostname, "www.stiz-dasan.kr");
  assert.equal(request.inicisUnified.logoUrl, STIZ_IDENTITY_LOGO_URL);
  assert.equal(request.inicisUnified.flgFixedUser, "N");
  assert.deepEqual(Object.keys(request), ["inicisUnified"]);
});

test("인증 호출 간에 표시 설정을 공유하거나 덮어쓰지 않는다", () => {
  const first = getStizIdentityBypass();
  first.inicisUnified.logoUrl = "https://example.invalid/other.png";
  assert.equal(getStizIdentityBypass().inicisUnified.logoUrl, STIZ_IDENTITY_LOGO_URL);
});
