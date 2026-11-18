import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const action = readFileSync(
  new URL("../src/app/actions/admin.ts", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL(
    "../prisma/migrations/20260723132500_secure_staff_phone_verification/migration.sql",
    import.meta.url,
  ),
  "utf8",
);

// 2026-11-18 옛 코드 정리 B: 직원 전화 인증 API 는 증명값(proof)을 쓰던 createStaffUser 가 없어져
// 들어오는 길이 없었다(호출 0건). 라우트를 지웠다. DB 표(StaffPhoneVerification)는 범위 밖이라 남긴다.
test("직원 전화 인증 API(/api/admin/verify-phone)는 지워져 있다", () => {
  assert.equal(existsSync(new URL("../src/app/api/admin/verify-phone/route.ts", import.meta.url)), false);
});

// 2026-11-12: «직접 추가»(createStaffUser·AddStaffModal)는 원장 결정으로 없앴다 — 로그인 없는 직원 기록만 생겼다.
// 직원은 초대로만 추가한다. 되살아나지 않게 못박는다.
test("직접 추가(로그인 없는 직원 생성)는 없어졌다", () => {
  assert.doesNotMatch(action, /export async function createStaffUser\(/);
  assert.doesNotMatch(action, /verificationProof: string/);
  assert.equal(existsSync(new URL("../src/app/admin/staff/AddStaffModal.tsx", import.meta.url)), false);
});

test("공개 스키마 테이블은 RLS와 직접 접근 차단을 강제한다", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\."StaffPhoneVerification"/);
  assert.match(migration, /UNIQUE \("ownerId", "phoneHash"\)/);
  assert.equal((migration.match(/ENABLE ROW LEVEL SECURITY/g) ?? []).length, 2);
  assert.equal((migration.match(/FORCE ROW LEVEL SECURITY/g) ?? []).length, 2);
  assert.equal(
    (migration.match(/REVOKE ALL ON TABLE[\s\S]*?FROM anon, authenticated;/g) ?? []).length,
    2,
  );
});
