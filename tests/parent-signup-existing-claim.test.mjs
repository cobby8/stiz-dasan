import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

/**
 * 회원가입 → 기존 빈 보호자 계정 활성화 넘기기 회귀 테스트.
 *
 * 위험은 하나다 — **문자 인증 없이 남의 빈 계정이 넘어가는 것.** 그래서
 * resolveVerifiedSignupPhone / startParentSignup 을 가짜 prisma 로 **실제로 실행**해서
 * "증표가 틀리면 아무것도 안 쓴다", "빈 계정이 여러 개면 아무것도 안 고른다"를 직접 센다.
 */

const SIGNUP_SECRET = "development-only-parent-signup-secret";
const TOKEN = "t".repeat(43);
const PROOF = "p".repeat(43);
const PHONE = "01012345678";

const sha = (value) => createHash("sha256").update(value).digest("hex");
const keyed = (value) => createHmac("sha256", SIGNUP_SECRET).update(value).digest("hex");
const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

async function transpile(file) {
  const code = await readFile(file, "utf8");
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/import\s+["']server-only["'];?/g, "");
}

/** 가짜 DB 상태를 받아 두 모듈(가입 인증 + 계정 활성화)을 엮어 올린다. */
async function load(db) {
  globalThis.__signupDb = db;
  globalThis.__signupCalls = [];
  const prismaStub = toDataUrl(`
    const db = () => globalThis.__signupDb;
    const calls = () => globalThis.__signupCalls;
    async function query(sql, ...args) {
      calls().push({ kind: "query", sql, args });
      if (/FROM "ParentSignupVerification" WHERE "tokenHash"/.test(sql)) return db().verification ? [db().verification] : [];
      if (/role::text AS role, email, "authUserId" FROM "User"/.test(sql)) return db().users;
      if (/SELECT id, email, phone, "authUserId" FROM "User" WHERE id = \\$1/.test(sql)) return db().users.filter((u) => u.id === args[0] && u.role === "PARENT");
      if (/COUNT\\(\\*\\)::int AS count FROM "User"/.test(sql)) return [{ count: db().users.filter((u) => u.role === "PARENT").length }];
      if (/COUNT\\(\\*\\)::int AS count FROM "ParentSignupVerification"/.test(sql)) return [{ count: 0 }];
      if (/SELECT EXISTS\\(/.test(sql)) return [{ found: Boolean(db().oauthCollision) }];
      return [];
    }
    async function execute(sql, ...args) {
      calls().push({ kind: "execute", sql, args });
      if (db().failClaimInsert && /INSERT INTO "ParentAccountClaim"/.test(sql)) throw new Error('duplicate key value violates unique constraint "ParentAccountClaim_tokenHash_key"');
      if (db().failPurge && /DELETE FROM "ParentSignupVerification"/.test(sql)) throw new Error("purge failed");
      return 1;
    }
    const client = { $queryRawUnsafe: query, $executeRawUnsafe: execute };
    export const prisma = { ...client, $transaction: async (fn) => fn(client) };
  `);
  const noop = toDataUrl(`
    export async function sendAuthenticationSms() { return true; }
    export function createAdminClient() { throw new Error("이 테스트에서 Supabase 를 부르면 안 된다"); }
    export async function linkEnrollmentAccount() {}
  `);
  const authRoutes = toDataUrl(await transpile("src/lib/auth-routes.ts"));
  const syntheticEmail = toDataUrl(await transpile("src/lib/parent-synthetic-email.ts"));
  const publicErrors = toDataUrl(await transpile("src/lib/user-facing-error.ts"));
  // 동의 버전·약한 비밀번호 판정(순수 모듈, 2026-11-13) — 원본 그대로 엮는다
  const consent = toDataUrl(await transpile("src/lib/parent-consent.ts"));
  const inviteAuthFailure = toDataUrl(await transpile("src/lib/staff/inviteAuthFailure.ts"));
  const passwordRules = toDataUrl((await transpile("src/lib/parent-password-rules.ts"))
    .split('"@/lib/staff/inviteAuthFailure"').join(`"${inviteAuthFailure}"`));
  // 아이디 규칙(순수 모듈, 2026-11-13 f7) — 가입·활성화가 같이 쓴다
  const username = toDataUrl(await transpile("src/lib/parent-username.ts"));
  // 본인인증 실명·시각 규칙(순수 모듈, 2026-11-18) — 원본 그대로 엮는다
  const verifiedIdentity = toDataUrl(await transpile("src/lib/identity/verified-identity.ts"));
  // 미리 붙인 역할 적용(2026-11-18 5단계)은 tests/staff-role-preset.test.mjs 가 따로 실행 검증한다 — 여기서는 «붙일 것 없음»
  const rolePreset = toDataUrl(`export async function applyRolePresetsForUser() { return []; }`);
  const rolePresetNotify = toDataUrl(`export async function notifyRolePresetOutcomes() {}`);
  const swap = (code) => code
    .split('"@/lib/staff/rolePreset"').join(`"${rolePreset}"`)
    .split('"@/lib/staff/rolePresetNotify"').join(`"${rolePresetNotify}"`)
    .split('"@/lib/identity/verified-identity"').join(`"${verifiedIdentity}"`)
    .split('"@/lib/parent-username"').join(`"${username}"`)
    .split('"@/lib/user-facing-error"').join(`"${publicErrors}"`)
    .split('"@/lib/parent-synthetic-email"').join(`"${syntheticEmail}"`)
    .split('"@/lib/prisma"').join(`"${prismaStub}"`)
    .split('"@/lib/message-dispatch"').join(`"${noop}"`)
    .split('"@/lib/supabase/admin"').join(`"${noop}"`)
    .split('"@/lib/enrollment-account-handoff"').join(`"${noop}"`)
    .split('"@/lib/auth-routes"').join(`"${authRoutes}"`)
    .split('"@/lib/parent-consent"').join(`"${consent}"`)
    .split('"@/lib/parent-password-rules"').join(`"${passwordRules}"`);
  const claimUrl = toDataUrl(swap(await transpile("src/lib/parent-account-claim.ts")));
  const signup = swap(await transpile("src/lib/parent-signup-verification.ts"))
    .split('"@/lib/parent-account-claim"').join(`"${claimUrl}"`);
  return import(toDataUrl(signup));
}

function verifiedRow(overrides = {}) {
  return {
    id: "verification-1", username: null, name: null, phone: PHONE, phoneHash: "h".repeat(64),
    signupMethod: "PASSWORD", email: null, pendingAuthUserId: null, status: "VERIFIED",
    expiresAt: new Date(Date.now() + 60_000), otpHash: null, otpExpiresAt: null, otpAttempts: 0, lockedAt: null,
    proofHash: keyed(`proof:${sha(TOKEN)}:${PROOF}`), proofExpiresAt: new Date(Date.now() + 60_000),
    ...overrides,
  };
}

const synthetic = (id, extra = {}) => ({ id, role: "PARENT", email: `parent_${id.replace(/\D/g, "") || 1}@stiz.local`, authUserId: null, phone: PHONE, ...extra });
const writes = () => globalThis.__signupCalls.filter((c) => c.kind === "execute" && !/pg_advisory_xact_lock/.test(c.sql));

test("빈 보호자 계정 1개 → 문자 인증이 끝난 활성화 링크를 만들고 가입 증표를 닫는다", async () => {
  const mod = await load({ verification: verifiedRow(), users: [synthetic("p1")] });
  const result = await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF, redirectPath: "/mypage/kakao-connect?token=abc" });
  assert.equal(result.kind, "ACTIVATE_EXISTING");
  assert.match(result.activationUrl, /^\/account\/activate\?token=/);
  const insert = writes().find((c) => /INSERT INTO "ParentAccountClaim"/.test(c.sql));
  assert.ok(insert, "활성화 레코드를 만들어야 한다");
  assert.match(insert.sql, /'VERIFIED'/);
  assert.equal(insert.args[0], "p1");
  assert.equal(insert.args.at(-3), "/mypage/kakao-connect?token=abc", "카카오 연결 화면으로 돌아오는 경로를 유지한다");
  assert.ok(writes().some((c) => /UPDATE "ParentSignupVerification" SET status='CONSUMED'/.test(c.sql)));
  assert.ok(!writes().some((c) => /UPDATE "User"/.test(c.sql)), "비밀번호 활성화는 여기서 User 를 바꾸지 않는다");
});

test("운영에 실제로 있는 빈 계정 형식(parent_<숫자>_<숫자>@ 등)도 활성화로 넘어간다", async () => {
  for (const email of ["parent_1759900000000_12@stiz.local", "rallyz-parent-3f2a9c1e-7b4d-4e2a-9c1e-7b4d4e2a9c1e@stiz.local", "010-1234-5678@import.local"]) {
    const mod = await load({ verification: verifiedRow(), users: [synthetic("p1", { email })] });
    const result = await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF });
    assert.equal(result.kind, "ACTIVATE_EXISTING", email);
  }
  // team_ 계정은 활성화 대상이 아니다 → 로그인 계정이 있는 번호와 똑같이 기존 안내
  const team = await load({ verification: verifiedRow(), users: [synthetic("p1", { email: "team_abc123@stiz.local" })] });
  assert.equal((await team.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF })).kind, "REGISTERED");
});

test("내부 오류 원문은 화면에 내보내지 않는다", async () => {
  // 활성화 레코드 INSERT 단계에서 DB 오류(영문 원문)가 났다고 가정
  const mod = await load({ verification: verifiedRow(), users: [synthetic("p1")], failClaimInsert: true });
  const result = await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF });
  assert.deepEqual(result, { error: "처리 중 문제가 생겼어요. 잠시 후 다시 시도해 주세요." });

  // 직접 정해 둔 안내(증표 만료 등)는 그대로 보여 준다
  const expired = await load({ verification: verifiedRow({ proofExpiresAt: new Date(Date.now() - 1000) }), users: [synthetic("p1")] });
  assert.deepEqual(await expired.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF }), { error: "휴대폰 인증 증표가 없거나 만료되었습니다." });
});

test("허용되지 않은 redirect 는 학부모 기본 화면으로 바뀐다", async () => {
  const mod = await load({ verification: verifiedRow(), users: [synthetic("p1")] });
  await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF, redirectPath: "https://evil.example/x" });
  const insert = writes().find((c) => /INSERT INTO "ParentAccountClaim"/.test(c.sql));
  assert.equal(insert.args.at(-3), "/mypage");
});

test("증표가 틀리면 아무것도 쓰지 않는다(문자 인증 없이는 계정이 넘어가지 않는다)", async () => {
  const mod = await load({ verification: verifiedRow(), users: [synthetic("p1")] });
  const result = await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: "x".repeat(43) });
  assert.ok("error" in result && !("kind" in result));
  assert.deepEqual(writes(), []);
});

test("인증이 아직 VERIFIED 가 아니면 아무것도 쓰지 않는다", async () => {
  const mod = await load({ verification: verifiedRow({ status: "PENDING" }), users: [synthetic("p1")] });
  const result = await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF });
  assert.ok("error" in result);
  assert.deepEqual(writes(), []);
});

test("같은 번호의 빈 계정이 여러 개면 자동으로 고르지 않고 학원 문의로 멈춘다", async () => {
  const mod = await load({ verification: verifiedRow(), users: [synthetic("p1"), synthetic("p2")] });
  const result = await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF });
  assert.equal(result.kind, "CONTACT_ACADEMY");
  assert.match(result.error, /학원에 문의/);
  assert.deepEqual(writes(), []);
});

test("로그인 계정이 있는 번호는 기존처럼 로그인/계정 찾기 안내", async () => {
  const mod = await load({ verification: verifiedRow(), users: [synthetic("p1", { authUserId: "auth-1" })] });
  const result = await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF });
  assert.equal(result.kind, "REGISTERED");
  assert.match(result.error, /이미 가입된 휴대폰 번호입니다/);
  assert.deepEqual(writes(), []);
});

test("처음 보는 번호는 지금처럼 신규 가입으로 이어진다", async () => {
  const mod = await load({ verification: verifiedRow(), users: [] });
  const result = await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF });
  assert.equal(result.kind, "NEW_SIGNUP");
  assert.deepEqual(writes(), []);
});

test("간편가입 세션이 그대로면 그 계정을 빈 계정에 연결한다(같은 사용자·같은 제공자만)", async () => {
  const row = verifiedRow({ signupMethod: "KAKAO", pendingAuthUserId: "oauth-1" });
  const mod = await load({ verification: row, users: [synthetic("p1")] });
  const linked = await mod.resolveVerifiedSignupPhone({
    token: TOKEN, proof: PROOF, redirectPath: "/mypage",
    authenticatedOAuthUser: { id: "oauth-1", email: "Mom@Example.com", provider: "kakao" },
  });
  assert.equal(linked.kind, "LINKED_EXISTING");
  const update = writes().find((c) => /UPDATE "User" SET "authUserId"/.test(c.sql));
  assert.ok(update);
  assert.match(update.sql, /"authUserId" IS NULL/);
  assert.match(update.sql, /"phoneVerifiedAt" = NOW\(\)/);
  assert.deepEqual(update.args.slice(0, 3), ["oauth-1", "Mom@Example.com", "p1"]);
  assert.ok(!writes().some((c) => /INSERT INTO "ParentAccountClaim"/.test(c.sql)));

  // 다른 간편로그인 사용자(세션이 바뀜)·다른 제공자면 연결하지 않고 비밀번호 활성화로 보낸다
  for (const oauth of [
    { id: "oauth-OTHER", email: "x@example.com", provider: "kakao" },
    { id: "oauth-1", email: "x@example.com", provider: "google" },
  ]) {
    const again = await load({ verification: row, users: [synthetic("p1")] });
    const result = await again.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF, authenticatedOAuthUser: oauth });
    assert.equal(result.kind, "ACTIVATE_EXISTING", JSON.stringify(oauth));
    assert.ok(!writes().some((c) => /UPDATE "User"/.test(c.sql)));
  }
});

test("간편로그인 계정이 이미 다른 앱 계정과 겹치면 연결하지 않는다", async () => {
  const row = verifiedRow({ signupMethod: "KAKAO", pendingAuthUserId: "oauth-1" });
  const mod = await load({ verification: row, users: [synthetic("p1")], oauthCollision: true });
  const result = await mod.resolveVerifiedSignupPhone({
    token: TOKEN, proof: PROOF, authenticatedOAuthUser: { id: "oauth-1", email: "a@b.c", provider: "kakao" },
  });
  assert.equal(result.kind, "ACTIVATE_EXISTING");
  assert.ok(!writes().some((c) => /UPDATE "User"/.test(c.sql)));
});

test("가입 시작: 빈 계정 번호는 신규 번호와 똑같이 문자를 보내고, 로그인 계정 번호만 거절한다", async () => {
  const fresh = await load({ verification: null, users: [] });
  const freshResult = await fresh.startParentSignup({ phone: PHONE });
  assert.ok(freshResult.ok);

  const claimable = await load({ verification: null, users: [synthetic("p1")] });
  const claimableResult = await claimable.startParentSignup({ phone: PHONE });
  assert.ok(claimableResult.ok, "빈 계정 번호라는 사실을 인증 전에 드러내지 않는다");
  assert.deepEqual(Object.keys(claimableResult).sort(), Object.keys(freshResult).sort());

  const multiple = await load({ verification: null, users: [synthetic("p1"), synthetic("p2")] });
  assert.ok((await multiple.startParentSignup({ phone: PHONE })).ok);

  const registered = await load({ verification: null, users: [synthetic("p1", { authUserId: "auth-1" })] });
  assert.match((await registered.startParentSignup({ phone: PHONE })).error, /이미 가입된 휴대폰 번호입니다/);

  // 직원 계정 번호도 지금처럼 거절(빈 학부모 계정만 활성화 대상)
  const staff = await load({ verification: null, users: [{ id: "s1", role: "INSTRUCTOR", email: "coach@stiz.kr", authUserId: null }] });
  assert.match((await staff.startParentSignup({ phone: PHONE })).error, /이미 가입된 휴대폰 번호입니다/);
});

test("화면·API 계약: 인증 통과 뒤에만 안내하고, 활성화 증표는 httpOnly 쿠키로 넘긴다", async () => {
  const route = await readFile("src/app/api/auth/parent-signup/verify-otp/route.ts", "utf8");
  const ui = await readFile("src/components/auth/ParentSignupClient.tsx", "utf8");
  const page = await readFile("src/app/account/activate/page.tsx", "utf8");
  assert.ok(route.indexOf("verifyParentSignupOtp(") < route.indexOf("resolveVerifiedSignupPhone("), "OTP 확인이 먼저다");
  assert.match(route, /httpOnly: true/);
  assert.match(route, /parentClaimProofCookieName\(handoff\.claimToken\)/);
  assert.match(ui, /이미 학원에 등록된 보호자입니다/);
  assert.match(ui, /searchParams\.get\("existing"\) === "1"/);
  assert.match(page, /status === "VERIFIED" && hasProofCookie/);
});

// ── 2026-11-18 본인인증 실명·시각 저장 (원장 결정 «가입·본인인증 통일») ─────────────────
// 본인인증(IDENTITY)으로 통과한 가입 요청만 실명·시각을 User 에 옮긴다. 문자 인증(SMS)은 번호만 확인하므로 적지 않는다.
const identityWrites = () => writes().filter((c) => /"identityVerifiedName" = \$2/.test(c.sql));
const VERIFIED_AT = new Date("2026-11-18T05:00:00.000Z");

test("본인인증 가입 요청 + 간편가입 세션 → 빈 계정 연결과 같은 거래에서 실명·시각을 적는다", async () => {
  const row = verifiedRow({ signupMethod: "KAKAO", pendingAuthUserId: "oauth-1", verificationMethod: "IDENTITY", verifiedName: " 김 엄마 ", verifiedAt: VERIFIED_AT });
  const mod = await load({ verification: row, users: [synthetic("p1")] });
  const linked = await mod.resolveVerifiedSignupPhone({
    token: TOKEN, proof: PROOF, authenticatedOAuthUser: { id: "oauth-1", email: "mom@example.com", provider: "kakao" },
  });
  assert.equal(linked.kind, "LINKED_EXISTING");
  const [write] = identityWrites();
  assert.ok(write, "실명을 적어야 한다");
  assert.deepEqual(write.args, ["p1", "김 엄마", VERIFIED_AT]);
  assert.match(write.sql, /"withdrawnAt" IS NULL/);
});

test("본인인증 가입 요청 → 활성화 링크 «발급» 때는 User 에 적지 않고 증표에만 실명·시각을 싣는다(검수 N-2)", async () => {
  const row = verifiedRow({ verificationMethod: "IDENTITY", verifiedName: "김엄마", verifiedAt: VERIFIED_AT });
  const mod = await load({ verification: row, users: [synthetic("p1")] });
  const result = await mod.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF });
  assert.equal(result.kind, "ACTIVATE_EXISTING");
  assert.deepEqual(identityWrites(), [], "활성화를 끝내기 전에는 그 계정에 실명이 남지 않는다");
  const insert = writes().find((c) => /INSERT INTO "ParentAccountClaim"/.test(c.sql));
  assert.match(insert.sql, /"verifiedName", "identityVerifiedAt"/);
  assert.deepEqual(insert.args.slice(-2), ["김엄마", VERIFIED_AT]);
  // 문자 인증이면 증표에도 싣지 않는다
  const sms = await load({ verification: verifiedRow({ verificationMethod: "SMS", verifiedName: "김엄마", verifiedAt: VERIFIED_AT }), users: [synthetic("p1")] });
  await sms.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF });
  assert.deepEqual(writes().find((c) => /INSERT INTO "ParentAccountClaim"/.test(c.sql)).args.slice(-2), [null, null]);
});

test("문자 인증(SMS) 가입 요청은 이름이 적혀 있어도 실명을 User 에 적지 않는다(연결·활성화 둘 다)", async () => {
  const sms = { verificationMethod: "SMS", verifiedName: "누군가", verifiedAt: VERIFIED_AT };
  const link = await load({ verification: verifiedRow({ signupMethod: "KAKAO", pendingAuthUserId: "oauth-1", ...sms }), users: [synthetic("p1")] });
  assert.equal((await link.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF, authenticatedOAuthUser: { id: "oauth-1", email: "a@b.c", provider: "kakao" } })).kind, "LINKED_EXISTING");
  assert.deepEqual(identityWrites(), []);
  const activate = await load({ verification: verifiedRow(sms), users: [synthetic("p1")] });
  assert.equal((await activate.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF })).kind, "ACTIVATE_EXISTING");
  assert.deepEqual(identityWrites(), []);
  // 예전 줄(방식 칸 없음)도 같다
  const legacy = await load({ verification: verifiedRow(), users: [synthetic("p1")] });
  await legacy.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF });
  assert.deepEqual(identityWrites(), []);
});

test("문자 인증 가입 시작은 방식 'SMS' 로 남기고, 7일 뒤 정리에서 실명 칸도 비운다", async () => {
  const mod = await load({ verification: null, users: [] });
  assert.ok((await mod.startParentSignup({ phone: PHONE })).ok);
  const insert = writes().find((c) => /INSERT INTO "ParentSignupVerification"/.test(c.sql));
  assert.match(insert.sql, /"verificationMethod"/);
  assert.match(insert.sql, /'PENDING','SMS'/);
  const cleanup = writes().find((c) => /WHERE status='CONSUMED' AND "createdAt" < NOW\(\) - INTERVAL '7 days'/.test(c.sql));
  assert.match(cleanup.sql, /"verifiedName"=NULL/);
});

test("검수 N-3: 본인인증 가입 요청 발급도 문자 가입 시작과 같은 7일 정리를 같은 거래에서 돌린다", async () => {
  const cleanup = (list) => ({
    remove: list.find((c) => /DELETE FROM "ParentSignupVerification"\s+WHERE status <> 'CONSUMED' AND "createdAt" < NOW\(\) - INTERVAL '7 days'/.test(c.sql)),
    blank: list.find((c) => /WHERE status='CONSUMED' AND "createdAt" < NOW\(\) - INTERVAL '7 days'/.test(c.sql) && /"verifiedName"=NULL/.test(c.sql)),
    claims: list.find((c) => /UPDATE "ParentAccountClaim" SET "verifiedName"=NULL, "identityVerifiedAt"=NULL/.test(c.sql) && /"expiresAt" < NOW\(\)/.test(c.sql)),
  });
  const viaIdentity = await load({ verification: null, users: [] });
  const issued = await viaIdentity.issueIdentityVerifiedSignup({ phone: PHONE, signupMethod: "KAKAO", pendingAuthUserId: "oauth-1", verifiedName: "김엄마", verifiedAt: VERIFIED_AT });
  assert.ok(issued.ok, JSON.stringify(issued));
  const a = cleanup(writes());
  assert.ok(a.remove && a.blank && a.claims, "본인인증 발급 거래에 정리 3줄이 모두 있다");
  // 정리가 새 줄 INSERT 보다 먼저
  const list = writes();
  assert.ok(list.indexOf(a.blank) < list.findIndex((c) => /INSERT INTO "ParentSignupVerification"/.test(c.sql)));

  const viaSms = await load({ verification: null, users: [] });
  assert.ok((await viaSms.startParentSignup({ phone: PHONE })).ok);
  const b = cleanup(writes());
  assert.ok(b.remove && b.blank && b.claims, "문자 가입 시작도 같은 정리");
  // 두 길이 «같은 SQL»(함수 하나)을 쓴다
  assert.equal(a.blank.sql, b.blank.sql);
  assert.equal(a.claims.sql, b.claims.sql);
});

test("4단계 A: 아이디 가입(PASSWORD)도 본인인증 가입 요청을 만든다 — 간편로그인 사용자·이메일 없이, 실명·시각은 싣는다", async () => {
  const mod = await load({ verification: null, users: [] });
  const issued = await mod.issueIdentityVerifiedSignup({ phone: "010-1234-5678", signupMethod: "PASSWORD", verifiedName: " 김 엄마 ", verifiedAt: VERIFIED_AT });
  assert.ok(issued.ok, JSON.stringify(issued));
  const insert = writes().find((c) => /INSERT INTO "ParentSignupVerification"/.test(c.sql));
  assert.match(insert.sql, /'VERIFIED','IDENTITY'/);
  // 인자: id, tokenHash, phone, phoneHash, signupMethod, email, pendingAuthUserId, proofHash, verifiedName, verifiedAt
  assert.equal(insert.args[2], PHONE);
  assert.equal(insert.args[4], "PASSWORD");
  assert.equal(insert.args[5], null, "아이디 가입은 이메일을 싣지 않는다");
  assert.equal(insert.args[6], null, "아이디 가입은 간편로그인 사용자가 없다");
  assert.deepEqual(insert.args.slice(-2), ["김 엄마", VERIFIED_AT]);
  // 증표는 그 토큰으로만 열린다(문자 인증 증표와 같은 규칙)
  assert.equal(insert.args[7], keyed(`proof:${sha(issued.token)}:${issued.proof}`));
  // 간편가입은 지금처럼 간편로그인 사용자가 있어야 한다
  const social = await load({ verification: null, users: [] });
  assert.match((await social.issueIdentityVerifiedSignup({ phone: PHONE, signupMethod: "KAKAO", verifiedName: "김엄마", verifiedAt: VERIFIED_AT })).error, /간편가입 계정/);
  assert.ok(!writes().some((c) => /INSERT INTO "ParentSignupVerification"/.test(c.sql)));
  // 모르는 방법은 거절
  const odd = await load({ verification: null, users: [] });
  assert.ok("error" in await odd.issueIdentityVerifiedSignup({ phone: PHONE, signupMethod: "EMAIL", verifiedName: "김엄마", verifiedAt: VERIFIED_AT }));
});

test("4단계 A·B: 본인인증 아이디 가입 → 처음 번호면 계정 정보로, 학원이 등록한 빈 계정 1개면 활성화(실명은 증표에만), 로그인 계정이 있는 번호면 거절", async () => {
  const fresh = await load({ verification: verifiedRow({ verificationMethod: "IDENTITY", verifiedName: "김엄마", verifiedAt: VERIFIED_AT }), users: [] });
  assert.equal((await fresh.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF, authenticatedOAuthUser: null })).kind, "NEW_SIGNUP");
  const claim = await load({ verification: verifiedRow({ verificationMethod: "IDENTITY", verifiedName: "김엄마", verifiedAt: VERIFIED_AT }), users: [synthetic("p1")] });
  const activation = await claim.resolveVerifiedSignupPhone({ token: TOKEN, proof: PROOF, authenticatedOAuthUser: null });
  assert.equal(activation.kind, "ACTIVATE_EXISTING");
  assert.deepEqual(identityWrites(), [], "활성화를 끝내기 전에는 User 에 실명을 적지 않는다");
  assert.deepEqual(writes().find((c) => /INSERT INTO "ParentAccountClaim"/.test(c.sql)).args.slice(-2), ["김엄마", VERIFIED_AT]);
  // 로그인 수단이 있는 번호: 발급 단계에서 거절(가입 요청을 만들지 않는다) — 화면은 «아이디·비밀번호 찾기»
  const registered = await load({ verification: null, users: [{ id: "u1", role: "PARENT", email: "mom@member.stiz.kr", authUserId: "auth-1", phone: PHONE }] });
  const refused = await registered.issueIdentityVerifiedSignup({ phone: PHONE, signupMethod: "PASSWORD", verifiedName: "김엄마", verifiedAt: VERIFIED_AT });
  assert.match(refused.error, /이미 가입된 휴대폰 번호/);
  assert.ok(!writes().some((c) => /INSERT INTO "ParentSignupVerification"/.test(c.sql)));
});

test("4단계 D: 매일 정리(runSignupPersonalDataPurge)는 가입 시작과 같은 정리 SQL 을 돌리고, 실패해도 예외를 던지지 않는다", async () => {
  const mod = await load({ verification: null, users: [] });
  assert.equal(await mod.runSignupPersonalDataPurge(), true);
  const list = writes();
  assert.ok(list.some((c) => /DELETE FROM "ParentSignupVerification"/.test(c.sql)));
  assert.ok(list.some((c) => /"verifiedName"=NULL/.test(c.sql)));
  assert.ok(list.some((c) => /UPDATE "ParentAccountClaim" SET "verifiedName"=NULL/.test(c.sql)));
  const broken = await load({ verification: null, users: [], failPurge: true });
  globalThis.__signupDb.failPurge = true;
  const originalError = console.error; console.error = () => {};
  try { assert.equal(await broken.runSignupPersonalDataPurge(), false); } finally { console.error = originalError; }
});
