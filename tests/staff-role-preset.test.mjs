import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-18 원장 결정 «가입·본인인증 통일» 5단계 — 새 선생님·기사님도 학부모와 같은 가입.
// 원장 초대 = «이 번호에 역할을 미리 붙여 두기»(StaffInvitation purpose ROLE_PRESET, 30일).
// 가입·계정 연결이 끝나는 거래에서 applyRolePresetsForUser 가 같은 번호의 미리 붙인 역할을 적용한다.
//   본인인증 + 실명이 초대 이름과 같음(계정 하나) → UserRoleGrant ACTIVE / 문자 인증·이름 다름·계정 여럿 → PENDING(원장 신청함)

const preset = await loadTsModule("src/lib/staff/rolePreset.ts");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const MIGRATION = "prisma/migrations/20261118240000_staff_invitation_role_preset/migration.sql";

// ── DB 제약과 코드 목록 대조 ────────────────────────────────────────────
test("마이그레이션: purpose 허용값 = 코드 목록(SIGNUP·PASSWORD_RESET·ROLE_PRESET), ROLE_PRESET 은 대상 없음·선생님/기사만, 색인", () => {
  const sql = read(MIGRATION);
  // 주석(되돌림 SQL)을 뺀 «실행되는» 문장에서 허용값을 읽는다
  const check = sql.replace(/^--.*$/gm, "").match(/CHECK \("purpose" IN \(([^)]*)\)\)/);
  assert.ok(check, "purpose CHECK 가 있다");
  const values = check[1].split(",").map((value) => value.trim().replace(/'/g, ""));
  assert.deepEqual(values, [...preset.STAFF_INVITATION_PURPOSES]);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS "StaffInvitation_purpose_check"/);
  assert.match(sql, /"StaffInvitation_role_preset_shape_check"[\s\S]*?"purpose" <> 'ROLE_PRESET' OR \("targetUserId" IS NULL AND role IN \('INSTRUCTOR'::"Role", 'DRIVER'::"Role"\)\)/);
  assert.match(sql, /IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'StaffInvitation_role_preset_shape_check'\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "StaffInvitation_phone_purpose_status_idx"\s+ON "StaffInvitation" \(phone, purpose, status\)/);
  // 되돌림 SQL 은 주석으로만(실행되는 DROP 은 위 허용값 교체 하나뿐)
  assert.match(sql, /-- ALTER TABLE "StaffInvitation" ADD CONSTRAINT "StaffInvitation_purpose_check" CHECK \("purpose" IN \('SIGNUP', 'PASSWORD_RESET'\)\);/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /DROP TABLE|DROP COLUMN|DELETE FROM/);
  // schema.prisma 사본에도 색인
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model StaffInvitation {"), schema.indexOf("model StaffInvitationOtpSend {"));
  assert.match(model, /@@index\(\[phone, purpose, status\]\)/);
  assert.match(model, /ROLE_PRESET/);
});

test("목적 값 정리: 아는 값만, 모르는 값·빈 값은 SIGNUP", () => {
  assert.equal(preset.normalizeStaffInvitationPurpose("ROLE_PRESET"), "ROLE_PRESET");
  assert.equal(preset.normalizeStaffInvitationPurpose("PASSWORD_RESET"), "PASSWORD_RESET");
  assert.equal(preset.normalizeStaffInvitationPurpose(null), "SIGNUP");
  assert.equal(preset.normalizeStaffInvitationPurpose("WHATEVER"), "SIGNUP");
  assert.equal(preset.ROLE_PRESET_VALID_DAYS, 30);
});

// ── 순수 판정 ───────────────────────────────────────────────────────────
test("판정: 본인인증 + 이름 일치 + 계정 하나 = 바로(ACTIVE)", () => {
  assert.deepEqual(preset.decideRolePresetGrant({ invitationName: "김 코치", verifiedName: "김코치", accountCount: 1 }), { status: "ACTIVE", reason: "IDENTITY_MATCH" });
  // 유니코드 조합(NFD)·공백 차이는 같은 이름
  assert.equal(preset.decideRolePresetGrant({ invitationName: "홍길동", verifiedName: "홍길동".normalize("NFD"), accountCount: 1 }).status, "ACTIVE");
});

test("판정: 문자 인증(실명 없음)·이름 다름·같은 번호 계정 여럿 = 원장 확인(PENDING)", () => {
  assert.deepEqual(preset.decideRolePresetGrant({ invitationName: "홍길동", verifiedName: null, accountCount: 1 }), { status: "PENDING", reason: "NOT_IDENTITY" });
  assert.deepEqual(preset.decideRolePresetGrant({ invitationName: "홍길동", verifiedName: "   ", accountCount: 1 }), { status: "PENDING", reason: "NOT_IDENTITY" });
  assert.deepEqual(preset.decideRolePresetGrant({ invitationName: "홍길동", verifiedName: "홍길순", accountCount: 1 }), { status: "PENDING", reason: "NAME_MISMATCH" });
  // 계정이 여럿이면 이름이 같아도 자동으로 열지 않는다
  assert.deepEqual(preset.decideRolePresetGrant({ invitationName: "홍길동", verifiedName: "홍길동", accountCount: 2 }), { status: "PENDING", reason: "MULTIPLE_ACCOUNTS" });
  assert.equal(preset.decideRolePresetGrant({ invitationName: "홍길동", verifiedName: "홍길동", accountCount: 0 }).status, "PENDING");
});

test("안내 문자: 이름·역할·링크·30일, 다시 보낼 때 표시", () => {
  const body = preset.roleInviteSmsBody({ name: "홍길동", roleLabel: "코치/강사", inviteUrl: "https://x/invite/t" });
  assert.match(body, /^\[STIZ 농구교실\] 홍길동님, 코치\/강사 역할을 준비해 두었습니다\./);
  assert.match(body, /본인인증, 30일 안/);
  assert.match(body, /https:\/\/x\/invite\/t$/);
  assert.match(preset.roleInviteSmsBody({ name: "a", roleLabel: "b", inviteUrl: "u", resend: true }), /\(다시 보냄\)/);
});

test("검수 1: 원장 확인 알림에 확인 이유(문자 인증·이름 다름·계정 여럿)를 싣고, 실명·번호는 넣지 않는다", async () => {
  const reasons = { NOT_IDENTITY: /문자 인증으로 가입해 명의자 확인이 안 됐어요/, NAME_MISMATCH: /본인인증 이름이 초대할 때 적은 이름과 달라요/, MULTIPLE_ACCOUNTS: /같은 번호를 쓰는 계정이 여럿이에요/ };
  for (const [reason, pattern] of Object.entries(reasons)) {
    const message = preset.rolePresetReviewMessage({ invitationName: "홍길동", roleLabel: "선생님", reason });
    assert.match(message, pattern, reason);
    assert.match(message, /초대 번호\(홍길동님\)/);
    assert.match(message, /선생님 역할을 승인해 주세요/);
    assert.doesNotMatch(message, /\d{3,}/, "번호 없음");
  }
  // 알림 모듈이 이 문구를 쓰고, 본인인증 실명(verifiedName)은 받지도 않는다
  const notify = read("src/lib/staff/rolePresetNotify.ts");
  assert.match(notify, /rolePresetReviewMessage\(\{ invitationName: outcome\.invitationName, roleLabel: label, reason: outcome\.reason \}\)/);
  assert.doesNotMatch(notify, /verifiedName|phone/);
});

test("검수 R-2: 이름 뒤에 조사를 바로 붙이지 않는다(«…»과)", () => {
  for (const file of ["src/app/admin/staff/InviteStaffModal.tsx", "src/app/admin/staff/StaffClient.tsx", "src/app/invite/[token]/page.tsx"]) {
    const src = read(file);
    assert.doesNotMatch(src, /\}»과/, file);
    assert.match(src, /초대할 때 적은 이름\(«\{[^}]+\}»\)과/, file);
  }
});

test("검수 R-3(b)·R-4: 인증 전 학부모 계정 안내 · 옛 직원 기록 notice 는 초대 거절", () => {
  const body = fnBodyOf(read("src/app/actions/admin.ts"), "inviteStaff");
  assert.match(body, /"phoneVerifiedAt" IS NULL AND "withdrawnAt" IS NULL/);
  assert.match(body, /const existingAccountNotice = unverifiedParentCount > 0 \? ROLE_PRESET_EXISTING_ACCOUNT_NOTICE : undefined;/);
  assert.match(body, /existingAccountNotice,/);
  // notice 는 ROLE_PRESET 을 만들기 전에 거절
  assert.ok(body.indexOf(`if (reinvite.kind === "notice")`) < body.indexOf(`INSERT INTO "StaffInvitation"`));
  assert.match(preset.ROLE_PRESET_EXISTING_ACCOUNT_NOTICE, /로그인한 뒤 «내 정보»에서 본인인증\(연락처 확인\)/);
  assert.match(read("src/app/invite/[token]/page.tsx"), /\{ROLE_PRESET_EXISTING_ACCOUNT_NOTICE\}/);
  assert.match(read("src/app/admin/staff/InviteStaffModal.tsx"), /\{result\.existingAccountNotice\}/);
  // 기존 계정 연결 라우트 로그는 실패 단계를 가른다(검수 6)
  const route = read("src/app/api/auth/parent-link/verify/route.ts");
  assert.match(route, /role preset apply failed/);
  assert.match(route, /identity record failed/);
});

function fnBodyOf(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  const next = src.indexOf("\nexport async function ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

// ── 적용(가짜 db 로 실제 실행) ──────────────────────────────────────────
function fakeDb({ user = { id: "u1", phone: "010-1234-5678", role: "PARENT" }, invitations = [], accountCount = 1, linkedCoach = false } = {}) {
  const calls = [];
  const db = {
    calls,
    async $queryRawUnsafe(sql, ...values) {
      calls.push({ kind: "query", sql, values });
      if (sql.startsWith(`SELECT id, phone, role::text AS role FROM "User"`)) return user ? [user] : [];
      if (sql === preset.PENDING_ROLE_PRESET_SQL) return invitations;
      if (sql.includes(`SELECT COUNT(*)::int AS count FROM "User"`)) return [{ count: accountCount }];
      if (sql.startsWith(`SELECT id FROM "Coach" WHERE "userId" = $1`)) return linkedCoach ? [{ id: "c1" }] : [];
      throw new Error(`예상하지 못한 조회: ${sql.slice(0, 80)}`);
    },
    async $executeRawUnsafe(sql, ...values) {
      calls.push({ kind: "exec", sql, values });
      return 1;
    },
  };
  return db;
}
const execs = (db, pattern) => db.calls.filter((call) => call.kind === "exec" && pattern.test(call.sql));
const INVITE = { id: "inv1", name: "홍길동", role: "INSTRUCTOR", createdBy: "owner-auth" };

test("적용: 본인인증 + 이름 일치 → Grant ACTIVE(INVITE)·초대 ACCEPTED·코치 프로필 연결·감사 기록", async () => {
  const db = fakeDb({ invitations: [INVITE] });
  const outcomes = await preset.applyRolePresetsForUser(db, { userId: "u1", verifiedName: "홍길동" });
  assert.deepEqual(outcomes, [{ invitationId: "inv1", role: "INSTRUCTOR", status: "ACTIVE", reason: "IDENTITY_MATCH", invitationName: "홍길동" }]);
  // 번호는 숫자만으로 찾는다
  assert.deepEqual(db.calls.find((call) => call.sql === preset.PENDING_ROLE_PRESET_SQL).values, ["01012345678"]);
  const grant = execs(db, /INSERT INTO "UserRoleGrant"/);
  assert.equal(grant.length, 1);
  assert.match(grant[0].sql, /VALUES \(\$1, \$2, 'ACTIVE', 'INVITE', NOW\(\)/);
  assert.deepEqual(grant[0].values.slice(0, 3), ["u1", "INSTRUCTOR", "owner-auth"]);
  const accepted = execs(db, /SET status = 'ACCEPTED'/);
  assert.equal(accepted.length, 1);
  assert.match(accepted[0].sql, /WHERE id = \$1 AND status = 'PENDING' AND purpose = 'ROLE_PRESET'/);
  assert.deepEqual(accepted[0].values, ["inv1", "u1"]);
  const coach = execs(db, /UPDATE "Coach"/);
  assert.equal(coach.length, 1, "같은 이름·번호 코치 프로필 연결(초대 이름 기준)");
  assert.deepEqual(coach[0].values, ["u1", "01012345678", "홍길동"]);
  assert.equal(execs(db, /'STAFF_ROLE_PRESET_APPLIED'/).length, 1);
});

test("적용: 문자 인증(실명 없음) → Grant PENDING(원장 신청함)·초대는 썼다로 닫음·코치 연결 안 함", async () => {
  const db = fakeDb({ invitations: [INVITE] });
  const outcomes = await preset.applyRolePresetsForUser(db, { userId: "u1", verifiedName: null });
  assert.equal(outcomes[0].status, "PENDING");
  assert.equal(outcomes[0].reason, "NOT_IDENTITY");
  const grant = execs(db, /INSERT INTO "UserRoleGrant"/);
  assert.match(grant[0].sql, /VALUES \(\$1, \$2, 'PENDING', 'INVITE', \$3\)/);
  assert.match(grant[0].sql, /DO NOTHING/, "이미 열린 역할을 PENDING 으로 내리지 않는다");
  assert.equal(execs(db, /SET status = 'ACCEPTED'/).length, 1);
  assert.equal(execs(db, /UPDATE "Coach"/).length, 0);
});

test("적용: 본인인증 이름이 초대 이름과 다름 → PENDING", async () => {
  const db = fakeDb({ invitations: [INVITE] });
  const outcomes = await preset.applyRolePresetsForUser(db, { userId: "u1", verifiedName: "김철수" });
  assert.equal(outcomes[0].status, "PENDING");
  assert.equal(outcomes[0].reason, "NAME_MISMATCH");
});

test("적용: 같은 번호 계정이 둘 이상 → 이름이 같아도 PENDING", async () => {
  const db = fakeDb({ invitations: [INVITE], accountCount: 2 });
  const outcomes = await preset.applyRolePresetsForUser(db, { userId: "u1", verifiedName: "홍길동" });
  assert.equal(outcomes[0].status, "PENDING");
  assert.equal(outcomes[0].reason, "MULTIPLE_ACCOUNTS");
});

test("적용: 만료·취소·이미 쓴 초대는 보지 않는다(조회 조건) — 대기 초대가 없으면 아무것도 쓰지 않는다", async () => {
  assert.match(preset.PENDING_ROLE_PRESET_SQL, /purpose = 'ROLE_PRESET' AND status = 'PENDING' AND "expiresAt" > NOW\(\)/);
  assert.match(preset.PENDING_ROLE_PRESET_SQL, /FOR UPDATE/, "같은 거래에서 잠가 원장 취소와 겹치지 않게");
  const db = fakeDb({ invitations: [] });
  assert.deepEqual(await preset.applyRolePresetsForUser(db, { userId: "u1", verifiedName: "홍길동" }), []);
  assert.equal(db.calls.filter((call) => call.kind === "exec").length, 0);
});

test("적용: 번호가 없거나 이상하면·탈퇴 계정이면 건너뛴다", async () => {
  for (const user of [{ id: "u1", phone: null, role: "PARENT" }, { id: "u1", phone: "000", role: "PARENT" }, null]) {
    const db = fakeDb({ user, invitations: [INVITE] });
    assert.deepEqual(await preset.applyRolePresetsForUser(db, { userId: "u1", verifiedName: "홍길동" }), []);
    assert.equal(db.calls.filter((call) => call.kind === "exec").length, 0);
  }
});

test("적용: 이미 그 역할이 주 역할인 계정 → 붙일 것 없음(ALREADY), 초대만 닫음", async () => {
  const db = fakeDb({ user: { id: "u1", phone: "01012345678", role: "INSTRUCTOR" }, invitations: [INVITE] });
  const outcomes = await preset.applyRolePresetsForUser(db, { userId: "u1", verifiedName: "홍길동" });
  assert.equal(outcomes[0].status, "ALREADY");
  assert.equal(execs(db, /INSERT INTO "UserRoleGrant"/).length, 0);
  assert.equal(execs(db, /SET status = 'ACCEPTED'/).length, 1);
});

test("적용: 기사 초대는 코치 프로필을 건드리지 않는다 · 이미 코치가 연결돼 있으면 새로 잇지 않는다", async () => {
  const driverDb = fakeDb({ invitations: [{ ...INVITE, role: "DRIVER" }] });
  await preset.applyRolePresetsForUser(driverDb, { userId: "u1", verifiedName: "홍길동" });
  assert.equal(execs(driverDb, /UPDATE "Coach"/).length, 0);
  const linkedDb = fakeDb({ invitations: [INVITE], linkedCoach: true });
  await preset.applyRolePresetsForUser(linkedDb, { userId: "u1", verifiedName: "홍길동" });
  assert.equal(execs(linkedDb, /UPDATE "Coach"/).length, 0);
});

// ── 부르는 곳: 같은 거래 안에서(소스 계약) ─────────────────────────────
test("가입 완료: User 를 만드는 거래 안에서, 가입 요청 소진 전에 적용하고 알림은 거래 뒤", () => {
  const lib = read("src/lib/parent-signup-verification.ts");
  const complete = lib.slice(lib.indexOf("export async function completeParentSignup"));
  const insert = complete.indexOf(`INSERT INTO "User"`);
  const apply = complete.indexOf("presetOutcomes = await applyRolePresetsForUser(tx, { userId: authUserId!, verifiedName: identity?.verifiedName ?? null });");
  const consumed = complete.indexOf("status='CONSUMED'");
  const txEnd = complete.indexOf("    });\n", consumed);
  const notify = complete.indexOf("await notifyRolePresetOutcomes(authUserId!, presetOutcomes)");
  assert.ok(insert > 0 && apply > insert && consumed > apply, "User 생성 → 역할 적용 → 소진(한 거래)");
  assert.ok(notify > txEnd, "알림은 거래가 끝난 뒤");
});

test("빈 계정 간편로그인 연결(LINKED)·활성화 완료·기존 계정 연결도 같은 거래에서 적용", () => {
  const lib = read("src/lib/parent-signup-verification.ts");
  const resolve = lib.slice(lib.indexOf("export async function resolveVerifiedSignupPhone"), lib.indexOf("class SignupHandoffError"));
  assert.match(resolve, /applyRolePresetsForUser\(tx, \{ userId: ownership\.parentId, verifiedName: identity\?\.verifiedName \?\? null \}\)/);
  assert.ok(resolve.indexOf("applyRolePresetsForUser(tx") < resolve.indexOf("await markConsumed(oauth!.id)"));
  const claim = read("src/lib/parent-account-claim.ts");
  const consume = claim.slice(claim.indexOf(`UPDATE "User" SET email = $1, "authUserId" = $4`));
  assert.ok(consume.indexOf("presetOutcomes = await applyRolePresetsForUser(tx, {") > 0);
  assert.ok(consume.indexOf("presetOutcomes = await applyRolePresetsForUser(tx, {") < consume.indexOf(`UPDATE "ParentAccountClaim" SET status = 'CONSUMED'`));
  assert.match(consume, /verifiedName: claim!\.verifiedName && claim!\.identityVerifiedAt \? claim!\.verifiedName : null/);
  const route = read("src/app/api/auth/parent-link/verify/route.ts");
  assert.match(route, /prisma\.\$transaction\(async \(tx\) => \{\s*await recordIdentityVerification\(tx, \{ userId: target\.userId, verifiedName, verifiedAt: identityVerifiedAt \}\);\s*presetStep = "role-preset";\s*return applyRolePresetsForUser\(tx, \{ userId: target\.userId, verifiedName \}\);/);
});

// ── 원장 초대·초대 화면·퇴사 ────────────────────────────────────────────
const admin = read("src/app/actions/admin.ts");
function fnBody(src, name) {
  const start = src.indexOf(`export async function ${name}(`);
  assert.ok(start >= 0, name);
  const next = src.indexOf("\nexport async function ", start + 10);
  return src.slice(start, next < 0 ? undefined : next);
}

test("원장 초대: 새 사람은 ROLE_PRESET 30일, 재입사(옛 기록 연결)는 예전 SIGNUP 7일, 문자는 안내 문구", () => {
  const body = fnBody(admin, "inviteStaff");
  assert.match(body, /const rolePreset = !retiredTargetUserId;/);
  assert.match(body, /NOW\(\) \+ make_interval\(days => \$6::int\)/);
  assert.match(body, /rolePreset \? ROLE_PRESET_VALID_DAYS : 7,\s*rolePreset \? ROLE_PRESET_PURPOSE : "SIGNUP",/);
  assert.match(body, /roleInviteSmsBody\(\{ name: cleanName, roleLabel: staffRoleLabel, inviteUrl \}\)/);
  // 이미 인증된 학부모 계정 하나면 지금처럼 바로 붙인다(①)
  assert.match(body, /VALUES \(\$1, \$2, 'ACTIVE', 'INVITE', NOW\(\), \$3, '원장 초대'\)/);
  const resend = fnBody(admin, "resendInvitation");
  assert.match(resend, /WHEN purpose = 'ROLE_PRESET' THEN make_interval\(days => \$2::int\)/);
  assert.match(resend, /inv\.purpose === ROLE_PRESET_PURPOSE/);
});

test("초대 링크: ROLE_PRESET 은 가입 화면으로 안내하고, 직원 전용 계정 만들기(인증·수락)는 막는다", async () => {
  const page = read("src/app/invite/[token]/page.tsx");
  assert.match(page, /if \(invitation\.purpose === "ROLE_PRESET"\) \{/);
  assert.match(page, /\/signup\/parent\?staffRole=/);
  assert.ok(page.indexOf(`invitation.purpose === "ROLE_PRESET"`) < page.indexOf("<InviteAcceptForm"));
  const failure = await loadTsModule("src/lib/staff/inviteAuthFailure.ts");
  assert.equal(failure.invitationRoleAccepted({ role: "INSTRUCTOR", purpose: "ROLE_PRESET" }), false);
  assert.equal(failure.invitationRoleAccepted({ role: "INSTRUCTOR", purpose: "SIGNUP" }), true, "재입사·전환 초대는 그대로");
  const invite = read("src/app/actions/invite.ts");
  assert.match(invite, /if \(invitation\.purpose === "ROLE_PRESET"\) return "이 초대는 학부모와 같은 가입 화면에서/);
  const accept = invite.slice(invite.indexOf("export async function acceptInvitation"));
  assert.match(accept, /AND COALESCE\(purpose, 'SIGNUP'\) <> 'ROLE_PRESET'/);
  // 조회 두 곳(목록·토큰)이 ROLE_PRESET 을 SIGNUP 으로 뭉개지 않는다
  const queries = read("src/lib/queries.ts");
  assert.equal((queries.match(/purpose: normalizeStaffInvitationPurpose\(r\.purpose\)/g) ?? []).length, 2);
});

test("가입 화면: 초대 안내에서 오면 역할을 미리 고르고, 미리 붙인 역할 안내 문구", () => {
  const client = read("src/components/auth/ParentSignupClient.tsx");
  assert.match(client, /searchParams\.get\("staffRole"\)/);
  assert.match(client, /presetStaffRole === "INSTRUCTOR" \|\| presetStaffRole === "DRIVER"/);
  assert.match(client, /원장님이 이 번호로 미리 초대해 두셨다면/);
  assert.match(client, /로그인은 휴대폰 번호가 아니라 여기서 정한 아이디나 간편로그인으로 해요/);
});

test("퇴사 처리: 대상 기록 초대에 더해 그 번호의 대기 중 ROLE_PRESET 도 같은 거래에서 취소", () => {
  const body = fnBody(admin, "retireStaffMember");
  assert.match(body, /"targetUserId" = \$1 AND status IN \('PENDING', 'PROCESSING'\)/);
  assert.match(body, /WHERE purpose = 'ROLE_PRESET' AND phone = \$1 AND status = 'PENDING'/);
  assert.ok(body.indexOf("purpose = 'ROLE_PRESET'") < body.indexOf("'STAFF_RETIRED'"), "감사 기록 전(같은 거래)");
  assert.match(body, /const invites = targetedInvites \+ presetInvites;/);
});

test("추가 역할 직원 역할 바꾸기: 원장만·한 거래(잠금 → 회수 → 열기 → 코치 해제 → 감사)·자기 자신 금지", () => {
  const body = fnBody(admin, "changeStaffGrantRole");
  assert.match(body, /const owner = await requireOwner\(\)/);
  assert.match(body, /targetId === owner\.appUserId/);
  const lock = body.indexOf(`WHERE id = $1 AND role = 'PARENT' AND "withdrawnAt" IS NULL FOR UPDATE`);
  const revoke = body.indexOf(`SET status = 'REVOKED'`);
  const open = body.indexOf(`VALUES ($1, $2, 'ACTIVE', 'ADMIN'`);
  const audit = body.indexOf("'STAFF_GRANT_ROLE_CHANGED'");
  assert.ok(lock > 0 && revoke > lock && open > revoke && audit > open);
  assert.match(body, /newRole === "INSTRUCTOR"\s*\?\s*\[\]\s*:\s*await tx\.\$queryRawUnsafe/);
  const client = read("src/app/admin/staff/StaffClient.tsx");
  assert.match(client, /function buildGrantActions[\s\S]*?if \(!canManage \|\| grantUser\.id === currentUserId\) return \[\];/);
  assert.match(client, /await retireStaffMember\(grantUser\.id\)/);
  assert.match(client, /await changeStaffGrantRole\(grantUser\.id, nextRole\)/);
  // 대기 표시: 미리 붙이기는 만료일
  assert.match(client, /row\.invite\.purpose === "ROLE_PRESET"[\s\S]{0,200}가입 대기 · \{kstLabel\(row\.invite\.expiresAt\)\}까지/);
});

test("주 역할만 보던 곳: 기사 연락처·배차 기사 확인도 승인된 추가 역할을 본다", () => {
  const contact = read("src/lib/shuttle/parent.ts");
  assert.match(contact, /u\.role = 'DRIVER' OR EXISTS \(SELECT 1 FROM "UserRoleGrant" g WHERE g\."userId" = u\.id AND g\.role = 'DRIVER' AND g\.status = 'ACTIVE'\)/);
  const route = read("src/lib/regular/regularDispatchRoute.ts");
  assert.match(route, /u\.role='DRIVER' OR EXISTS \(SELECT 1 FROM "UserRoleGrant" g WHERE g\."userId"=u\.id AND g\.role='DRIVER' AND g\.status='ACTIVE'\)/);
});
