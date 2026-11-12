import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(
  new URL("../src/app/api/admin/verify-phone/route.ts", import.meta.url),
  "utf8",
);
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

test("인증 API는 원장 전용이며 메모리 상태를 사용하지 않는다", () => {
  assert.equal((route.match(/await requireOwner\(\)/g) ?? []).length, 2);
  assert.doesNotMatch(route, /globalThis|new Map/);
  assert.match(route, /"StaffPhoneVerification"/);
  assert.match(route, /"StaffPhoneVerificationSend"/);
});

test("발송 쿼터와 OTP 검증은 advisory lock 트랜잭션 안에서 처리한다", () => {
  assert.match(route, /prisma\.\$transaction\(async \(tx\)/);
  assert.ok((route.match(/pg_advisory_xact_lock/g) ?? []).length >= 4);
  assert.match(route, /INTERVAL '1 hour'/);
  assert.match(route, /INTERVAL '1 day'/);
  assert.match(route, /randomInt\(0, 1_000_000\)/);
  assert.match(route, /createHmac\("sha256"/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /status = 'FAILED'/);
});

test("발송 세대 ID가 오래된 SMS 완료 결과의 덮어쓰기를 차단한다", () => {
  assert.match(route, /const sendId = randomUUID\(\)/);
  assert.match(route, /"currentSendId" = \$3, status = 'PENDING'/);
  assert.match(
    route,
    /WHERE id = \$2 AND "currentSendId" = \$3 AND status = 'PENDING'/,
  );
  assert.match(
    route,
    /WHERE id = \$1 AND "currentSendId" = \$2 AND status = 'PENDING'/,
  );
  assert.match(route, /let finalized = false/);
  const successFinalize = route.slice(route.indexOf("let finalized = false"));
  const sendFirst = successFinalize.indexOf("const sendUpdated");
  const verificationSecond = successFinalize.indexOf("const verificationUpdated");
  assert.ok(sendFirst >= 0 && verificationSecond > sendFirst);
  assert.match(successFinalize, /if \(sendUpdated !== 1\) return false/);
  assert.match(
    successFinalize,
    /if \(verificationUpdated !== 1\) throw new Error\("STALE_RESERVATION"\)/,
  );
  assert.match(
    successFinalize,
    /catch \(error\)[\s\S]*?status = 'FAILED'[\s\S]*?status = 'RESERVED'/,
  );
  assert.match(route, /status = 'RESERVED'[\s\S]*?INTERVAL '10 minutes'/);
  assert.match(migration, /"currentSendId" text/);
});

test("성공한 OTP는 짧은 1회용 proof로 바뀐다", () => {
  assert.match(route, /proof = randomBytes\(32\)\.toString\("base64url"\)/);
  assert.match(route, /"proofExpiresAt" = NOW\(\) \+ INTERVAL '10 minutes'/);
  assert.match(route, /proofExpiresInMs: PROOF_EXPIRY_MS/);
  assert.doesNotMatch(route, /otpMap|phoneRates|requesterRates/);
});

// 2026-11-12: «직접 추가»(createStaffUser·AddStaffModal)는 원장 결정으로 없앴다 — 로그인 없는 직원 기록만 생겼다.
// 직원은 초대로만 추가한다. 되살아나지 않게 못박는다(인증 API 자체는 위 검사로 그대로 지킨다).
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
