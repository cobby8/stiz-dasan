import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-18 원장 결정 «가입·본인인증 통일»: 본인인증(포트원) 결과의 실명·시각을 User 에 적고,
// 결제창 이름은 «실명 → 닉네임» 순서, 이름 칸은 «닉네임». 문자 인증(SMS)은 실명을 적지 않는다.
// 실명을 적는 길이 여러 곳이라 «한 곳의 규칙(verified-identity) + 각 길이 그 규칙을 부르는지»를 같이 본다.

const vi = await loadTsModule("src/lib/identity/verified-identity.ts");
// payerAccess → child-access 가 prisma 를 import 한다 — prisma 만 가짜로 바꿔 끼운다(가족 연결 표 «준비됨»)
process.env.CHILD_CONNECTIONS_ENABLED = "true";
globalThis.__identityPayerFake = { async $queryRawUnsafe(sql) { return /AS ready/.test(sql) ? [{ ready: true }] : []; } };
const fakePrisma = `data:text/javascript;base64,${Buffer.from("export const prisma = new Proxy({}, { get: (_t, key) => globalThis.__identityPayerFake[key] });").toString("base64")}`;
const payer = await loadTsModule("src/lib/payments/payerAccess.ts", { overrides: { "@/lib/prisma": fakePrisma } });
const { CLEARED_USER_COLUMNS } = await loadTsModule("src/lib/account/withdrawal.ts");
const socialLink = await loadTsModule("src/lib/account/social-link.ts");
const phoneRules = await loadTsModule("src/lib/account/phone-change-rules.ts");
const { identityName } = await loadTsModule("src/lib/account/child-link-policy.ts");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

// ── 순수 규칙(실제로 실행) ─────────────────────────────────────────────────
test("실명 다듬기: 공백 정리·NFC 합치기·빈 값은 null·길이 제한", () => {
  assert.equal(vi.cleanVerifiedName("  김  철수 "), "김 철수");
  assert.equal(vi.cleanVerifiedName("홍길동".normalize("NFD")), "홍길동");
  assert.equal(vi.cleanVerifiedName("   "), null);
  assert.equal(vi.cleanVerifiedName(undefined), null);
  assert.equal(vi.cleanVerifiedName(123), null);
  assert.equal(vi.cleanVerifiedName("가".repeat(300)).length, vi.VERIFIED_NAME_MAX);
});

test("인증 시각: verifiedAt → statusChangedAt → 지금 순서", () => {
  const now = new Date("2026-11-18T00:00:00.000Z");
  assert.equal(vi.identityVerifiedAtOf({ verifiedAt: "2026-11-17T23:55:00Z", statusChangedAt: "2026-11-17T23:00:00Z" }, now).toISOString(), "2026-11-17T23:55:00.000Z");
  assert.equal(vi.identityVerifiedAtOf({ statusChangedAt: "2026-11-17T23:00:00Z" }, now).toISOString(), "2026-11-17T23:00:00.000Z");
  assert.equal(vi.identityVerifiedAtOf({ verifiedAt: "엉뚱한 값" }, now), now);
  assert.equal(vi.identityVerifiedAtOf({}, now), now);
});

test("가입 요청 → User 로 옮길 값: 본인인증(IDENTITY)만, 문자 인증(SMS)·예전 줄은 null", () => {
  const at = new Date("2026-11-18T05:00:00Z");
  assert.deepEqual(vi.signupRowIdentity({ verificationMethod: "IDENTITY", verifiedName: " 김엄마 ", verifiedAt: at }), { verifiedName: "김엄마", verifiedAt: at });
  assert.deepEqual(vi.signupRowIdentity({ verificationMethod: "IDENTITY", verifiedName: "김엄마", verifiedAt: "2026-11-18T05:00:00Z" }), { verifiedName: "김엄마", verifiedAt: at });
  assert.equal(vi.signupRowIdentity({ verificationMethod: "SMS", verifiedName: "김엄마", verifiedAt: at }), null, "문자 인증은 실명을 적지 않는다");
  assert.equal(vi.signupRowIdentity({ verificationMethod: null, verifiedName: "김엄마", verifiedAt: at }), null, "예전 줄");
  assert.equal(vi.signupRowIdentity({ verificationMethod: "IDENTITY", verifiedName: "", verifiedAt: at }), null);
  assert.equal(vi.signupRowIdentity({ verificationMethod: "IDENTITY", verifiedName: "김엄마", verifiedAt: null }), null);
});

test("User 에 적기: 이름이 있으면 한 번 UPDATE(탈퇴 계정 제외), 비었으면 DB 를 부르지 않는다", async () => {
  const calls = [];
  const db = { async $executeRawUnsafe(sql, ...args) { calls.push({ sql, args }); return 1; } };
  const at = new Date("2026-11-18T05:00:00Z");
  assert.equal(await vi.recordIdentityVerification(db, { userId: "u1", verifiedName: " 홍길동 ", verifiedAt: at }), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /UPDATE "User" SET "identityVerifiedName" = \$2, "identityVerifiedAt" = \$3/);
  assert.match(calls[0].sql, /WHERE id = \$1 AND "withdrawnAt" IS NULL/);
  assert.deepEqual(calls[0].args, ["u1", "홍길동", at]);
  assert.equal(await vi.recordIdentityVerification(db, { userId: "u1", verifiedName: "  ", verifiedAt: at }), false);
  assert.equal(await vi.recordIdentityVerification(db, { userId: "", verifiedName: "홍길동", verifiedAt: at }), false);
  assert.equal(await vi.recordIdentityVerification(db, { userId: "u1", verifiedName: "홍길동", verifiedAt: new Date("x") }), false);
  assert.equal(calls.length, 1, "빈 이름·빈 계정·잘못된 시각은 DB 를 부르지 않는다");
});

// ── DB 제약과 코드 상수 대조 ───────────────────────────────────────────────
test("인증 방식 목록(코드) = 마이그레이션 CHECK, 새 칸은 schema.prisma 에도 있다", () => {
  const dirs = fs.readdirSync("prisma/migrations").sort();
  let latest = null;
  for (const dir of dirs) {
    const file = path.join("prisma/migrations", dir, "migration.sql");
    if (!fs.existsSync(file)) continue;
    const match = read(file).match(/ParentSignupVerification_verificationMethod_check"\s*CHECK \("verificationMethod" IN \(([^)]*)\)\)/);
    if (match) latest = match[1].match(/'([A-Z]+)'/g).map((value) => value.slice(1, -1));
  }
  assert.ok(latest, "verificationMethod CHECK 마이그레이션을 찾지 못했다");
  assert.deepEqual([...vi.PARENT_SIGNUP_VERIFICATION_METHODS].sort(), [...latest].sort());

  const migration = read("prisma/migrations/20261118220000_identity_verified_name/migration.sql");
  for (const column of [/"User" ADD COLUMN IF NOT EXISTS "identityVerifiedAt" TIMESTAMPTZ/, /"User" ADD COLUMN IF NOT EXISTS "identityVerifiedName" TEXT/,
    /"ParentSignupVerification" ADD COLUMN IF NOT EXISTS "verifiedName" TEXT/, /"ParentSignupVerification" ADD COLUMN IF NOT EXISTS "verificationMethod" TEXT/]) {
    assert.match(migration, column);
  }
  // 추가만 — 되돌림 SQL 은 주석 안에만 있다
  const live = migration.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(live, /DROP\s+(COLUMN|CONSTRAINT|TABLE)/i);
  // CI·생년월일 칸은 만들지 않는다
  assert.doesNotMatch(live, /ci"|birth/i);

  const schema = read("prisma/schema.prisma");
  const user = schema.slice(schema.indexOf("model User {"), schema.indexOf("\n}\n", schema.indexOf("model User {")));
  assert.match(user, /identityVerifiedAt\s+DateTime\?\s+@db\.Timestamptz\(6\)/);
  assert.match(user, /identityVerifiedName\s+String\?/);
  const psv = schema.slice(schema.indexOf("model ParentSignupVerification {"), schema.indexOf("\n}\n", schema.indexOf("model ParentSignupVerification {")));
  assert.match(psv, /verifiedName\s+String\?/);
  assert.match(psv, /verificationMethod\s+String\?/);
});

// ── 실명을 적는 길(소스 계약) ──────────────────────────────────────────────
test("기존 계정 연결 라우트: 직원 기록 연결·가입 이어가기·기존 계정 연결 세 갈래 모두 실명·시각을 넘긴다", () => {
  const route = read("src/app/api/auth/parent-link/verify/route.ts");
  assert.match(route, /const identityVerifiedAt = identityVerifiedAtOf\(verification\);/);
  // 포트원 확인(VERIFIED·10분 안)이 실명 사용보다 먼저
  assert.ok(route.indexOf("isFreshVerification(verifiedAt)") < route.indexOf("identityVerifiedAtOf(verification)"));
  assert.match(route, /claimStaffRecordByIdentity\(\{[^}]*verifiedName, verifiedAt: identityVerifiedAt \}\)/);
  assert.match(route, /issueIdentityVerifiedSignup\(\{[^}]*verifiedName, verifiedAt: identityVerifiedAt \}\)/);
  // 기존 계정 연결: 그 계정(target.userId)에, 로그인이 끝난 뒤
  // 2026-11-18 5단계: 미리 붙인 역할 적용과 같은 거래(tx)에서 적는다
  const record = route.indexOf("await recordIdentityVerification(tx, { userId: target.userId, verifiedName, verifiedAt: identityVerifiedAt })");
  assert.ok(record > 0, "기존 계정 연결 갈래에서 실명을 적는다");
  assert.ok(record > route.indexOf("signedIn.data.user?.id !== target.authUserId"), "기존 계정 로그인 확인 뒤에 적는다");
});

test("가입 인증 모듈: 본인인증 요청은 'IDENTITY'+실명으로, 가입 완료는 signupRowIdentity 로만 User 에 넣는다", () => {
  const lib = read("src/lib/parent-signup-verification.ts");
  const issue = lib.slice(lib.indexOf("export async function issueIdentityVerifiedSignup"), lib.indexOf("export async function verifyParentSignupOtp"));
  assert.match(issue, /verifiedName: string; verifiedAt: Date;/);
  assert.match(issue, /'VERIFIED','IDENTITY',\$9,\$10/);
  assert.match(issue, /if \(!verifiedName\) return \{ error:/, "이름 없는 본인인증 통과 줄을 만들지 않는다");
  const complete = lib.slice(lib.indexOf("export async function completeParentSignup"));
  assert.match(complete, /const identity = signupRowIdentity\(row!\);/);
  assert.match(complete, /"identityVerifiedName","identityVerifiedAt"/);
  assert.match(complete, /identity\?\.verifiedName \?\? null, identity\?\.verifiedAt \?\? null/);
  // 문자 인증 확인(verifyParentSignupOtp)은 실명 칸을 건드리지 않는다
  const otp = lib.slice(lib.indexOf("export async function verifyParentSignupOtp"), lib.indexOf("export async function completeParentSignup"));
  assert.doesNotMatch(otp, /verifiedName|identityVerified/);
});

test("활성화·직원 기록 연결·연락처 바꾸기도 같은 거래에서 같은 함수로 적는다", () => {
  const claim = read("src/lib/parent-account-claim.ts");
  // 검수 N-2: 발급(issueVerifiedSelfParentClaim)은 증표에만 싣고, User 에는 소비(consume) 거래에서 적는다
  const issue = claim.slice(claim.indexOf("export async function issueVerifiedSelfParentClaim"), claim.indexOf("export async function sendParentClaimOtp"));
  assert.doesNotMatch(issue, /recordIdentityVerification\(/);
  const consume = claim.slice(claim.indexOf("export async function consumeParentAccountClaim"));
  assert.match(consume, /await recordIdentityVerification\(tx, \{ userId: claim!\.parentId, verifiedName: claim!\.verifiedName, verifiedAt: new Date\(claim!\.identityVerifiedAt\) \}\);/);
  const staff = read("src/lib/staff/staffSelfClaim.ts");
  const staffTx = staff.slice(staff.indexOf("prisma.$transaction("), staff.indexOf("if (!claimed) return"));
  assert.match(staffTx, /await recordIdentityVerification\(tx, \{ userId: row\.id, verifiedName: input\.verifiedName, verifiedAt: input\.verifiedAt \}\);/);
  // 감사 기록 JSON 에 실명을 싣지 않는다
  assert.doesNotMatch(staffTx.slice(staffTx.indexOf("OperationsAuditLog")), /verifiedName/);
  const phone = read("src/lib/account/phone-change.ts");
  // (2026-11-18 검수 R-3: 거래 결과를 받아 미리 붙인 역할 알림을 보낸 뒤 돌려주도록 바뀌었다)
  const phoneTx = phone.slice(phone.indexOf("const result = await prisma.$transaction("));
  assert.ok(phone.includes("const result = await prisma.$transaction("));
  assert.match(phoneTx, /await recordIdentityVerification\(tx, \{ userId: actor\.id, verifiedName: v\.verifiedCustomer\?\.name, verifiedAt: new Date\(at\) \}\);/);
});

test("실명은 로그·오류 문구에 남기지 않는다", () => {
  for (const file of [
    "src/app/api/auth/parent-link/verify/route.ts",
    "src/lib/parent-signup-verification.ts",
    "src/lib/parent-account-claim.ts",
    "src/lib/staff/staffSelfClaim.ts",
    "src/lib/account/phone-change.ts",
    "src/lib/identity/verified-identity.ts",
  ]) {
    for (const line of read(file).split("\n").filter((l) => /console\.(log|error|warn|info)\(/.test(l))) {
      assert.doesNotMatch(line, /verifiedName|identityVerifiedName|verifiedCustomer/, `${file}: ${line.trim()}`);
    }
  }
  assert.doesNotMatch(read("src/lib/identity/verified-identity.ts"), /console\./);
});

// ── 탈퇴 ────────────────────────────────────────────────────────────────
test("탈퇴하면 실명·시각을 비운다(비우는 칸 목록 한 곳)", () => {
  assert.ok(CLEARED_USER_COLUMNS.includes("identityVerifiedName"));
  assert.ok(CLEARED_USER_COLUMNS.includes("identityVerifiedAt"));
});

// ── 결제창 이름 ─────────────────────────────────────────────────────────
test("결제창 이름: 실명 → 닉네임 순서(순수 규칙과 SQL 조각)", () => {
  assert.equal(vi.payerDisplayName({ identityVerifiedName: "홍길동", name: "길동맘" }), "홍길동");
  assert.equal(vi.payerDisplayName({ identityVerifiedName: "  ", name: "길동맘" }), "길동맘");
  assert.equal(vi.payerDisplayName({ identityVerifiedName: null, name: "길동맘" }), "길동맘");
  assert.equal(vi.payerDisplayName({}), null);
  assert.equal(vi.payerDisplayNameSql("u"), `COALESCE(NULLIF(btrim(u."identityVerifiedName"), ''), u.name)`);
  assert.throws(() => vi.payerDisplayNameSql("u; DROP TABLE x"));
  assert.throws(() => vi.payerDisplayNameSql(""));
});

test("결제창 이름: resolveLinkedPayer 가 실명을 먼저 돌려준다(가짜 DB 로 실행)", async () => {
  const users = [
    { id: "mom", authUserId: "auth-mom", name: "길동맘", identityVerifiedName: "홍엄마" },
    { id: "dad", authUserId: "auth-dad", name: "아빠닉", identityVerifiedName: null },
  ];
  const db = {
    async $queryRawUnsafe(sql, authUserId) {
      // SQL 이 «실명 → 닉네임» 조각을 name 으로 고르는지 확인하고, 그 의미대로 계산한다
      assert.match(sql, /SELECT u\.id, COALESCE\(NULLIF\(btrim\(u\."identityVerifiedName"\), ''\), u\.name\) AS name, u\.email, u\.phone/);
      return users.filter((u) => u.authUserId === authUserId).map((u) => ({
        id: u.id, name: vi.payerDisplayName(u), email: `${u.id}@x`, phone: null, studentId: "kid-1",
      }));
    },
  };
  assert.equal((await payer.resolveLinkedPayer(db, "auth-mom", ["kid-1"]))?.name, "홍엄마");
  assert.equal((await payer.resolveLinkedPayer(db, "auth-dad", ["kid-1"]))?.name, "아빠닉", "실명이 없으면 닉네임");
});

test("결제창 이름: 단건 청구서·묶음 결제도 같은 조각을 쓰고, 체험비·비회원 이름 규칙은 그대로다", () => {
  const ledger = read("src/lib/payment-ledger.ts");
  assert.match(ledger, /\$\{payerDisplayNameSql\("u"\)\} AS "parentName",/);
  assert.match(ledger, /SELECT \$\{payerDisplayNameSql\("u"\)\} AS name, u\.email, u\.phone FROM "User" u WHERE u\.id = \$1 LIMIT 1/);
  assert.match(ledger, /customerName: user\?\.name \|\| rep\.studentName \|\| "STIZ 학부모"/);
  assert.match(ledger, /customerName: invoice\.payerName \|\| invoice\.studentName \|\| "STIZ 학부모"/);
  // 예전처럼 닉네임(u.name)을 그대로 parentName 으로 쓰는 줄이 남아 있지 않다
  assert.doesNotMatch(ledger, /u\.name AS "parentName"/);
});

// ── 닉네임 라벨 ─────────────────────────────────────────────────────────
test("학부모 가입·설정 화면의 보호자 이름 칸은 «닉네임»(학생 이름 칸은 그대로)", () => {
  const signup = read("src/components/auth/ParentSignupClient.tsx");
  assert.match(signup, />닉네임<input name="name"/);
  assert.doesNotMatch(signup, />이름<input name="name"/);
  assert.match(signup, /본인인증 실명은 따로 보관돼요/);
  const settings = read("src/app/mypage/settings/SettingsClient.tsx");
  const nameRow = settings.slice(settings.indexOf("export function NameRow"), settings.indexOf("// ── 결제: 자주 쓰는 결제 방법"));
  assert.match(nameRow, />닉네임<\/span>/);
  assert.match(nameRow, /aria-label="닉네임"/);
  assert.match(nameRow, /본인인증 실명은 따로 보관돼요/);
  // 닉네임 바꾸기는 실명 칸을 건드리지 않는다
  const action = read("src/app/actions/parent-settings.ts");
  const update = action.slice(action.indexOf("export async function updateMyName"), action.indexOf("export async function changeMyPassword"));
  assert.match(update, /UPDATE "User" SET name = \$1/);
  assert.doesNotMatch(update, /identityVerified/);
});

// ── 검수 N-1: 이름 비교 기준 = 실명이 있으면 실명, 없으면 닉네임 ─────────────────────────
test("N-1 비교 기준 이름: 실명 → 닉네임", () => {
  assert.equal(vi.identityComparableName({ identityVerifiedName: "홍길동", name: "민준맘" }), "홍길동");
  assert.equal(vi.identityComparableName({ identityVerifiedName: null, name: "홍길동" }), "홍길동");
  assert.equal(vi.identityComparableName({ identityVerifiedName: " ", name: "홍길동" }), "홍길동");
  assert.equal(vi.identityComparableName({}), "");
});

test("N-1 새 기기 연결(selectLinkTarget): 닉네임을 바꾼 학부모도 실명으로 연결되고, 다른 사람 이름은 그대로 막힌다", () => {
  const parent = { id: "p1", role: "PARENT", name: "민준맘", identityVerifiedName: "홍길동", authUserId: "auth-p1", phoneVerifiedAt: "2026-11-01" };
  assert.deepEqual(socialLink.selectLinkTarget([parent], "홍길동"), { kind: "OK", userId: "p1", authUserId: "auth-p1" });
  assert.deepEqual(socialLink.selectLinkTarget([parent], "홍 길동"), { kind: "OK", userId: "p1", authUserId: "auth-p1" }, "공백 차이는 같은 이름");
  assert.deepEqual(socialLink.selectLinkTarget([parent], "김철수"), { kind: "NAME_MISMATCH" }, "다른 명의자는 막는다");
  assert.deepEqual(socialLink.selectLinkTarget([parent], "민준맘"), { kind: "NAME_MISMATCH" }, "실명이 있으면 닉네임으로는 통과하지 않는다");
  // 실명이 아직 없는 계정은 예전처럼 계정 이름(닉네임)으로 비교
  const legacy = { ...parent, name: "홍길동", identityVerifiedName: null };
  assert.equal(socialLink.selectLinkTarget([legacy], "홍길동").kind, "OK");
  assert.equal(socialLink.selectLinkTarget([legacy], "김철수").kind, "NAME_MISMATCH");
  // 직원이 쓰는 번호 갈래도 같은 기준
  const staff = { id: "s1", role: "INSTRUCTOR", name: "홍쌤", identityVerifiedName: "홍길동", authUserId: "auth-s1", phoneVerifiedAt: null };
  assert.deepEqual(socialLink.selectLinkTarget([staff], "홍길동"), { kind: "OK", userId: "s1", authUserId: "auth-s1" });
  assert.deepEqual(socialLink.selectLinkTarget([staff], "김철수"), { kind: "STAFF" });
});

test("N-1 로그인 없는 직원 기록 붙이기(selectStaffRecordToClaim)도 같은 기준", () => {
  const record = { id: "r1", role: "INSTRUCTOR", name: "권쌤", identityVerifiedName: "권혜미", authUserId: null, phoneVerifiedAt: null, noLogin: true, withdrawn: false };
  assert.deepEqual(socialLink.selectStaffRecordToClaim([record], "권혜미"), { userId: "r1" });
  assert.equal(socialLink.selectStaffRecordToClaim([record], "김철수"), null);
  assert.deepEqual(socialLink.selectStaffRecordToClaim([{ ...record, name: "권혜미", identityVerifiedName: null }], "권혜미"), { userId: "r1" });
});

test("N-1 연락처 바꾸기: 닉네임을 바꾼 학부모도 실명으로 통과하고, 다른 명의자는 막힌다", () => {
  const me = { name: "민준맘", identityVerifiedName: "홍길동" };
  const base = { currentPhone: "01011112222", verifiedPhone: "01033334444", takenByOther: false };
  const accountName = identityName(vi.identityComparableName(me));
  assert.deepEqual(phoneRules.phoneChangeOutcome({ ...base, accountName, verifiedName: identityName("홍길동") }), { ok: true, changed: true });
  assert.equal(phoneRules.phoneChangeOutcome({ ...base, accountName, verifiedName: identityName("김철수") }).ok, false);
  // 연결부가 이 기준을 쓰는지(실명을 함께 읽는지)
  const phone = read("src/lib/account/phone-change.ts");
  assert.match(phone, /SELECT name, "identityVerifiedName", phone FROM "User" WHERE id=\$1 AND "withdrawnAt" IS NULL FOR UPDATE/);
  assert.match(phone, /accountName: identityName\(identityComparableName\(me\[0\]\)\),/);
  // 인증 «전» 미리 안내(nameOk)도 실명 기준 — 닉네임이 «민준맘»이어도 실명이 있으면 경고하지 않는다
  assert.equal(phoneRules.looksLikeLegalName(vi.identityComparableName(me)), true);
  assert.match(read("src/app/api/account/phone-change/route.ts"), /looksLikeLegalName\(compare\)/);
  assert.match(read("src/app/mypage/settings/page.tsx"), /looksLikeLegalName\(identityComparableName\(\{ identityVerifiedName: me\?\.identityVerifiedName/);
});

test("N-1 연결 라우트 조회가 실명 칸을 함께 읽고, 비교 함수는 닉네임(name)을 직접 비교하지 않는다", () => {
  assert.match(read("src/app/api/auth/parent-link/verify/route.ts"), /SELECT u\.id, u\.role::text AS role, u\.name, u\."identityVerifiedName", u\."phoneVerifiedAt",/);
  const src = read("src/lib/account/social-link.ts");
  assert.doesNotMatch(src, /normalizePersonName\(row\.name\)/);
});
