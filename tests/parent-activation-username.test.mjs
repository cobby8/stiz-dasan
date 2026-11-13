// 기존 학부모 계정 활성화 = 신규 가입과 같은 «아이디 + 8자 비밀번호»(2026-11-13 f7 원장 점검표).
//
// consumeParentAccountClaim 을 가짜 DB·가짜 Supabase 로 «실제로 실행»해서 센다:
// - 로그인 계정(Supabase)은 신규 가입과 같은 매핑(아이디@member.stiz.kr)으로 만든다
// - 앱 계정(User)에 username 도 함께 적는다(로그인 화면이 username → email 로 찾는다)
// - 아이디 형식·8자·아이디 중복은 계정을 만들기 «전에» 막는다(Supabase 를 부르지 않음)
// - 예전 «이메일 + 10자» 입력은 더 이상 받지 않는다
// ⚠️ 문자·운영 DB 를 절대 건드리지 않는다(모든 외부 호출은 가짜).
import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const CLAIM_SECRET = "development-only-parent-account-claim-secret";
const TOKEN = "t".repeat(43);
const PROOF = "p".repeat(43);
const ALL_CONSENTS = { terms: true, privacy: true, age: true };

const sha = (value) => createHash("sha256").update(value).digest("hex");
const keyed = (value) => createHmac("sha256", CLAIM_SECRET).update(value).digest("hex");
const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;

async function transpile(file) {
  const code = await readFile(file, "utf8");
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText.replace(/import\s+["']server-only["'];?/g, "");
}

function claimRow() {
  const future = new Date(Date.now() + 60 * 60_000);
  return {
    id: "claim-1", parentId: "parent-1", phone: "010-1234-5678", email: "parent_1@stiz.local",
    status: "VERIFIED", expiresAt: future, otpHash: null, otpExpiresAt: null, otpAttempts: 0, lockedAt: null,
    verifiedAt: new Date(), proofHash: keyed(`proof:${sha(TOKEN)}:${PROOF}`), proofExpiresAt: future,
    redirectPath: "/mypage", processingAt: null, processingAttemptId: null,
  };
}

/** 가짜 DB·Supabase 를 엮어 parent-account-claim 을 올린다 */
async function load(state) {
  globalThis.__claimState = state;
  state.calls = [];
  state.created = [];
  const prismaStub = toDataUrl(`
    const st = () => globalThis.__claimState;
    async function query(sql, ...args) {
      st().calls.push({ kind: "query", sql, args });
      if (/FROM "ParentAccountClaim" c JOIN "User" u/.test(sql)) return [st().claim];
      if (/COUNT\\(\\*\\)::int AS count FROM "User"/.test(sql)) return [{ count: 1 }];
      if (/LOWER\\(COALESCE\\(username, ''\\)\\) = LOWER\\(\\$1\\)/.test(sql)) return st().usernameTaken ? [{ id: "someone-else" }] : [];
      if (/SELECT "authUserId" FROM "User" WHERE id = \\$1 FOR UPDATE/.test(sql)) return [{ authUserId: null }];
      return [];
    }
    async function execute(sql, ...args) { st().calls.push({ kind: "execute", sql, args }); return 1; }
    const client = { $queryRawUnsafe: query, $executeRawUnsafe: execute };
    export const prisma = { ...client, $transaction: async (fn) => fn(client) };
  `);
  const supabaseStub = toDataUrl(`
    const st = () => globalThis.__claimState;
    export function createAdminClient() {
      return { auth: { admin: {
        createUser: async (input) => {
          st().created.push(input);
          if (st().authAlready) return { data: { user: null }, error: { message: "A user with this email address has already been registered", status: 422 } };
          return { data: { user: { id: "auth-new" } }, error: null };
        },
        deleteUser: async () => ({ error: null }),
        listUsers: async () => ({ data: { users: [] }, error: null }),
        updateUserById: async () => ({ error: null }),
      } } };
    }
  `);
  const noop = toDataUrl(`export async function sendAuthenticationSms() { throw new Error("문자를 보내면 안 된다"); }`);
  const inviteAuthFailure = toDataUrl(await transpile("src/lib/staff/inviteAuthFailure.ts"));
  const passwordRules = toDataUrl((await transpile("src/lib/parent-password-rules.ts"))
    .split('"@/lib/staff/inviteAuthFailure"').join(`"${inviteAuthFailure}"`));
  const map = {
    "@/lib/user-facing-error": toDataUrl(await transpile("src/lib/user-facing-error.ts")),
    "@/lib/prisma": prismaStub,
    "@/lib/message-dispatch": noop,
    "@/lib/supabase/admin": supabaseStub,
    "@/lib/auth-routes": toDataUrl(await transpile("src/lib/auth-routes.ts")),
    "@/lib/parent-synthetic-email": toDataUrl(await transpile("src/lib/parent-synthetic-email.ts")),
    "@/lib/parent-consent": toDataUrl(await transpile("src/lib/parent-consent.ts")),
    "@/lib/parent-password-rules": passwordRules,
    "@/lib/parent-username": toDataUrl(await transpile("src/lib/parent-username.ts")),
  };
  let code = await transpile("src/lib/parent-account-claim.ts");
  for (const [from, to] of Object.entries(map)) code = code.split(`"${from}"`).join(`"${to}"`);
  return import(toDataUrl(code));
}

const userUpdate = (state) => state.calls.find((c) => c.kind === "execute" && /UPDATE "User" SET email = \$1/.test(c.sql));

test("f7 활성화 성공: 로그인 계정은 신규 가입과 같은 «아이디@member.stiz.kr», 앱 계정에 아이디도 적는다", async () => {
  const state = { claim: claimRow() };
  const mod = await load(state);
  const result = await mod.consumeParentAccountClaim(TOKEN, PROOF, "  KimMom_1 ", "abcd1234!", ALL_CONSENTS);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.username, "kimmom_1");
  assert.equal(result.loginEmail, "kimmom_1@member.stiz.kr");
  // Supabase 계정 = 신규 가입과 같은 매핑 + 8자 비밀번호 그대로
  assert.equal(state.created.length, 1);
  assert.equal(state.created[0].email, "kimmom_1@member.stiz.kr");
  assert.equal(state.created[0].password, "abcd1234!");
  assert.equal(state.created[0].user_metadata.username, "kimmom_1");
  // 앱 계정: email = 로그인 메일, username = 아이디 (로그인 화면이 username → email 로 찾는다)
  const update = userUpdate(state);
  assert.ok(update, "User 갱신이 있어야 한다");
  assert.match(update.sql, /username = \$5/);
  assert.equal(update.args[0], "kimmom_1@member.stiz.kr");
  assert.equal(update.args[2], "parent_1@stiz.local", "빈 계정의 합성 이메일일 때만 바꾼다(동시 변경 방지 조건 유지)");
  assert.equal(update.args[4], "kimmom_1");
});

test("f7 활성화: 8자 비밀번호면 통과(예전 10자 기준 아님), 7자는 계정을 만들기 전에 막는다", async () => {
  const ok = { claim: claimRow() };
  assert.equal((await (await load(ok)).consumeParentAccountClaim(TOKEN, PROOF, "kimmom", "abcd123!", ALL_CONSENTS)).ok, true);
  const short = { claim: claimRow() };
  const result = await (await load(short)).consumeParentAccountClaim(TOKEN, PROOF, "kimmom", "abc123!", ALL_CONSENTS);
  assert.equal(result.error, "비밀번호는 8자 이상 입력해 주세요.");
  assert.equal(short.created.length, 0);
  assert.equal(short.calls.length, 0, "DB 도 건드리지 않는다");
});

test("f7 활성화: 이메일·규칙 밖 아이디는 신규 가입과 같은 안내로 거절(계정·DB 손대지 않음)", async () => {
  for (const bad of ["mom@example.com", "1mom", "ab", "kim mom", "김엄마", "a".repeat(21)]) {
    const state = { claim: claimRow() };
    const result = await (await load(state)).consumeParentAccountClaim(TOKEN, PROOF, bad, "abcd1234!", ALL_CONSENTS);
    assert.equal(result.error, "아이디는 영문 소문자로 시작하고 영문·숫자·밑줄 조합의 4~20자로 입력해 주세요.", bad);
    assert.equal(state.created.length, 0, bad);
    assert.equal(state.calls.length, 0, bad);
  }
});

test("f7 활성화: 다른 계정이 쓰는 아이디면 «이미 사용 중인 로그인 아이디»로 막고 로그인 계정을 만들지 않는다", async () => {
  const state = { claim: claimRow(), usernameTaken: true };
  const result = await (await load(state)).consumeParentAccountClaim(TOKEN, PROOF, "kimmom", "abcd1234!", ALL_CONSENTS);
  assert.equal(result.error, "이미 사용 중인 로그인 아이디입니다.");
  assert.equal(state.created.length, 0);
  // 중복 검사는 아이디(LOWER)와 로그인 메일 둘 다, 본인 행은 제외
  const check = state.calls.find((c) => /LOWER\(COALESCE\(username, ''\)\) = LOWER\(\$1\)/.test(c.sql));
  assert.deepEqual(check.args, ["kimmom", "kimmom@member.stiz.kr", "parent-1"]);
  assert.match(check.sql, /id <> \$3/);
});

test("f7 활성화: 중단된 이전 시도 없이 Supabase 가 «이미 있음»이면 «이미 사용 중인 로그인 아이디»로 안내하고 인증 상태로 되돌린다", async () => {
  const state = { claim: claimRow(), authAlready: true };
  const result = await (await load(state)).consumeParentAccountClaim(TOKEN, PROOF, "kimmom", "abcd1234!", ALL_CONSENTS);
  assert.equal(result.error, "이미 사용 중인 로그인 아이디입니다.");
  assert.equal(userUpdate(state), undefined, "앱 계정은 바꾸지 않는다");
  const rollback = state.calls.find((c) => c.kind === "execute" && /SET status = \$1, "processingAt" = NULL/.test(c.sql));
  assert.equal(rollback.args[0], "VERIFIED", "같은 인증으로 다른 아이디를 다시 정할 수 있다");
});

test("f7 활성화: 동의가 빠지면 아이디가 맞아도 만들지 않는다(기존 단계 유지)", async () => {
  const state = { claim: claimRow() };
  const result = await (await load(state)).consumeParentAccountClaim(TOKEN, PROOF, "kimmom", "abcd1234!", { terms: true, privacy: true, age: false });
  assert.ok(result.error);
  assert.equal(state.created.length, 0);
});

test("f7 공용 규칙 한 곳: 가입·활성화가 같은 아이디 모듈을 쓰고, 서버 액션은 활성화가 만든 로그인 메일로 로그인한다", async () => {
  const signup = await readFile("src/lib/parent-signup-verification.ts", "utf8");
  const claim = await readFile("src/lib/parent-account-claim.ts", "utf8");
  const action = await readFile("src/app/actions/parent-account.ts", "utf8");
  for (const source of [signup, claim]) {
    assert.match(source, /from "@\/lib\/parent-username"/);
    assert.match(source, /PARENT_USERNAME_PATTERN\.test\(username\)/);
    assert.match(source, /PARENT_PASSWORD_MIN/);
    // 아이디 정규식·로그인 메일 주소를 파일 안에 다시 적지 않는다
    assert.doesNotMatch(source, /\[a-z\]\[a-z0-9_\]\{3,19\}/);
    assert.doesNotMatch(source, /`\$\{[^}]+\}@member\.stiz\.kr`/);
  }
  assert.match(action, /signInWithPassword\(\{\s*email: result\.loginEmail,/);
  assert.doesNotMatch(action, /email\.trim\(\)\.toLowerCase\(\)/);
  // 하위호환: 로그인 화면은 «@» 든 값(예전 이메일 활성화 계정)을 그대로 로그인 메일로 쓴다
  const login = await readFile("src/app/actions/auth.ts", "utf8");
  assert.match(login, /else if \(!identifier\.includes\("@"\)\)/);
});

test("f7 공용 아이디 모듈 자체 — 정규화·매핑·규칙", async () => {
  const U = await import(toDataUrl(await transpile("src/lib/parent-username.ts")));
  assert.equal(U.normalizeParentUsername("  KimMom "), "kimmom");
  assert.equal(U.parentUsernameAuthEmail(" KimMom "), "kimmom@member.stiz.kr");
  assert.equal(U.isValidParentUsername("kim_mom1"), true);
  assert.equal(U.isValidParentUsername("Kim_Mom1"), true, "대문자는 소문자로 바꿔 판정");
  for (const bad of ["", "kim", "1kim", "kim-mom", "kim@mom.com", "a".repeat(21)]) assert.equal(U.isValidParentUsername(bad), false, bad);
});
