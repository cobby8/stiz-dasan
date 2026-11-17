import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-10-26 원장 결정: 간편로그인 후 「이미 가입된 번호」면 KG이니시스 통합인증(명의자 본인인증)으로
// 기존 학부모 계정에 연결한다. 문자 인증이 아니라 «명의» 확인이라서, 휴대폰을 잠깐 빌린 사람은 통과하지 못한다.

process.env.SUPABASE_SERVICE_ROLE_KEY ||= "test-secret-for-link-ids";
const {
  selectLinkTarget,
  selectStaffRecordToClaim,
  normalizePersonName,
  isFreshVerification,
  createLinkVerificationId,
  isLinkVerificationIdFor,
  LINK_VERIFICATION_MAX_AGE_MS,
} = await loadTsModule("src/lib/account/social-link.ts");

const verify = fs.readFileSync("src/app/api/auth/parent-link/verify/route.ts", "utf8");
const start = fs.readFileSync("src/app/api/auth/parent-link/start/route.ts", "utf8");
const shared = fs.readFileSync("src/app/api/auth/parent-link/shared.ts", "utf8");
const button = fs.readFileSync("src/components/auth/IdentityLinkButton.tsx", "utf8");
const callback = fs.readFileSync("src/app/auth/callback/route.ts", "utf8");

const parent = { id: "u1", role: "PARENT", name: "김 수빈", authUserId: "auth-1", phoneVerifiedAt: "2026-01-01" };

test("연결 대상은 «명의 번호의 학부모 계정 딱 하나 + 이름 일치»일 때만 고른다", () => {
  assert.deepEqual(selectLinkTarget([parent], "김수빈"), { kind: "OK", userId: "u1", authUserId: "auth-1" });
  assert.equal(selectLinkTarget([], "김수빈").kind, "NONE");
  assert.equal(selectLinkTarget([parent], "김수민").kind, "NAME_MISMATCH");
  assert.equal(selectLinkTarget([parent], "").kind, "NAME_MISMATCH", "이름이 비면 통과시키지 않는다");
  assert.equal(selectLinkTarget([{ ...parent, name: null }], "김수빈").kind, "NAME_MISMATCH");
  assert.equal(selectLinkTarget([parent, { ...parent, id: "u2" }], "김수빈").kind, "MULTIPLE");
  // 직원(관리자 포함)이 쓰는 번호(2026-11-17 원장 지시로 열림): 이름 일치·로그인 수단·휴대폰 인증을 모두 갖춘 계정이
  // «정확히 하나»일 때만 그 계정을 고른다. 하나로 정해지지 않으면 자동으로 고르지 않고 막는다.
  for (const role of ["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER"]) {
    const staff = { ...parent, id: "s", authUserId: "auth-s", role };
    assert.deepEqual(selectLinkTarget([staff], "김수빈"), { kind: "OK", userId: "s", authUserId: "auth-s" }, role);
    assert.equal(selectLinkTarget([parent, staff], "김수빈").kind, "STAFF", `${role}: 같은 번호에 조건을 갖춘 계정이 둘이면 막는다`);
    assert.equal(selectLinkTarget([staff], "김수민").kind, "STAFF", `${role}: 이름이 다르면 막는다`);
    assert.equal(selectLinkTarget([staff], "").kind, "STAFF", `${role}: 이름이 비면 막는다`);
    // 초대로 가입한 직원은 phoneVerifiedAt 이 없다(초대 때 문자 인증은 거쳤다) — 이름 일치 + 로그인 수단이 있으면 연결한다
    assert.deepEqual(selectLinkTarget([{ ...staff, phoneVerifiedAt: null }], "김수빈"), { kind: "OK", userId: "s", authUserId: "auth-s" }, `${role}: 초대 가입 직원`);
    // 후보가 둘이고 둘 다 휴대폰 인증 전이면 하나로 정할 수 없어 막는다
    assert.equal(selectLinkTarget([{ ...staff, phoneVerifiedAt: null }, { ...staff, id: "t", authUserId: "auth-t", phoneVerifiedAt: null }], "김수빈").kind, "STAFF", `${role}: 후보 둘`);
    assert.equal(selectLinkTarget([{ ...staff, authUserId: null }], "김수빈").kind, "STAFF", `${role}: 로그인 수단이 없으면 막는다`);
    // 원장 실제 모양: 같은 번호에 휴대폰 인증 전인 다른 직원 계정이 하나 더 있어도, 조건을 갖춘 계정이 하나면 그 계정
    assert.deepEqual(
      selectLinkTarget([staff, { ...staff, id: "v", authUserId: "auth-v", role: "VICE_ADMIN", phoneVerifiedAt: null }], "김수빈"),
      { kind: "OK", userId: "s", authUserId: "auth-s" }, role);
  }
  // 주 역할은 학부모라도 선생님·기사님 역할이 승인된 계정은 직원 규칙을 따른다(조건을 갖춘 하나면 연결).
  assert.equal(selectLinkTarget([{ ...parent, hasActiveStaffGrant: true }], "김수빈").kind, "OK");
  assert.equal(selectLinkTarget([{ ...parent, hasActiveStaffGrant: true }], "김수민").kind, "STAFF");
  // 로그인 수단이 없는 빈 계정은 이 길이 아니라 기존 문자 인증 활성화 흐름이 맡는다.
  assert.equal(selectLinkTarget([{ ...parent, authUserId: null }], "김수빈").kind, "NOT_READY");
  assert.equal(selectLinkTarget([{ ...parent, phoneVerifiedAt: null }], "김수빈").kind, "NOT_READY");
});

test("이름 비교는 공백·조합 차이만 무시한다", () => {
  assert.equal(normalizePersonName(" 김 수빈 "), "김수빈");
  assert.equal(normalizePersonName("김수빈".normalize("NFD")), "김수빈");
  assert.notEqual(normalizePersonName("김수빈"), normalizePersonName("김수민"));
});

test("본인인증은 10분 안에 끝난 것만 받는다", () => {
  const now = Date.parse("2026-10-26T03:00:00Z");
  assert.equal(isFreshVerification("2026-10-26T02:55:00Z", now), true);
  assert.equal(isFreshVerification(new Date(now - LINK_VERIFICATION_MAX_AGE_MS - 1000).toISOString(), now), false);
  assert.equal(isFreshVerification("2026-10-26T04:00:00Z", now), false, "미래 시각은 믿지 않는다");
  assert.equal(isFreshVerification(undefined, now), false);
  assert.equal(isFreshVerification("garbage", now), false);
});

test("인증 건 번호는 그 간편로그인 사용자 것만 통과한다(남의 인증 결과 재사용 차단)", () => {
  const id = createLinkVerificationId("social-user-A");
  assert.equal(isLinkVerificationIdFor(id, "social-user-A"), true);
  assert.equal(isLinkVerificationIdFor(id, "social-user-B"), false);
  assert.equal(isLinkVerificationIdFor("iv_123_abc", "social-user-A"), false);
  assert.equal(isLinkVerificationIdFor(`${id}x`, "social-user-A"), false);
  assert.notEqual(createLinkVerificationId("social-user-A"), id, "매번 새 번호");
});

test("확인 순서: 건 번호 → 포트원 재조회 → 대상 선택 → 빈 사용자 정리 → 기존 계정 로그인", () => {
  const order = [
    "currentSocialOnlyUser()",
    "isLinkVerificationIdFor(identityVerificationId, current.user.id)",
    "fetchPortoneIdentityVerification(",
    'verification.status !== "VERIFIED" || !isFreshVerification(',
    "selectLinkTarget(rows,",
    'admin.auth.admin.generateLink({ type: "magiclink"',
    "admin.auth.admin.deleteUser(current.user.id)",
    "signedIn.data.user?.id !== target.authUserId",
    'eventType: "IDENTITY_LOGIN"',
  ].map((needle) => {
    // 알림(IDENTITY_LOGIN)은 직원 기록 연결 갈래(2026-11-17)에도 있어 두 번 나온다 — 기존 계정 로그인 뒤의 것은 마지막 것이다.
    const at = needle.startsWith("eventType:") ? verify.lastIndexOf(needle) : verify.indexOf(needle);
    assert.ok(at > 0, `없음: ${needle}`);
    return at;
  });
  assert.deepEqual([...order].sort((a, b) => a - b), order, "안전 확인보다 계정 변경이 먼저 오면 안 된다");
  // 대상이 아니면 그 자리에서 끝낸다(빈 사용자를 지우기 전에).
  assert.match(verify, /if \(target\.kind !== "OK"\) return NextResponse\.json/);
  // 번호는 숫자만 비교(4가족 사고 가드), 추가 역할(승인)도 함께 읽는다.
  assert.match(verify, /regexp_replace\(COALESCE\(u\.phone, ''\), '\[\^0-9\]', '', 'g'\) = \$1/);
  assert.match(verify, /FROM "UserRoleGrant" g WHERE g\."userId" = u\.id AND g\.status = 'ACTIVE'\) AS "hasActiveStaffGrant"/);
  assert.match(verify, /isUsablePhoneKey\(phone\)/);
  // 화면이 보낸 이름·번호는 받지 않는다 — 건 번호만.
  assert.doesNotMatch(verify, /body\?\.(name|phone|verifiedCustomer)/);
});

test("앱 계정이 이미 있는 로그인은 이 길을 쓸 수 없다(다른 계정으로 갈아타기 금지)", () => {
  assert.match(shared, /SELECT EXISTS\(SELECT 1 FROM "User" WHERE "authUserId" = \$1 OR id = \$1\)/);
  assert.match(shared, /if \(!oauthProviderMethod\(provider\)\)/);
  assert.match(start, /currentSocialOnlyUser\(\)/);
});

test("화면: 건 번호는 서버에서 받고, 이니시스 필수값을 넣고, 돌아온 주소의 문구는 싣지 않는다", () => {
  const startAt = button.indexOf('postJson("/api/auth/parent-link/start")');
  const requestAt = button.indexOf("sdk.requestIdentityVerification(");
  assert.ok(startAt > 0 && requestAt > startAt);
  assert.match(button, /bypass: getStizIdentityBypass\(\)/);
  assert.match(button, /if \(pending !== returnedId \|\| params\.get\("code"\)\)/);
  assert.doesNotMatch(button, /setError\(params\.get\("message"\)/);
  assert.match(button, /const SDK_URL = "https:\/\/cdn\.portone\.io\/v2\/browser-sdk\.js"/);
});

test("연결이 끝나면 계정 주인 번호로 보안 알림 문자를 보낸다", () => {
  const finish = callback.slice(callback.indexOf("async function finishLink("), callback.indexOf("export async function GET("));
  const exchangeAt = finish.indexOf("exchangeCodeForSession(code)");
  const notifyAt = finish.indexOf('await notifyAccountSecurityEvent({ authUserId: data.user?.id, eventType: "SOCIAL_LOGIN_LINKED"');
  assert.ok(exchangeAt > 0 && notifyAt > exchangeAt, "연결이 확정된 뒤에만 알린다");
  const notify = fs.readFileSync("src/lib/account/social-link-notify.ts", "utf8");
  assert.match(notify, /source: "SECURITY"/);
  assert.match(notify, /audienceScope: "SECURITY"/);
  assert.match(callback, /body: socialLinkNoticeBody\(label\)/);
});

test("로그인 없는 직원 기록에는 본인이 본인인증으로 직접 로그인을 붙인다 — 조건은 좁게(2026-11-17)", () => {
  const record = { id: "r1", role: "ADMIN", name: "권 혜미", authUserId: null, phoneVerifiedAt: null, withdrawn: false };
  for (const role of ["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER"]) {
    assert.deepEqual(selectStaffRecordToClaim([{ ...record, role }], "권혜미"), { userId: "r1" }, role);
  }
  // 이름이 다르거나 비면 붙이지 않는다
  assert.equal(selectStaffRecordToClaim([record], "권혜민"), null);
  assert.equal(selectStaffRecordToClaim([record], ""), null);
  assert.equal(selectStaffRecordToClaim([{ ...record, name: null }], "권혜미"), null);
  // 이미 로그인이 있는 기록·학부모 기록·탈퇴(요청) 기록은 이 길이 아니다
  assert.equal(selectStaffRecordToClaim([{ ...record, authUserId: "auth-x" }], "권혜미"), null);
  assert.equal(selectStaffRecordToClaim([{ ...record, role: "PARENT" }], "권혜미"), null);
  assert.equal(selectStaffRecordToClaim([{ ...record, withdrawn: true }], "권혜미"), null);
  // 같은 번호를 쓰는 계정이 하나라도 더 있으면 자동으로 고르지 않는다
  assert.equal(selectStaffRecordToClaim([record, { ...record, id: "r2", role: "PARENT" }], "권혜미"), null);
  assert.equal(selectStaffRecordToClaim([], "권혜미"), null);
  // 라우트: 포트원 확인 뒤에만, 조건을 UPDATE 에 다시 적고(동시 요청·바뀐 기록 차단), 본인에게 알림 문자
  const at = verify.indexOf("const staffRecord = selectStaffRecordToClaim(rows, verifiedName);");
  assert.ok(at > verify.indexOf('verification.status !== "VERIFIED" || !isFreshVerification(verifiedAt)'), "본인인증 확인이 먼저");
  const block = verify.slice(at, verify.indexOf("const target = selectLinkTarget(rows, verifiedName);"));
  assert.match(block, /WHERE id = \$3 AND "authUserId" IS NULL AND role::text <> 'PARENT'/);
  assert.match(block, /"withdrawnAt" IS NULL AND "withdrawRequestedAt" IS NULL/);
  assert.match(block, /NOT EXISTS \(SELECT 1 FROM "User" o WHERE o\."authUserId" = \$1 OR o\.id = \$1\)/);
  assert.match(block, /if \(claimed !== 1\) return NextResponse\.json\(/);
  assert.match(block, /notifyAccountSecurityEvent\(/);
});
