import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
import { loadTsModule } from "./_ts-module.mjs";

// 2026-11-18 원장 결정 «가입·본인인증 통일» 4단계 — 로그인 전(아이디 가입·기존 계정 활성화·아이디/비밀번호 찾기)에도
// 본인인증이 기본, 문자 인증은 샛길. 위험은 «남이 끝낸 본인인증 건 번호로 남의 계정을 찾거나 가입하는 것»과
// «같은 인증을 두 번 쓰는 것»이다. 판정 모듈을 가짜 DB·가짜 포트원으로 «실제로 실행»해서 센다.

process.env.PARENT_SIGNUP_SECRET ||= "test-anon-identity-secret";
const anon = await loadTsModule("src/lib/identity/anonymous-identity.ts");
const resume = await loadTsModule("src/lib/auth/signup-identity-resume.ts");
const resetRules = await loadTsModule("src/lib/identity/identity-reset-rules.ts");
const shuttlePhone = await loadTsModule("src/lib/enrollment/shuttle-child-phone.ts");
const read = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const NOW = Date.parse("2026-11-18T03:00:00.000Z");
const nonceA = "a".repeat(43);
const nonceB = "b".repeat(43);

/** 장부 표(IdentityVerificationStart)를 흉내 내는 가짜 DB — SQL 의 조건(1시간·하루·10분·미소진)을 그대로 계산한다 */
function fakeLedger({ now = () => NOW, preset = [] } = {}) {
  const rows = new Map(preset.map((row) => [row.id, { ...row }]));
  const calls = [];
  const within = (row, ms) => now() - row.createdAt < ms;
  return {
    rows,
    calls,
    async $queryRawUnsafe(sql, ...args) {
      calls.push({ kind: "query", sql, args });
      if (/AS hourly/.test(sql)) {
        const [requestHash] = args;
        const all = [...rows.values()];
        return [{
          hourly: all.filter((r) => r.requestHash === requestHash && within(r, 3600_000)).length,
          daily: all.filter((r) => r.requestHash === requestHash && within(r, 86400_000)).length,
          globalDaily: all.filter((r) => within(r, 86400_000)).length,
        }];
      }
      return [];
    },
    async $executeRawUnsafe(sql, ...args) {
      calls.push({ kind: "execute", sql, args });
      if (/^INSERT INTO "IdentityVerificationStart"/.test(sql)) {
        const [id, purpose, requestHash] = args;
        rows.set(id, { id, purpose, requestHash, createdAt: now(), consumedAt: null });
        return 1;
      }
      if (/^UPDATE "IdentityVerificationStart" SET "consumedAt"/.test(sql)) {
        const [id, purpose] = args;
        const ttl = Number(/INTERVAL '(\d+) seconds'/.exec(sql)[1]) * 1000;
        const row = rows.get(id);
        if (!row || row.purpose !== purpose || row.consumedAt || !within(row, ttl)) return 0;
        row.consumedAt = now();
        return 1;
      }
      return 0;
    },
  };
}

const verified = (overrides = {}) => async () => ({
  ok: true,
  data: {
    status: "VERIFIED",
    verifiedAt: new Date(NOW - 60_000).toISOString(),
    verifiedCustomer: { name: "김 수빈", phoneNumber: "010-1234-5678" },
    ...overrides,
  },
});

async function started(db, purpose = "SIGNUP", requestKey = "1.2.3.4") {
  const result = await anon.startAnonIdentity(db, { purpose, requestKey });
  assert.equal(result.ok, true);
  return result;
}

// ── 건 번호 표식 ─────────────────────────────────────────────────────────────
test("건 번호 표식: 이 브라우저 nonce·같은 목적일 때만 맞고, 위조·다른 nonce·다른 목적은 틀린다", () => {
  const id = anon.createAnonIdentityVerificationId("SIGNUP", nonceA);
  assert.match(id, /^stizanon_[0-9a-f]{20}_[A-Za-z0-9_-]{12}$/);
  assert.ok(id.length <= 64, "포트원 건 번호 길이 안");
  assert.equal(anon.isAnonIdentityVerificationIdFor(id, "SIGNUP", nonceA), true);
  assert.equal(anon.isAnonIdentityVerificationIdFor(id, "SIGNUP", nonceB), false, "남의 브라우저(다른 nonce)");
  assert.equal(anon.isAnonIdentityVerificationIdFor(id, "RESET", nonceA), false, "가입용 건 번호로 찾기 불가");
  const tampered = id.replace(/^stizanon_(.)/, (_, c) => `stizanon_${c === "0" ? "1" : "0"}`);
  assert.equal(anon.isAnonIdentityVerificationIdFor(tampered, "SIGNUP", nonceA), false, "표식 한 글자 위조");
  assert.equal(anon.isAnonIdentityVerificationIdFor(id, "SIGNUP", ""), false, "쿠키 없음");
  assert.equal(anon.isAnonIdentityVerificationIdFor(id, "SIGNUP", "short"), false, "모양이 다른 nonce");
  // 간편가입 건 번호(stizlink_)는 이 길로 받지 않는다
  assert.equal(anon.isAnonIdentityVerificationIdFor(`stizlink_${"0".repeat(20)}_${"A".repeat(12)}`, "SIGNUP", nonceA), false);
});

// ── 시작: IP 한도 ────────────────────────────────────────────────────────────
test("시작: 장부에 한 줄 적고 nonce 는 응답 본문이 아니라 쿠키용으로만 돌려준다", async () => {
  const db = fakeLedger();
  const result = await started(db);
  assert.match(result.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(anon.isAnonIdentityVerificationIdFor(result.identityVerificationId, "SIGNUP", result.nonce), true);
  assert.equal(db.rows.size, 1);
  const row = db.rows.get(result.identityVerificationId);
  assert.equal(row.purpose, "SIGNUP");
  assert.notEqual(row.requestHash, "1.2.3.4", "IP 원문은 저장하지 않는다(HMAC)");
  assert.match(row.requestHash, /^[0-9a-f]{64}$/);
  // 같은 IP 의 동시 요청을 줄 세운다
  assert.ok(db.calls.some((c) => /pg_advisory_xact_lock/.test(c.sql)));
});

test("시작: 같은 IP 시간당·하루 한도, 전체 하루 한도를 넘으면 429 이고 장부에 적지 않는다", async () => {
  const hourlyDb = fakeLedger();
  for (let i = 0; i < anon.ANON_IDENTITY_IP_HOURLY_LIMIT; i += 1) await started(hourlyDb);
  const blocked = await anon.startAnonIdentity(hourlyDb, { purpose: "SIGNUP", requestKey: "1.2.3.4" });
  assert.deepEqual([blocked.ok, blocked.status], [false, 429]);
  assert.equal(blocked.error, anon.ANON_IDENTITY_TOO_MANY_MESSAGE);
  assert.equal(hourlyDb.rows.size, anon.ANON_IDENTITY_IP_HOURLY_LIMIT, "막힌 요청은 줄을 남기지 않는다");
  // 다른 IP 는 영향 없음
  assert.equal((await anon.startAnonIdentity(hourlyDb, { purpose: "SIGNUP", requestKey: "5.6.7.8" })).ok, true);

  // 하루 한도: 1시간 넘게 지난 줄도 하루 안이면 센다
  let clock = NOW;
  const dailyDb = fakeLedger({ now: () => clock });
  for (let i = 0; i < anon.ANON_IDENTITY_IP_DAILY_LIMIT; i += 1) {
    clock = NOW + i * 10 * 60_000; // 10분 간격 — 시간당 한도(30)에는 걸리지 않게
    if (i % 6 === 0) clock += 1; // 같은 시각 겹침 방지
    await started(dailyDb);
  }
  clock += 60_000;
  const dailyBlocked = await anon.startAnonIdentity(dailyDb, { purpose: "RESET", requestKey: "1.2.3.4" });
  assert.equal(dailyBlocked.status, 429, "목적이 달라도 같은 IP 하루 한도는 함께 센다");

  // 전체 하루 한도
  const globalDb = fakeLedger({ preset: Array.from({ length: anon.ANON_IDENTITY_GLOBAL_DAILY_LIMIT }, (_, i) => ({ id: `g${i}`, purpose: "SIGNUP", requestHash: `ip${i}`, createdAt: NOW - 1000, consumedAt: null })) });
  const busy = await anon.startAnonIdentity(globalDb, { purpose: "SIGNUP", requestKey: "9.9.9.9" });
  assert.deepEqual([busy.status, busy.error], [429, anon.ANON_IDENTITY_BUSY_MESSAGE]);
});

// ── 확인: 위조·재사용·만료 ───────────────────────────────────────────────────
test("확인: 정상 — 명의 번호(숫자만)·다듬은 실명·인증 시각을 돌려주고 장부 줄을 소진한다", async () => {
  const db = fakeLedger();
  const { identityVerificationId, nonce } = await started(db);
  const result = await anon.confirmAnonIdentity(db, { purpose: "SIGNUP", identityVerificationId, nonce, lookup: verified(), now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.phone, "01012345678");
  assert.equal(result.verifiedName, "김 수빈");
  assert.equal(result.verifiedAt.toISOString(), new Date(NOW - 60_000).toISOString());
  assert.ok(db.rows.get(identityVerificationId).consumedAt);
});

test("확인: 표식 위조(다른 nonce·다른 목적)면 포트원에 묻지도 않고 장부도 건드리지 않는다", async () => {
  const db = fakeLedger();
  const { identityVerificationId, nonce } = await started(db);
  let asked = 0;
  const lookup = async (...args) => { asked += 1; return verified()(...args); };
  for (const attempt of [
    { purpose: "SIGNUP", nonce: nonceB },
    { purpose: "RESET", nonce },
    { purpose: "SIGNUP", nonce: "" },
  ]) {
    const result = await anon.confirmAnonIdentity(db, { ...attempt, identityVerificationId, lookup, now: NOW });
    assert.deepEqual([result.ok, result.status, result.error], [false, 400, anon.ANON_IDENTITY_MISMATCH_MESSAGE]);
  }
  assert.equal(asked, 0, "위조 번호로 외부 조회를 일으키지 않는다");
  assert.equal(db.rows.get(identityVerificationId).consumedAt, null);
});

test("확인: 같은 건 번호·쿠키를 두 번 쓰면(재사용) 두 번째는 409", async () => {
  const db = fakeLedger();
  const { identityVerificationId, nonce } = await started(db);
  const input = { purpose: "SIGNUP", identityVerificationId, nonce, lookup: verified(), now: NOW };
  assert.equal((await anon.confirmAnonIdentity(db, input)).ok, true);
  const again = await anon.confirmAnonIdentity(db, input);
  assert.deepEqual([again.ok, again.status, again.error], [false, 409, anon.ANON_IDENTITY_USED_MESSAGE]);
  // 동시에 두 번 들어와도 하나만 통과한다
  const race = fakeLedger();
  const second = await started(race);
  const both = await Promise.all([1, 2].map(() => anon.confirmAnonIdentity(race, { ...input, ...second })));
  assert.equal(both.filter((r) => r.ok).length, 1);
});

test("확인: 만료 — 장부 줄이 10분을 넘었거나 포트원 인증이 10분을 넘었으면 거절", async () => {
  let clock = NOW;
  const db = fakeLedger({ now: () => clock });
  const { identityVerificationId, nonce } = await started(db);
  clock = NOW + anon.ANON_IDENTITY_TTL_SECONDS * 1000 + 1000; // 장부 10분 초과
  const late = await anon.confirmAnonIdentity(db, {
    purpose: "SIGNUP", identityVerificationId, nonce, now: clock,
    lookup: verified({ verifiedAt: new Date(clock - 30_000).toISOString() }),
  });
  assert.deepEqual([late.ok, late.status], [false, 409]);

  const db2 = fakeLedger();
  const fresh = await started(db2);
  const stale = await anon.confirmAnonIdentity(db2, { purpose: "SIGNUP", ...fresh, now: NOW, lookup: verified({ verifiedAt: new Date(NOW - 11 * 60_000).toISOString() }) });
  assert.deepEqual([stale.ok, stale.status], [false, 400], "포트원 인증이 10분보다 오래됨");
  assert.equal(db2.rows.get(fresh.identityVerificationId).consumedAt, null, "거절하면 소진하지 않는다");
});

test("확인: 포트원 조회 실패(502)·미완료·번호/이름 이상은 소진하지 않고 거절", async () => {
  const cases = [
    [async () => null, 502],
    [async () => ({ ok: false, httpStatus: 500 }), 502],
    [async () => { throw new Error("network"); }, 502],
    [verified({ status: "FAILED" }), 400],
    [verified({ verifiedCustomer: { name: "김수빈", phoneNumber: "02-123-4567" } }), 400],
    [verified({ verifiedCustomer: { name: "김수빈", phoneNumber: "" } }), 400],
    [verified({ verifiedCustomer: { name: "  ", phoneNumber: "01012345678" } }), 400],
  ];
  for (const [lookup, status] of cases) {
    const db = fakeLedger();
    const s = await started(db);
    const result = await anon.confirmAnonIdentity(db, { purpose: "SIGNUP", ...s, lookup, now: NOW });
    assert.deepEqual([result.ok, result.status], [false, status]);
    assert.equal(db.rows.get(s.identityVerificationId).consumedAt, null, "다시 시도할 수 있게 남겨 둔다");
  }
});

test("요청 IP 읽기: 가입 문자 인증과 같은 순서(x-vercel-forwarded-for → x-forwarded-for 첫 값 → x-real-ip)", () => {
  assert.equal(anon.anonIdentityRequestKey(new Headers({ "x-vercel-forwarded-for": "1.1.1.1", "x-forwarded-for": "2.2.2.2" })), "1.1.1.1");
  assert.equal(anon.anonIdentityRequestKey(new Headers({ "x-forwarded-for": "2.2.2.2, 3.3.3.3" })), "2.2.2.2");
  assert.equal(anon.anonIdentityRequestKey(new Headers()), "unknown");
});

// ── 모바일 리디렉션 복귀 상태 ────────────────────────────────────────────────
test("리디렉션 복귀: 고른 역할·next·수강신청서 표를 되살리고, 오래됐거나 이상한 값은 버린다", () => {
  const state = { wantsParent: false, staffRoles: ["INSTRUCTOR", "DRIVER"], next: "/mypage/roles?request=INSTRUCTOR", enrollmentHandoff: "handoff-token" };
  const raw = resume.serializeSignupIdentityState(state, NOW);
  assert.deepEqual(resume.parseSignupIdentityState(raw, NOW + 5 * 60_000), state);
  assert.equal(resume.parseSignupIdentityState(raw, NOW + resume.SIGNUP_IDENTITY_STATE_MAX_AGE_MS + 1), null, "20분 넘으면 버린다");
  assert.equal(resume.parseSignupIdentityState("{깨진", NOW), null);
  assert.equal(resume.parseSignupIdentityState(null, NOW), null);
  assert.equal(resume.parseSignupIdentityState("[]", NOW), null);
  // 다른 사이트 주소·모르는 역할은 버린다
  const evil = JSON.stringify({ wantsParent: true, staffRoles: ["ADMIN", "DRIVER", "DRIVER"], next: "//evil.example/x", enrollmentHandoff: 7, savedAt: NOW });
  assert.deepEqual(resume.parseSignupIdentityState(evil, NOW), { wantsParent: true, staffRoles: ["DRIVER"], next: "", enrollmentHandoff: "" });
  assert.equal(resume.parseSignupIdentityState(JSON.stringify({ ...JSON.parse(evil), next: "https://evil.example" }), NOW).next, "");
  // 역할을 하나도 안 고른 값이 오면 학부모로
  assert.equal(resume.parseSignupIdentityState(JSON.stringify({ wantsParent: false, staffRoles: [], savedAt: NOW }), NOW).wantsParent, true);
});

test("가입 화면: 인증창 열기 직전에 상태를 저장하고, 돌아오면(주소에 identityVerificationId) phone 단계로 되살린다", () => {
  const client = read("src/components/auth/ParentSignupClient.tsx");
  assert.match(client, /beforeStart=\{saveIdentityState\}/);
  assert.match(client, /serializeSignupIdentityState\(\{ wantsParent, staffRoles, next: requestedNext, enrollmentHandoff \}, Date\.now\(\)\)/);
  const effect = client.slice(client.indexOf('const returned = searchParams.has("identityVerificationId");'), client.indexOf("/** 본인인증 결과가 «가입 이어가기»일 때"));
  assert.ok(effect.length > 100, "복귀 처리 effect 가 있다");
  assert.match(effect, /if \(!returned && !saved\) return;/, "취소 복귀(code 만)는 저장값이 있을 때만");
  assert.match(effect, /parseSignupIdentityState\(raw, Date\.now\(\)\)/);
  assert.match(effect, /setStaffRoles\(saved\.staffRoles\)/);
  assert.match(effect, /setRestoredNext\(saved\.next\)/);
  assert.match(effect, /setRestoredHandoff\(saved\.enrollmentHandoff\)/);
  assert.match(effect, /setStep\("phone"\)/);
  // 주소에 값이 있으면 주소가 먼저
  assert.match(client, /searchParams\.get\("next"\) \|\| restoredNext \|\| "\/mypage"/);
  assert.match(client, /searchParams\.get\("enrollmentHandoff"\) \|\| restoredHandoff/);
  // 버튼이 인증창 열기 직전에 부른다(sessionStorage 저장 뒤·SDK 호출 전)
  const button = read("src/components/auth/IdentityLinkButton.tsx");
  const beforeAt = button.indexOf("beforeStart?.()");
  assert.ok(beforeAt > 0 && beforeAt < button.indexOf("sdk.requestIdentityVerification("));
});

// ── 화면: 본인인증 기본 + 문자 인증 샛길 ─────────────────────────────────────
test("가입·활성화 화면: 본인인증이 먼저, 문자 인증은 샛길 — 아이디 가입은 로그인 전 주소, 간편가입은 기존 주소", () => {
  const client = read("src/components/auth/ParentSignupClient.tsx");
  assert.match(client, /startUrl: "\/api\/auth\/parent-signup\/identity\/start", verifyUrl: "\/api\/auth\/parent-signup\/identity\/verify"/);
  assert.match(client, /\{\.\.\.\(socialSignup \? \{\} : ANON_IDENTITY_URLS\)\}/);
  assert.match(client, /본인 명의 휴대폰이 아니면 문자 인증으로 하기/);
  // 이미 가입된 번호 → 표식(registeredPhone)으로 «아이디·비밀번호 찾기»
  assert.match(client, /onFailure=\{\(data\) => setRegisteredPhone\(Boolean\(data\.registeredPhone\)\)\}/);
  assert.match(client, /registeredPhone && \(\n\s*<Link href="\/login\/forgot"/);
  // 기존 계정 활성화(existing=1)도 같은 본인인증 버튼 — 제목만 다르다
  assert.match(client, /existingMode \? "기존 학부모 계정 활성화" : "본인 확인"/);
});

test("찾기 화면: 본인인증 버튼이 먼저(찾기 주소), 문자 인증은 샛길, 결과는 같은 «가입된 계정» 단계로", () => {
  const client = read("src/components/auth/ParentPasswordResetClient.tsx");
  assert.match(client, /startUrl: "\/api\/auth\/parent-password-reset\/identity\/start", verifyUrl: "\/api\/auth\/parent-password-reset\/identity\/verify"/);
  assert.match(client, /onResult=\{continueFromIdentity\}/);
  assert.match(client, /step === "phone" && !smsFallback/);
  assert.match(client, /step === "phone" && smsFallback/);
  assert.match(client, /본인 명의 휴대폰이 아니면 문자 인증으로 하기/);
  const fn = client.slice(client.indexOf("function continueFromIdentity"), client.indexOf("function restart"));
  assert.match(fn, /setStep\("accounts"\)/);
});

// ── 라우트 순서 ──────────────────────────────────────────────────────────────
test("라우트: 확인(표식·포트원·소진)이 가입 요청·찾기 요청 발급보다 먼저, nonce 쿠키는 httpOnly·10분·/api/auth", () => {
  const signup = read("src/app/api/auth/parent-signup/identity/verify/route.ts");
  const confirmAt = signup.indexOf('confirmAnonIdentityRequest(request, "SIGNUP"');
  const issueAt = signup.indexOf("issueIdentityVerifiedSignup({");
  assert.ok(confirmAt > 0 && issueAt > confirmAt);
  assert.match(signup, /signupMethod: "PASSWORD"/);
  assert.match(signup, /authenticatedOAuthUser: null/, "로그인 전 — 간편로그인 계정에 붙이지 않는다");
  assert.match(signup, /registeredPhone: true/);
  assert.doesNotMatch(signup, /verifiedCustomer/, "화면이 보낸 이름·번호를 믿지 않는다(포트원 재조회 결과만)");
  const reset = read("src/app/api/auth/parent-password-reset/identity/verify/route.ts");
  assert.ok(reset.indexOf('confirmAnonIdentityRequest(request, "RESET"') < reset.indexOf("issueIdentityVerifiedPasswordReset("));
  assert.match(read("src/app/api/auth/parent-signup/identity/start/route.ts"), /anonIdentityStartResponse\(request, "SIGNUP"\)/);
  assert.match(read("src/app/api/auth/parent-password-reset/identity/start/route.ts"), /anonIdentityStartResponse\(request, "RESET"\)/);
  const server = read("src/lib/identity/anonymous-identity-server.ts");
  assert.match(server, /httpOnly: true/);
  assert.match(server, /path: ANON_IDENTITY_COOKIE_PATH/);
  assert.match(server, /cookieOptions\(ANON_IDENTITY_TTL_SECONDS\)/);
  assert.match(server, /NextResponse\.json\(\{ identityVerificationId: started\.identityVerificationId \}/, "nonce 는 본문에 싣지 않는다");
  assert.equal(anon.ANON_IDENTITY_COOKIE_PATH, "/api/auth");
  assert.equal(anon.ANON_IDENTITY_TTL_SECONDS, 600);
});

test("마이그레이션·schema: 장부 표의 목적 CHECK 가 코드 목록과 같고, 추가만 한다", () => {
  const sql = read("prisma/migrations/20261118230000_identity_verification_start/migration.sql");
  const check = /CHECK \("purpose" IN \(([^)]*)\)\)/.exec(sql);
  assert.ok(check);
  assert.deepEqual(check[1].split(",").map((v) => v.trim().replace(/'/g, "")), [...anon.ANON_IDENTITY_PURPOSES]);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "IdentityVerificationStart"/);
  assert.match(sql, /-- DROP TABLE IF EXISTS "IdentityVerificationStart";/, "되돌림 SQL 주석");
  assert.match(sql, /REVOKE ALL ON TABLE "IdentityVerificationStart" FROM anon, authenticated/);
  assert.doesNotMatch(sql.replace(/^--.*$/gm, ""), /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/);
  assert.match(read("prisma/schema.prisma"), /model IdentityVerificationStart \{/);
});

// ── 찾기: 본인인증 갈래 ──────────────────────────────────────────────────────
test("찾기 계정 고르기: 하나 + 이름 일치(실명 우선)만 OK, 여럿·이름 다름·없음은 막는다", () => {
  const pick = resetRules.selectIdentityResetAccount;
  const one = { id: "u1", name: "수빈맘", identityVerifiedName: "김수빈" };
  assert.deepEqual(pick([one], "김 수빈"), { kind: "OK", account: one }, "실명이 있으면 실명으로 비교(공백 무시)");
  assert.equal(pick([{ id: "u1", name: "김수빈", identityVerifiedName: null }], "김수빈").kind, "OK", "실명 없는 옛 계정은 닉네임으로");
  assert.equal(pick([{ id: "u1", name: "수빈맘", identityVerifiedName: null }], "김수빈").kind, "NAME_MISMATCH");
  assert.equal(pick([{ id: "u1", name: "김수빈", identityVerifiedName: "김아빠" }], "김수빈").kind, "NAME_MISMATCH", "닉네임이 같아도 실명이 다르면");
  assert.equal(pick([one, { ...one, id: "u2" }], "김수빈").kind, "MULTIPLE");
  assert.equal(pick([], "김수빈").kind, "NONE");
  assert.equal(pick([one], "").kind, "NAME_MISMATCH", "이름이 비면 통과시키지 않는다");
  assert.match(pick([one, one], "김수빈").error, /문자 인증으로 하기/, "샛길을 안내한다");
});

/** 찾기 모듈을 가짜 prisma·가짜 Supabase 로 올린다(server-only 는 떼어 낸다) */
async function loadReset(db) {
  globalThis.__resetDb = db;
  const url = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  const transpile = (file) => ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText.replace(/import\s+["']server-only["'];?/g, "");
  const verifiedIdentity = url(transpile("src/lib/identity/verified-identity.ts"));
  const socialLink = url(transpile("src/lib/account/social-link.ts").split('"@/lib/identity/verified-identity"').join(`"${verifiedIdentity}"`));
  const rules = url(transpile("src/lib/identity/identity-reset-rules.ts").split('"@/lib/account/social-link"').join(`"${socialLink}"`).split('"./verified-identity"').join(`"${verifiedIdentity}"`));
  const prismaStub = url(`
    const db = () => globalThis.__resetDb;
    const client = {
      async $queryRawUnsafe(sql, ...args) { db().calls.push({ kind: "query", sql, args }); return /FROM "User"/.test(sql) ? db().accounts : []; },
      async $executeRawUnsafe(sql, ...args) { db().calls.push({ kind: "execute", sql, args }); return 1; },
    };
    export const prisma = { ...client, $transaction: async (fn) => fn(client) };
  `);
  const admin = url(`export function createAdminClient() { return { auth: { admin: { async getUserById() { return { data: { user: { email: "mom@member.stiz.kr", identities: [{ provider: "email" }] } }, error: null }; } } } }; }`);
  const signup = url(`export const normalizeParentPhone = (v) => String(v).replace(/\\D/g, ""); export const oauthProviderMethod = () => null; export const SIGNUP_OTP_IP_HOURLY_LIMIT = 100; export const SIGNUP_OTP_IP_DAILY_LIMIT = 500;`);
  const pwRules = url(`export const PARENT_WEAK_PASSWORD_MESSAGE = "약함"; export const SOCIAL_PASSWORD_CONTACT_MESSAGE = "문의"; export const isWeakPasswordRejection = () => false; export const planSocialPasswordLogin = () => null; export const socialPasswordCreationAllowed = () => false;`);
  const noop = url(`export async function sendAuthenticationSms() { return true; }`);
  const code = transpile("src/lib/parent-password-reset.ts")
    .split('"@/lib/prisma"').join(`"${prismaStub}"`)
    .split('"@/lib/supabase/admin"').join(`"${admin}"`)
    .split('"@/lib/parent-signup-verification"').join(`"${signup}"`)
    .split('"@/lib/parent-password-rules"').join(`"${pwRules}"`)
    .split('"@/lib/message-dispatch"').join(`"${noop}"`)
    .split('"@/lib/identity/identity-reset-rules"').join(`"${rules}"`);
  return import(url(code));
}

const account = (id, extra = {}) => ({ id, username: `mom${id}`, email: `mom${id}@member.stiz.kr`, authUserId: `auth-${id}`, phoneVerifiedAt: new Date(), hasStaffGrant: false, name: "김수빈", identityVerifiedName: null, ...extra });

test("찾기(본인인증): 계정 하나 + 이름 일치 → 문자 없이 VERIFIED 찾기 요청과 그 계정 하나만 돌려준다", async () => {
  const db = { accounts: [account("1")], calls: [] };
  const mod = await loadReset(db);
  const result = await mod.issueIdentityVerifiedPasswordReset({ phone: "010-1234-5678", verifiedName: "김 수빈" });
  assert.equal(result.ok, true);
  assert.equal(result.accounts.length, 1);
  assert.deepEqual([result.accounts[0].id, result.accounts[0].loginId, result.accounts[0].kind], ["1", "mom1", "PASSWORD"]);
  const insert = db.calls.find((c) => /INSERT INTO "ParentPasswordReset"/.test(c.sql));
  assert.ok(insert);
  assert.match(insert.sql, /'VERIFIED'/);
  assert.match(insert.sql, /"proofExpiresAt"[\s\S]*NOW\(\)\+INTERVAL '10 minutes'/);
  assert.equal(insert.args[2], "01012345678", "명의 번호(숫자만)로 적는다");
  assert.ok(!db.calls.some((c) => /ParentPasswordResetOtpSend/.test(c.sql)), "문자를 보내지 않는다");
  assert.ok(db.calls.some((c) => /status='CANCELLED'/.test(c.sql)), "같은 번호의 이전 요청은 닫는다");
});

test("찾기(본인인증): 계정 여럿·이름 다름·계정 없음은 아무것도 만들지 않고 막는다", async () => {
  for (const [accounts, pattern] of [
    [[account("1"), account("2")], /여러 개/],
    [[account("1", { name: "수빈맘" })], /이름/],
    [[account("1", { name: "김수빈", identityVerifiedName: "김아빠" })], /이름/],
    [[], /학부모 계정이 없어요/],
  ]) {
    const db = { accounts, calls: [] };
    const mod = await loadReset(db);
    const result = await mod.issueIdentityVerifiedPasswordReset({ phone: "01012345678", verifiedName: "김수빈" });
    assert.match(result.error, pattern);
    assert.ok(!db.calls.some((c) => c.kind === "execute"), "찾기 요청을 만들지 않는다");
  }
});

// ── 수강 신청서: 셔틀 → 아이 휴대폰 필수 ────────────────────────────────────
test("셔틀을 타면 아이 휴대폰 번호(휴대폰 모양) 필수 — 화면·서버가 같은 판정", () => {
  const check = shuttlePhone.shuttleChildPhoneError;
  assert.equal(check(false, ""), null, "셔틀 안 타면 판정 안 함");
  assert.equal(check(true, "010-1234-5678"), null);
  assert.equal(check(true, "01112345678"), null);
  for (const bad of ["", "   ", "031-123-4567", "010-123", null, undefined]) assert.equal(check(true, bad), shuttlePhone.SHUTTLE_CHILD_PHONE_MESSAGE, String(bad));
  const form = read("src/app/apply/enroll/EnrollApplicationForm.tsx");
  assert.match(form, /shuttleChildPhoneError\(true, form\.childPhone\)/);
  const server = read("src/app/actions/public.ts");
  assert.match(server, /shuttleChildPhoneError\(data\.shuttleNeeded, data\.childPhone\)/);
  // 학생 이름은 실명 — 안내만(검사 로직 없음)
  assert.match(form, /label="아이 이름\(실명\)"/);
  assert.match(read("src/app/admin/students/StudentRegisterModal.tsx"), /학생 이름\(실명\) \*/);
});
