import assert from "node:assert/strict";
import test from "node:test";
import { isPublicSitePath } from "../src/lib/public-site-path.ts";

test("공개 안내·상세·신청·가입 화면만 스포츠 스타일 대상으로 선택한다", () => {
  for (const route of ["/", "/about", "/programs", "/programs/order", "/schedule", "/simulator", "/notices/example", "/gallery", "/apply/trial", "/apply/enroll", "/apply/uniform", "/seasonal/example/apply", "/shop/product/123", "/login", "/signup/parent", "/parent-app", "/teacher-app"]) {
    assert.equal(isPublicSitePath(route), true, route);
  }
});

test("역할별 업무·초대·결제·이름이 비슷한 경로에는 공개 스타일을 적용하지 않는다", () => {
  for (const route of ["/admin", "/admin/settings", "/staff", "/staff/login", "/mypage", "/driver/example", "/shuttle/regular/example", "/invite/example", "/payments/example", "/request/example", "/shop-admin", "/apply-other", "/parent-app/private"]) {
    assert.equal(isPublicSitePath(route), false, route);
  }
  assert.equal(isPublicSitePath(null), false);
});
