import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

// 카카오 「기존 수강생 인증」 → 연결 화면 → (로그인 / 기존 계정 활성화) → 연결 흐름 회귀 테스트.

const toDataUrl = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const sha = (value) => createHash("sha256").update(value).digest("hex");
async function transpile(file) {
  const code = await readFile(file, "utf8");
  return ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
}

/** kakao-parent-chatbot 을 가짜 prisma 로 올린다. live = 아직 유효한 링크 행(없으면 null). */
async function loadChatbot(live) {
  globalThis.__kakaoLive = live;
  globalThis.__kakaoCalls = [];
  const prismaStub = toDataUrl(`
    export const prisma = {
      $queryRawUnsafe: async (sql, ...args) => {
        globalThis.__kakaoCalls.push({ sql, args });
        if (/SELECT "linkTokenHash"/.test(sql)) return globalThis.__kakaoLive ? [globalThis.__kakaoLive] : [];
        if (/INSERT INTO "KakaoParentIdentity"/.test(sql)) return [{ id: "identity-1", parentUserId: null, status: "PENDING" }];
        return [];
      },
      $executeRawUnsafe: async () => 1,
    };
  `);
  const stub = toDataUrl(`
    export function buildKakaoReconfirmationPayload() { return null; }
    export function kakaoReconfirmationPayloadHash() { return ""; }
    export async function notifyAdminsOfKakaoIntake() { return 0; }
  `);
  const contract = toDataUrl(await transpile("src/lib/kakao-chatbot-contract.ts"));
  // 정책 답변 순수 모듈(챗봇이 질문 판별에 쓴다)도 같은 계약 모듈을 보게 해서 올린다
  const policyQa = toDataUrl((await transpile("src/lib/kakao-policy-qa.ts")).split('"@/lib/kakao-chatbot-contract"').join(`"${contract}"`));
  const code = (await transpile("src/lib/kakao-parent-chatbot.ts"))
    .split('"@/lib/prisma"').join(`"${prismaStub}"`)
    .split('"@/lib/kakao-parent-reconfirmation"').join(`"${stub}"`)
    .split('"@/lib/kakao-intake-admin-alert"').join(`"${stub}"`)
    .split('"@/lib/kakao-policy-qa"').join(`"${policyQa}"`)
    .split('"@/lib/kakao-chatbot-contract"').join(`"${contract}"`);
  // 보강 대화(kakao-makeup-flow)는 tests/kakao-makeup-flow.test.mjs 가 따로 실행 검증한다 — 여기선 "보강과 무관"(null)
  const makeupStub = toDataUrl(`export async function handleMakeupConversation() { return null; }`);
  return import(toDataUrl(code.split('"@/lib/kakao-makeup-flow"').join(`"${makeupStub}"`)));
}

async function withSecret(fn) {
  const before = process.env.KAKAO_CHATBOT_IDENTITY_SECRET;
  process.env.KAKAO_CHATBOT_IDENTITY_SECRET = "s".repeat(40);
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.KAKAO_CHATBOT_IDENTITY_SECRET;
    else process.env.KAKAO_CHATBOT_IDENTITY_SECRET = before;
  }
}

const tokenOf = (url) => new URL(url).searchParams.get("token");

test("'인증'을 다시 누르면 아직 유효한 같은 링크를 다시 보여준다(토큰 원문은 저장하지 않는다)", () => withSecret(async () => {
  // 1) 처음: 새 링크
  const first = await (await loadChatbot(null)).issueLink("bot", "user-key", "https://example.test");
  assert.equal(first.reused, false);
  assert.equal(first.replacedPrevious, false);
  const insert = globalThis.__kakaoCalls.find((c) => /INSERT INTO "KakaoParentIdentity"/.test(c.sql));
  const [, , storedHash, expiresAt] = insert.args;
  const token = tokenOf(first.url);
  assert.equal(storedHash, sha(token), "DB 에는 토큰 해시만 들어간다");
  assert.ok(!insert.args.includes(token), "토큰 원문은 DB 로 보내지 않는다");

  // 2) 다시: 같은 링크 그대로
  const again = await (await loadChatbot({ linkTokenHash: storedHash, expiresMs: String(expiresAt.getTime()) }))
    .issueLink("bot", "user-key", "https://example.test");
  assert.equal(again.reused, true);
  assert.equal(again.url, first.url);
  assert.ok(again.minutesLeft >= 13 && again.minutesLeft <= 15);
  assert.ok(!globalThis.__kakaoCalls.some((c) => /INSERT INTO/.test(c.sql)), "재사용할 때는 덮어쓰지 않는다");

  // 3) 다른 사용자는 같은 만료 시각이어도 다른 토큰
  const other = await (await loadChatbot(null)).issueLink("bot", "user-key-2", "https://example.test");
  assert.notEqual(tokenOf(other.url), token);
}));

test("다시 계산할 수 없는 옛 링크·곧 만료될 링크는 새로 만들고 '이전 링크 무효'를 알린다", () => withSecret(async () => {
  const legacy = await (await loadChatbot({ linkTokenHash: "0".repeat(64), expiresMs: String(Date.now() + 10 * 60_000) }))
    .issueLink("bot", "user-key", "https://example.test");
  assert.equal(legacy.reused, false);
  assert.equal(legacy.replacedPrevious, true);

  // 해시는 맞지만 1분밖에 안 남은 링크 → 열자마자 만료되므로 재사용하지 않는다
  const secret = "s".repeat(40);
  const soon = Date.now() + 60_000;
  const userKeyHash = createHmac("sha256", secret).update("user-key").digest("hex");
  const soonToken = createHmac("sha256", secret).update(`kakao-connect-link:v1:bot:${userKeyHash}:${soon}`).digest("base64url");
  const nearExpiry = await (await loadChatbot({ linkTokenHash: sha(soonToken), expiresMs: String(soon) }))
    .issueLink("bot", "user-key", "https://example.test");
  assert.equal(nearExpiry.reused, false);
  assert.equal(nearExpiry.replacedPrevious, true);
  assert.notEqual(tokenOf(nearExpiry.url), soonToken);

  // 같은 재료(만료 3분 이상 남음)면 재사용 — 위 계산식이 실제 코드와 같다는 확인
  const later = Date.now() + 10 * 60_000;
  const laterToken = createHmac("sha256", secret).update(`kakao-connect-link:v1:bot:${userKeyHash}:${later}`).digest("base64url");
  const reused = await (await loadChatbot({ linkTokenHash: sha(laterToken), expiresMs: String(later) }))
    .issueLink("bot", "user-key", "https://example.test");
  assert.equal(reused.reused, true);
  assert.equal(tokenOf(reused.url), laterToken);
}));

test("연결 화면은 마이페이지 레이아웃 밖에서 그리고, 주소는 그대로 유지한다", async () => {
  const config = await readFile("next.config.ts", "utf8");
  const middleware = await readFile("src/lib/supabase/middleware.ts", "utf8");
  assert.ok(existsSync("src/app/kakao-connect/page.tsx"));
  assert.ok(!existsSync("src/app/mypage/kakao-connect/page.tsx"), "/mypage 안에 두면 레이아웃이 안내 전에 튕겨 낸다");
  assert.match(config, /source: "\/mypage\/kakao-connect",\s*destination: "\/kakao-connect"/);
  assert.match(middleware, /isMyPageKakaoConnect = pathname === "\/mypage\/kakao-connect"/);
  assert.match(middleware, /!isMyPageKakaoConnect/);
});

test("연결 화면은 상황별로 안내하고, 연결 자체는 검증된 학부모만 한다", async () => {
  const page = await readFile("src/app/kakao-connect/page.tsx", "utf8");
  // 링크 만료·무효
  assert.match(page, /isKakaoConnectTokenUsable\(token\)/);
  assert.match(page, /‘기존 수강생 인증’<\/b>을 다시 눌러/);
  assert.match(page, /<b>15분<\/b>/);
  // 로그인 안 됨 → 로그인 + 기존 계정 활성화, 돌아올 주소 유지
  assert.match(page, /const selfPath = `\/mypage\/kakao-connect\?token=\$\{encodeURIComponent\(token\)\}`/);
  assert.match(page, /redirect: selfPath/);
  assert.match(page, /existing: "1", next: selfPath/);
  assert.match(page, /기존 학부모 계정 활성화/);
  assert.match(page, /계정이 없거나 로그인이 안 되면/);
  // 휴대폰 미인증 / 직원 계정
  assert.match(page, /state\.status === "PHONE_UNVERIFIED"/);
  assert.match(page, /state\.status === "STAFF_ACCOUNT"/);
  assert.match(page, /학부모 계정으로 열어 주세요/);
  // 카카오톡 안: 활성화 먼저 + 외부 브라우저 안내
  assert.match(page, /inApp \? <>\{activateButton\}\{loginButton\}<\/> : <>\{loginButton\}\{activateButton\}<\/>/);
  assert.match(page, /<InAppBrowserEscapeCard/);
  // 연결: 서버 액션 안에서 다시 검증하고, 실패는 오류 화면 대신 다시 받기 안내
  assert.match(page, /const current = await getVerifiedParentState\(\);[\s\S]*?if \(current\.status !== "OK"\) redirect\(selfPath\)/);
  assert.match(page, /bindIdentity\(token, current\.parent\.appUserId\)/);
  assert.match(page, /"\/mypage\/kakao-connect\?expired=1"/);
  assert.match(page, /referrer: "no-referrer"/);
});

test("requireVerifiedParent 는 같은 판정(getVerifiedParentState)을 쓰고 기존 오류 문구를 유지한다", async () => {
  const guard = await readFile("src/lib/auth-guard.ts", "utf8");
  assert.match(guard, /export async function requireVerifiedParent\(\)[\s\S]*?const state = await getVerifiedParentState\(\);/);
  assert.match(guard, /if \(state\.status === "OK"\) return state\.parent;/);
  assert.match(guard, /throw new Error\("휴대폰 인증을 완료한 학부모 계정이 필요합니다\."\)/);
});

test("새 카카오 접수는 관리자 앱 알림센터로만 알린다(메일·문자 없음)", async () => {
  const chatbot = await readFile("src/lib/kakao-parent-chatbot.ts", "utf8");
  const alert = (await readFile("src/lib/kakao-intake-admin-alert.ts", "utf8")).replace(/^\s*\/\/.*$/gm, "");
  // 학부모가 접수를 확정(SUBMITTED)한 뒤에만 알린다
  assert.ok(chatbot.indexOf("SET status='SUBMITTED'") < chatbot.indexOf("notifyAdminsOfKakaoIntake({"));
  assert.match(chatbot, /if \(changed === 0\) return kakaoText\("이미 접수된 요청이에요\."\);\s*\/\/[^\n]*\n[\s\S]*?await notifyAdminsOfKakaoIntake/);
  assert.match(chatbot, /notifyAdminsOfKakaoIntake\(\{[\s\S]*?\}\)\.catch\(\(\) => undefined\)/);
  assert.match(alert, /role IN \('ADMIN', 'VICE_ADMIN'\)/);
  assert.match(alert, /createNotificationRecord\(/);
  assert.match(alert, /linkUrl: "\/admin\/kakao-requests"/);
  assert.doesNotMatch(alert, /notifyAdmins\(|sendSms|sendMail|nodemailer|resend|email/i);
});
