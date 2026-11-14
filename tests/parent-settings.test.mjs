// 학부모 머리줄 🔔·⚙ 와 설정 화면 (2026-11-10 원장 결정 k7·m5) — 실제로 불러 실행해 확인한다.
//  ① 순수 규칙: 알림 종류 분류·종류별 설정 정리·배지 9+·글자 크기·이름·새 비밀번호 검사
//  ② 권한: 설정 동작은 로그인한 본인(appUserId)만 바꾼다 — 화면이 남의 id 를 보내도 SQL 에 못 들어간다
//  ③ 발송: 끈 종류는 휴대폰 알림을 보내지 않고, 설정 표가 없거나 조회가 실패하면 «보낸다»
//  ④ 화면: 🔔 배지·⚙ 설정 화면 항목(예전 ⋯ 메뉴 항목 전부 포함)·글자 크기 쿠키
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => (name in mocks ? mocks[name] : require(name));
  module._compile(compiled, absolute);
  return module.exports;
}

const settings = load("src/lib/mypage/parentSettings.ts");
// 약한 비밀번호 판정(순수 모듈, 2026-11-13) — 원본 그대로 싣는다
const passwordRules = load("src/lib/parent-password-rules.ts", { "@/lib/staff/inviteAuthFailure": load("src/lib/staff/inviteAuthFailure.ts") });

test("① 알림 종류 분류 — 출결·청구·공지·셔틀만 끌 수 있고, 나머지(문의 답변·수강 변경 결과 등)는 늘 보낸다", () => {
  assert.equal(settings.pushCategoryOf("ATTENDANCE"), "attendance");
  assert.equal(settings.pushCategoryOf("PAYMENT"), "billing");
  assert.equal(settings.pushCategoryOf("PAYMENT_REQUEST"), "billing");
  assert.equal(settings.pushCategoryOf("NOTICE"), "notice");
  assert.equal(settings.pushCategoryOf("SHUTTLE_ROSTER_CHANGED"), "shuttle");
  assert.equal(settings.pushCategoryOf("shuttle_exception"), "shuttle", "대소문자 무관");
  for (const t of ["REQUEST", "ENROLLMENT_CHANGE", "REPORT", "WAITLIST", "", null, undefined]) {
    assert.equal(settings.pushCategoryOf(t), null, String(t));
  }
  // 화면이 보낸 값 정리 — 모르는 칸·이상한 값은 버리고 빠진 칸은 받기
  assert.deepEqual(settings.normalizePushPrefs({ notice: false, userId: "남", billing: "no" }), { attendance: true, billing: true, notice: false, shuttle: true });
  assert.deepEqual(settings.normalizePushPrefs(null), settings.DEFAULT_PUSH_PREFS);
});

test("① 배지 9+ · 글자 크기 · 이름 · 새 비밀번호 검사", () => {
  assert.equal(settings.unreadBadgeText(0), null);
  assert.equal(settings.unreadBadgeText(3), "3");
  assert.equal(settings.unreadBadgeText(9), "9");
  assert.equal(settings.unreadBadgeText(10), "9+");
  assert.equal(settings.unreadBadgeText(-2), null);
  assert.equal(settings.parseFontScale("xl"), "xl");
  assert.equal(settings.parseFontScale("huge"), "md", "모르는 값은 보통");
  assert.equal(settings.parseFontScale(undefined), "md");
  assert.deepEqual(settings.FONT_SCALES.map((s) => s.label), ["보통", "크게", "아주 크게"]);
  assert.equal(settings.fontScalePercent("lg"), 112.5);
  assert.equal(settings.SHOW_THEME_SETTING, false, "테마(어둡게)는 다크모드 작업 때 연다(m5)");
  assert.equal(settings.cleanDisplayName("  김   스티즈 "), "김 스티즈");
  assert.equal(settings.cleanDisplayName(""), null);
  assert.equal(settings.cleanDisplayName("가".repeat(31)), null);
  assert.equal(settings.cleanDisplayName("<b>"), null);
  assert.equal(settings.newPasswordProblem("", "abcdefgh", "abcdefgh"), "지금 비밀번호를 입력해 주세요.");
  assert.match(settings.newPasswordProblem("old", "short", "short"), /8자 이상/);
  assert.match(settings.newPasswordProblem("old", "abcdefgh", "abcdefgX"), /서로 다릅니다/);
  assert.match(settings.newPasswordProblem("abcdefgh", "abcdefgh", "abcdefgh"), /다른 비밀번호/);
  assert.equal(settings.newPasswordProblem("old-pass", "new-pass-1", "new-pass-1"), null);
});

// ── ② 권한 ──────────────────────────────────────────────────────────────────
function loadSettingsActions({ loggedIn = true, identities = [{ provider: "email" }], currentOk = true } = {}) {
  const sql = [];
  const auth = { updated: [], verified: [] };
  const actions = load("src/app/actions/parent-settings.ts", {
    "next/cache": { revalidatePath() {} },
    "@/lib/auth-guard": { requireVerifiedParent: async () => { if (!loggedIn) throw new Error("인증 필요"); return { appUserId: "me-parent" }; } },
    "@/lib/prisma": { prisma: { $executeRawUnsafe: async (q, ...params) => { sql.push({ q, params }); return 1; } } },
    "@/lib/parent-notification-preferences": { writePushPrefs: async (userId, prefs) => { sql.push({ q: "PREFS", params: [userId, prefs] }); } },
    "@/lib/mypage/parentSettings": settings,
    "@/lib/parent-password-rules": passwordRules,
    "@/lib/payments/preferredMethod": load("src/lib/payments/preferredMethod.ts"),
    "@/lib/supabase/server": {
      createClient: async () => ({
        auth: {
          getUser: async () => ({ data: { user: { id: "auth-me", email: "me@member.stiz.kr", identities } }, error: null }),
          updateUser: async (v) => { auth.updated.push(v); return { error: null }; },
        },
      }),
    },
    "@supabase/supabase-js": {
      createClient: () => ({
        auth: {
          signInWithPassword: async (v) => { auth.verified.push(v); return currentOk ? { data: { user: { id: "auth-me" } }, error: null } : { data: { user: null }, error: { message: "Invalid" } }; },
          signOut: async () => ({}),
        },
      }),
    },
  });
  return { actions, sql, auth };
}

test("② 이름·알림 설정은 로그인한 본인 줄만 바뀐다(화면이 남의 id 를 보내도 무시) · 로그인 안 되면 SQL 없음", async () => {
  const { actions, sql } = loadSettingsActions();
  assert.deepEqual(await actions.updateMyName("  새 이름 "), { ok: true });
  assert.match(sql[0].q, /UPDATE "User" SET name = \$1, "updatedAt" = NOW\(\) WHERE id = \$2/);
  assert.deepEqual(sql[0].params, ["새 이름", "me-parent"]);
  assert.equal((await actions.updateMyName("")).ok, false);
  assert.equal(sql.length, 1, "빈 이름은 DB 에 가지 않는다");

  assert.deepEqual(await actions.saveMyPushPrefs({ notice: false, userId: "someone-else" }), { ok: true });
  assert.deepEqual(sql[1].params, ["me-parent", { attendance: true, billing: true, notice: false, shuttle: true }]);

  // 자주 쓰는 결제 방법: 본인 줄만 · 화이트리스트 밖 값은 NULL(정하지 않음)
  assert.deepEqual(await actions.saveMyPreferredPaymentMethod("kakaopay"), { ok: true });
  assert.match(sql[2].q, /UPDATE "User" SET "preferredPaymentMethod" = \$1, "preferredPaymentMethodUpdatedAt" = NOW\(\) WHERE id = \$2/);
  assert.deepEqual(sql[2].params, ["KAKAOPAY", "me-parent"]);
  assert.deepEqual(await actions.saveMyPreferredPaymentMethod("'; DROP TABLE"), { ok: true });
  assert.deepEqual(sql[3].params, [null, "me-parent"], "모르는 값은 저장하지 않고 «정하지 않음»");

  const out = loadSettingsActions({ loggedIn: false });
  assert.equal((await out.actions.saveMyPreferredPaymentMethod("CARD")).ok, false);
  assert.equal((await out.actions.updateMyName("x")).ok, false);
  assert.equal((await out.actions.saveMyPushPrefs({})).ok, false);
  assert.equal((await out.actions.changeMyPassword("a", "abcdefgh", "abcdefgh")).ok, false);
  assert.equal(out.sql.length, 0);

  // 정적: 서버 동작의 대상 id 는 화면 인자가 아니라 requireVerifiedParent 결과뿐
  const src = read("src/app/actions/parent-settings.ts");
  assert.match(src, /^"use server";/);
  assert.equal((src.match(/await requireVerifiedParent\(\)/g) || []).length, 4, "이름·비밀번호·알림·자주 쓰는 결제 방법");
  assert.doesNotMatch(src, /prisma\.\w+\.(update|updateMany|upsert|create)/, "ORM 기본 메서드 금지(PgBouncer)");
});

test("② 비밀번호 바꾸기 — 지금 비밀번호를 본인 이메일로 확인한 뒤에만, 간편로그인 계정은 거절", async () => {
  const ok = loadSettingsActions();
  assert.deepEqual(await ok.actions.changeMyPassword("old-pass", "new-pass-1", "new-pass-1"), { ok: true });
  assert.deepEqual(ok.auth.verified, [{ email: "me@member.stiz.kr", password: "old-pass" }], "확인은 로그인 사용자 이메일로");
  assert.deepEqual(ok.auth.updated, [{ password: "new-pass-1" }]);

  const wrong = loadSettingsActions({ currentOk: false });
  assert.deepEqual(await wrong.actions.changeMyPassword("bad", "new-pass-1", "new-pass-1"), { ok: false, error: "지금 비밀번호가 맞지 않습니다." });
  assert.equal(wrong.auth.updated.length, 0, "확인 실패면 바꾸지 않는다");

  const oauth = loadSettingsActions({ identities: [{ provider: "google" }] });
  assert.equal((await oauth.actions.changeMyPassword("x", "new-pass-1", "new-pass-1")).ok, false);
  assert.equal(oauth.auth.verified.length + oauth.auth.updated.length, 0);

  const mismatch = loadSettingsActions();
  assert.equal((await mismatch.actions.changeMyPassword("old", "new-pass-1", "new-pass-2")).ok, false);
  assert.equal(mismatch.auth.verified.length, 0, "입력 검사에서 막히면 확인 요청도 안 한다");
});

// ── ③ 발송 거르기 ───────────────────────────────────────────────────────────
test("③ 설정 표 조회 실패(운영 적용 전) = 보낸다 · 끈 종류만 막는다 · 칸 이름은 상수", async () => {
  const make = (impl) => load("src/lib/parent-notification-preferences.ts", {
    "@/lib/prisma": { prisma: { $queryRawUnsafe: impl } },
    "@/lib/mypage/parentSettings": settings,
  });
  const missing = make(async () => { throw new Error('relation "ParentNotificationPreference" does not exist'); });
  assert.equal(await missing.isPushAllowed("u1", "NOTICE"), true);
  assert.equal((await missing.optedOutUserIds("NOTICE")).size, 0);
  assert.deepEqual(await missing.readPushPrefs("u1"), { prefs: settings.DEFAULT_PUSH_PREFS, available: false });

  const seen = [];
  const prefs = make(async (q, ...params) => { seen.push(q); return q.includes('p."userId" = $1') ? [{ on: false }] : [{ userId: "u-off" }]; });
  assert.equal(await prefs.isPushAllowed("u1", "NOTICE"), false);
  assert.match(seen[0], /SELECT p\."pushNotice" AS "on"/);
  // 학부모 역할만 — 자녀 있는 직원 계정의 업무 알림(SHUTTLE_ 등)은 끄지 못한다(같은 SQL 의 JOIN, 조회 한 번)
  assert.match(seen[0], /JOIN "User" u ON u\.id = p\."userId"\s+WHERE p\."userId" = \$1 AND u\.role = 'PARENT'/);
  assert.equal(await prefs.isPushAllowed("u1", "REQUEST"), true, "끌 수 없는 종류는 조회 없이 보낸다");
  assert.equal(seen.length, 1);
  assert.deepEqual([...(await prefs.optedOutUserIds("SHUTTLE_ROSTER_CHANGED"))], ["u-off"]);
  assert.match(seen[1], /WHERE p\."pushShuttle" = false AND u\.role = 'PARENT'/);
});

test("③ sendPushToUser: 끈 종류는 구독 조회 없이 건너뜀(대기열은 SKIPPED) · sendPushToAllParents 는 끈 학부모 기기를 뺀다", async () => {
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "pub";
  process.env.VAPID_PRIVATE_KEY = "priv";
  const sent = [];
  const queries = [];
  const push = load("src/lib/pushNotification.ts", {
    "web-push": { __esModule: true, default: { setVapidDetails() {}, sendNotification: async (sub) => { sent.push(sub.endpoint); } } },
    "@/lib/prisma": { prisma: {
      $queryRawUnsafe: async (q) => { queries.push(q); return [{ id: "s1", userId: "on", endpoint: "e-on", p256dh: "p", auth: "a" }, { id: "s2", userId: "off", endpoint: "e-off", p256dh: "p", auth: "a" }]; },
      $executeRawUnsafe: async () => 0,
    } },
    "@/lib/parent-notification-preferences": {
      isPushAllowed: async (userId, tag) => !(userId === "off" && tag === "NOTICE"),
      optedOutUserIds: async (tag) => new Set(tag === "NOTICE" ? ["off"] : []),
    },
    // 스토어 앱 푸시(e2): 이 검사는 웹푸시만 — FCM 설정 없음 = 앱 발송 건너뜀
    "@/lib/push/fcm": { fcmServiceAccount: () => null, sendFcm: async () => { throw new Error("FCM 설정이 없으면 부르지 않는다"); } },
    "@/lib/push/nativePushStore": {
      listNativeTokensForUser: async () => { throw new Error("FCM 설정이 없으면 조회하지 않는다"); },
      listNativeTokensForParents: async () => { throw new Error("FCM 설정이 없으면 조회하지 않는다"); },
      deleteNativeToken: async () => true,
    },
    "@/lib/push/nativePushPolicy": load("src/lib/push/nativePushPolicy.ts"),
  });
  const skipped = await push.sendPushToUser("off", { title: "t", body: "b", tag: "NOTICE" });
  assert.equal(skipped.status, "NO_SUBSCRIPTION");
  assert.equal(skipped.errorCode, "PUSH_OPTED_OUT");
  assert.equal(queries.length, 0);
  const all = await push.sendPushToAllParents({ title: "공지", body: "b", tag: "NOTICE" });
  assert.deepEqual(sent, ["e-on"], "공지를 끈 학부모 기기는 빠진다");
  assert.equal(all.subscriptionCount, 1);
  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
});

test("③ 마이그레이션은 새 표 하나(기존 표 변경 없음)·여러 번 실행 가능, schema.prisma 사본과 칸이 같다", () => {
  const sql = read("prisma/migrations/20261110170000_parent_notification_preference/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "ParentNotificationPreference"/);
  assert.doesNotMatch(sql.replace(/--.*$/gm, ""), /ALTER TABLE "(?!ParentNotificationPreference)|DROP /);
  const schema = read("prisma/schema.prisma");
  const model = schema.slice(schema.indexOf("model ParentNotificationPreference"), schema.indexOf("}", schema.indexOf("model ParentNotificationPreference")));
  for (const c of settings.PUSH_CATEGORIES) {
    assert.match(sql, new RegExp(`"${c.column}"\\s+BOOLEAN\\s+NOT NULL DEFAULT true`));
    assert.match(model, new RegExp(`${c.column}\\s+Boolean\\s+@default\\(true\\)`));
  }
});

// ── ④ 화면 ──────────────────────────────────────────────────────────────────
test("④ 🔔 배지: 안 읽은 수(10 이상 9+), 없으면 배지 없음", () => {
  const Bell = load("src/app/mypage/ParentNotificationBell.tsx", {
    "next/link": { __esModule: true, default: ({ children, ...p }) => React.createElement("a", p, children) },
    "next/navigation": { usePathname: () => "/mypage", useRouter: () => ({ push() {} }) },
    "@/app/actions/parent-notifications": {},
    "@/lib/mypage/parentNav": { safeInternalHref: () => null },
    "@/lib/datetime/kst": load("src/lib/datetime/kst.ts"),
    "@/lib/mypage/parentSettings": settings,
    // 2026-11-15 아이콘 예외(화살표·종·톱니): 공용 아이콘 부품은 실제 코드를 그대로 쓴다
    "@/components/common/UiIcon": load("src/components/common/UiIcon.tsx"),
  }).default;
  const many = renderToStaticMarkup(React.createElement(Bell, { notifications: [], unreadCount: 12 }));
  assert.match(many, />9\+<\/span>/);
  assert.match(many, /aria-label="알림, 안 읽은 알림 12건"/);
  const none = renderToStaticMarkup(React.createElement(Bell, { notifications: [], unreadCount: 0 }));
  assert.doesNotMatch(none, /9\+|>0</);
  assert.match(none, /aria-label="알림"/);
  // 2026-11-15 아이콘 예외(알림 = 종): 글자 대신 종을 그린다 — 이름은 위 aria-label, 누르는 영역 44×44
  for (const html of [many, none]) {
    assert.match(html, /<button[^>]*aria-label="알림[^"]*"[^>]*class="inline-flex min-h-11 min-w-11[^"]*"[^>]*><span aria-hidden="true" class="ui-icon[^"]*"><span class="material-symbols-outlined text-2xl">notifications<\/span><span class="ui-icon-fallback">알림<\/span><\/span>/);
  }
});

test("④ 설정 화면: 원장 목록 항목 + 예전 ⋯ 메뉴 항목이 전부 있다, 테마는 숨김", () => {
  const page = read("src/app/mypage/settings/page.tsx");
  const client = read("src/app/mypage/settings/SettingsClient.tsx");
  // 예전 ⋯ 메뉴: 알림·휴대폰 알림 설정 / 자녀·가족 연결 / 간편로그인 연결 / 로그아웃 (+ 형제·자매 상담 — 상담 작업이 ⋯ 에 넣던 줄)
  assert.match(page, /id="settings-notifications"/);
  assert.match(page, /href="\/mypage\/children"/);
  assert.match(page, /href="\/mypage\/login-methods"/);
  assert.match(page, /href="\/mypage\/consult"/);
  assert.match(page, /<form action=\{logout\}>/);
  // 원장 목록(k7): 계정·비밀번호·가족 초대·알림·글자 크기·앱 정보·문제 신고·로그아웃·탈퇴
  for (const label of ["내 정보", "자녀·가족 초대", "알림 설정", "앱 정보", "이용약관", "개인정보처리방침", "회원 탈퇴"]) assert.ok(page.includes(label), label);
  assert.match(page, /href="\/terms"/);
  assert.match(page, /href="\/privacy"/);
  assert.match(page, /href="\/mypage\/withdraw"/);
  assert.match(page, /\{hasPasswordLogin && <PasswordRow \/>\}/, "비밀번호 바꾸기는 비밀번호 로그인 계정만");
  for (const label of ["비밀번호 바꾸기", "휴대폰 알림", "글자 크기", "앱에서 켤 수 있어요"]) assert.ok(client.includes(label), label);
  assert.match(page, /SHOW_THEME_SETTING \?/, "테마 자리는 스위치 뒤에 숨김");
  // 2026-11-14 문구 정리: 설정의 «문제 신고·문의» 폼은 홈 «문의»와 같은 기능이라 없애고, 홈 문의 폼으로 가는 링크 한 줄로 바꿨다
  // 홈 문의 폼은 자녀가 연결된 계정에만 있다 → 자녀가 있으면 링크, 없으면 «자녀 연결» 안내(갈 곳 없는 링크 금지)
  assert.match(page, /<Section title="도움">\s*\{childRows\.length > 0 \? \(\s*<LinkRow href="\/mypage#parent-request-form" label="문의" \/>\s*\) : \(/);
  assert.match(page, /자녀를 연결한 뒤 문의를 보낼 수 있어요<\/span>\s*<Link href="\/mypage\/children" className="academy-button-secondary shrink-0">자녀 연결<\/Link>/);
  assert.doesNotMatch(client, /createParentRequest|FeedbackRow|불편 신고/);
  // 그 링크가 닿는 홈 폼은 주소의 #parent-request-form 으로 펴지고, 보내는 값은 자유 메시지(OTHER) 그대로다
  const home = read("src/app/mypage/MyPageClient.tsx");
  assert.match(home, /if \(id === "parent-request-form"\) setShowRequestForm\(true\);/);
  assert.match(home, /type: "OTHER",/);
  // «계정» 묶음(2026-11-14 d3): 맨 아래 링크 줄에 있던 «내 계정»을 설정으로 — 비밀번호·간편로그인과 한 묶음
  assert.match(page, /<Section title="계정">\s*<LinkRow href="\/account" label="내 계정" \/>\s*\{hasPasswordLogin && <PasswordRow \/>\}\s*<LinkRow href="\/mypage\/login-methods" label="간편로그인 연결" \/>/);
  assert.doesNotMatch(page, /\/mypage\/roles/, "역할 추가 신청은 링크하지 않는다(d4)");
  // 앱 정보: 앱 버전만 — 배포 번호(«화면 xxxxxxx»)는 보이지 않는다
  assert.match(page, /\{version\.app && \(\s*<li className=\{ROW\}>/);
  assert.doesNotMatch(page, /version\.web/);
  // 종류별 스위치는 학부모 계정에만 보인다(발송 쪽 PARENT 한정과 같은 기준)
  assert.match(page, /prefsAvailable=\{pushPrefs\.available && me\?\.role === "PARENT"\}/);
  // 설정 화면 조회는 로그인 사용자 기준(남의 정보 화면 없음)
  assert.match(page, /WHERE id = \$1 LIMIT 1`,\s*parent\.appUserId/);
});

test("④ 글자 크기: 쿠키 → 학부모 layout 이 html 글자 배율을 서버에서 그린다(보통이면 아무것도 안 넣음)", () => {
  const layout = read("src/app/mypage/layout.tsx");
  assert.match(layout, /fontScalePercent\(parseFontScale\(cookieStore\.get\(FONT_SCALE_COOKIE\)\?\.value\)\)/);
  assert.match(layout, /\{fontPercent !== 100 && <style>\{`html\{font-size:\$\{fontPercent\}%\}`\}<\/style>\}/);
  const client = read("src/app/mypage/settings/SettingsClient.tsx");
  assert.match(client, /document\.cookie = `\$\{FONT_SCALE_COOKIE\}=\$\{key\}; path=\/; max-age=31536000; samesite=lax`/);
  assert.match(client, /router\.refresh\(\)/);
  // 머리줄 알림은 본인 알림만
  assert.match(layout, /getNotifications\(parent\.appUserId\)/);
  assert.match(layout, /getUnreadNotificationCount\(parent\.appUserId\)/);
});
