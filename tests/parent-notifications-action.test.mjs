// 학부모 알림 «읽음»·«모두 읽음»·알림 눌러 이동 (2026-11-10).
//  ① 학부모 홈은 관리자용(requireAdmin) 읽음 함수를 부르지 않는다 — 운영에서 «관리자 권한이 필요합니다»로 실패했던 사고
//  ② 학부모 전용 동작은 로그인 사용자 본인 알림만 바꾼다 — 남의 알림 id 를 보내도 "userId" 조건으로 0건(IDOR)
//  ③ 화면이 userId 를 넘기지 않는다(인자 없음 / 알림 id 만)
//  ④ 알림 이동은 우리 사이트 안 주소만 — 바깥 주소·'//'·'/\'·javascript: 는 이동하지 않음
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8");
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => (name in mocks ? mocks[name] : require(name));
  module._compile(compiled, absolute);
  return module.exports;
}

/** 서버 동작을 대역 DB·대역 로그인으로 불러온다 — 실행된 SQL 과 값을 모은다 */
function loadActions(loggedIn) {
  const calls = [];
  const actions = load("src/app/actions/parent-notifications.ts", {
    "next/cache": { revalidatePath() {} },
    "@/lib/auth-guard": {
      requireVerifiedParent: async () => {
        if (!loggedIn) throw new Error("인증이 필요합니다.");
        return { appUserId: "me-parent" };
      },
    },
    "@/lib/prisma": { prisma: { $executeRawUnsafe: async (sql, ...params) => { calls.push({ sql, params }); return 0; } } },
  });
  return { actions, calls };
}

test("① 학부모 알림(머리줄 🔔)은 관리자용 읽음 함수(requireAdmin)를 부르지 않고 학부모 전용 동작을 쓴다", () => {
  // 2026-11-10 k7: 알림 목록은 홈 칸에서 머리줄 종(ParentNotificationBell)으로 옮겼다
  const home = read("src/app/mypage/ParentNotificationBell.tsx");
  assert.doesNotMatch(home, /markNotificationRead|markAllNotificationsRead/, "관리자용 함수 이름이 홈에 없다");
  assert.match(home, /from "@\/app\/actions\/parent-notifications"/);
  assert.match(home, /markAllMyNotificationsRead\(\)/, "모두 읽음은 인자 없이(대상은 서버가 정한다)");
  assert.doesNotMatch(home, /data\.parent\.id\)\)/, "부모 id 를 화면에서 넘기지 않는다");
  // 관리자 쪽 기존 함수는 그대로(관리자 화면이 쓴다)
  const admin = read("src/app/actions/admin.ts");
  assert.match(admin, /export async function markNotificationRead\(id: string\) \{\s*await requireAdmin\(\);/);
});

test("② 정적 검사: 두 UPDATE 모두 로그인 사용자(userId) 조건 · requireVerifiedParent · $executeRawUnsafe 만", () => {
  const src = read("src/app/actions/parent-notifications.ts");
  assert.match(src, /^"use server";/);
  assert.equal((src.match(/await requireVerifiedParent\(\)/g) || []).length, 2);
  assert.doesNotMatch(src, /await requireAdmin|import \{[^}]*requireAdmin/, "관리자 확인을 쓰면 학부모가 막힌다");
  assert.match(src, /UPDATE "Notification" SET "isRead" = true WHERE id = \$1 AND "userId" = \$2/);
  assert.match(src, /UPDATE "Notification" SET "isRead" = true WHERE "userId" = \$1 AND "isRead" = false/);
  // UPDATE 마다 "userId" 조건이 있다(빠지면 남의 알림까지 바뀐다)
  const updates = src.match(/UPDATE "Notification"[^`]*/g) || [];
  assert.equal(updates.length, 2);
  for (const sql of updates) assert.match(sql, /"userId" = \$\d/, sql);
  assert.match(src, /export async function markAllMyNotificationsRead\(\)/, "모두 읽음은 인자 없음");
  assert.match(src, /export async function markMyNotificationRead\(id: string\)/, "한 건 읽음은 알림 id 만");
  assert.doesNotMatch(src, /prisma\.\w+\.(update|updateMany|upsert|findMany)/);
});

test("② 실행: 남의 알림 id 를 보내도 SQL 은 로그인 사용자 id 로 묶인다 · 로그인 안 되면 SQL 없음 · 이상한 id 거절", async () => {
  const { actions, calls } = loadActions(true);
  assert.deepEqual(await actions.markMyNotificationRead("someone-elses-notification"), { ok: true });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /WHERE id = \$1 AND "userId" = \$2/);
  assert.deepEqual(calls[0].params, ["someone-elses-notification", "me-parent"], "userId 자리는 화면 값이 아니라 로그인 사용자");

  assert.deepEqual(await actions.markAllMyNotificationsRead("남의-부모-id"), { ok: true });
  assert.deepEqual(calls[1].params, ["me-parent"], "인자를 억지로 넘겨도 무시하고 로그인 사용자");

  assert.deepEqual(await actions.markMyNotificationRead("x' OR 1=1 --"), { ok: false });
  assert.equal(calls.length, 2, "이상한 id 는 DB 에 가지 않는다");

  const anon = loadActions(false);
  assert.deepEqual(await anon.actions.markMyNotificationRead("n1"), { ok: false });
  assert.deepEqual(await anon.actions.markAllMyNotificationsRead(), { ok: false });
  assert.equal(anon.calls.length, 0);
});

test("④ 알림 이동 주소: 내부 경로만, 바깥 주소는 null(읽음만)", () => {
  const nav = load("src/lib/mypage/parentNav.ts");
  assert.equal(nav.safeInternalHref("/mypage/payments"), "/mypage/payments");
  assert.equal(nav.safeInternalHref("/mypage/classes?child=a#x"), "/mypage/classes?child=a#x");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "mypage", "", null, undefined, 3, "/a\nb", "/a\\b"]) {
    assert.equal(nav.safeInternalHref(bad), null, String(bad));
  }
  const home = read("src/app/mypage/ParentNotificationBell.tsx");
  assert.match(home, /const href = safeInternalHref\(n\.linkUrl\)/);
  assert.match(home, /if \(!isRead\) await markMyNotificationRead\(id\);\s*if \(href\) \{\s*setOpen\(false\);\s*router\.push\(href\);/, "읽음 처리 후 내부 주소로 이동");
});
