// 스토어 앱 시작 경로 줄이기(2026-11-17 속도 개선) — 실행·정적 테스트
//
// 지키려는 것:
//  ① 시작 주소(/store-app)는 /auth/continue 와 «같은 함수»로 목적지를 정한다(두 곳이 다른 답을 내면 안 된다).
//  ② 문서 맨 앞 스크립트는 StoreAppStart 가 찍던 표식을 똑같이 찍는다 — sessionStorage 에만, 그리고 표식 다음에 이동.
//  ③ 목적지 판정의 DB 확인은 동시에 2개까지만(한 요청의 동시 조회는 3개 이하).
//  ④ 머리줄 계정 버튼은 로그인 상태를 한 번만 묻는다.
import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const storeApp = await import("../src/lib/storeApp.ts");
const { buildStoreAppStartScript } = await import("../src/lib/storeAppStartScript.ts");

/** 가짜 브라우저에서 스크립트를 실제로 돌린다 */
function runStartScript(destination, { search = "", brokenStorage = false } = {}) {
  const store = new Map();
  const calls = [];
  const sessionStorage = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      if (brokenStorage) throw new Error("storage blocked");
      store.set(k, String(v));
      calls.push(`set:${k}`);
    },
  };
  const window = {
    sessionStorage,
    location: { search, replace: (to) => calls.push(`go:${to}`) },
  };
  vm.runInNewContext(buildStoreAppStartScript(destination), { window, URLSearchParams });
  return { store, calls, window };
}

test("스크립트는 표식 두 개를 찍은 뒤 목적 화면으로 넘어간다", () => {
  const { store, calls } = runStartScript("/mypage");
  assert.equal(store.get(storeApp.STORE_APP_FLAG_KEY), "1");
  assert.equal(store.get(storeApp.STORE_APP_START_FLAG_KEY), "1");
  assert.equal(store.has(storeApp.STORE_APP_CAPS_KEY), false, "caps 신호가 없으면 아무것도 적지 않는다");
  assert.equal(calls.at(-1), "go:/mypage", "이동은 맨 마지막");
  assert.equal(calls.filter((c) => c.startsWith("go:")).length, 1);
});

test("caps 는 StoreAppStart(recordStoreAppCapabilities)와 같은 값으로 적힌다", () => {
  for (const raw of ["push,links", " push, links ,모름", "voice", "모름", "", "push,links,geolocation,voice,install,sms,모름", "sms,install,geolocation"]) {
    const { store } = runStartScript("/staff", { search: `?caps=${encodeURIComponent(raw)}` });
    const expected = storeApp.parseStoreAppCapabilities(raw).join(",");
    assert.equal(store.get(storeApp.STORE_APP_CAPS_KEY) ?? "", expected, `caps=${raw}`);
  }
});

test("스크립트가 이동을 걸었으면 대비용 컴포넌트는 같은 이동을 또 걸지 않는다", () => {
  const { window } = runStartScript("/mypage");
  assert.equal(window.__stizStoreAppStarted, 1);
  const start = read("src/app/store-app/StoreAppStart.tsx");
  const guardAt = start.indexOf("[STORE_APP_START_DONE_FLAG]) return;");
  const goAt = start.indexOf("window.location.replace(destination)");
  const markAt = start.indexOf("recordStoreAppCapabilities(");
  assert.ok(markAt > 0 && guardAt > markAt && goAt > guardAt, "표식은 찍고, 이동만 건너뛴다");
});

test("저장소를 못 써도 멈추지 않고 넘어간다", () => {
  const { calls } = runStartScript("/login", { brokenStorage: true });
  assert.deepEqual(calls, ["go:/login"]);
});

test("목적지 문자열이 스크립트 밖으로 새지 않는다", () => {
  const nasty = '/mypage?x="</script><script>alert(1)</script>';
  const code = buildStoreAppStartScript(nasty);
  assert.doesNotMatch(code, /<\/script>/i);
  assert.doesNotMatch(code, /</);
  const { calls } = runStartScript(nasty);
  assert.equal(calls.at(-1), `go:${nasty}`, "값은 그대로 전달된다");
});

test("스크립트는 sessionStorage 에만 적는다", () => {
  const source = read("src/lib/storeAppStartScript.ts").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  assert.doesNotMatch(source, /localStorage/);
  assert.doesNotMatch(source, /document\.cookie/);
});

test("시작 주소는 /auth/continue 와 같은 함수로 목적지를 정하고, 실패하면 예전 경로로 간다", () => {
  const page = read("src/app/store-app/page.tsx");
  const continuePage = read("src/app/auth/continue/page.tsx");
  assert.match(page, /import \{ resolveContinueDestination \} from "@\/lib\/auth\/continue-destination"/);
  assert.match(continuePage, /import \{ resolveContinueDestination \} from "@\/lib\/auth\/continue-destination"/);
  assert.match(page, /resolveContinueDestination\(\{\}\)\.catch\(\(\) => "\/auth\/continue"\)/);
  assert.match(page, /export const dynamic = "force-dynamic"/, "사람마다 목적지가 달라 미리 만들어 두면 안 된다");
  // 스크립트와 대비용 컴포넌트가 같은 목적지를 쓴다(다르면 서로 이동을 덮어쓴다)
  assert.match(page, /buildStoreAppStartScript\(destination\)/);
  assert.match(page, /<StoreAppStart destination=\{destination\} \/>/);
  // 화면에는 목적지 판정이 남아 있지 않다(한 곳에서만 판정)
  assert.doesNotMatch(continuePage, /resolveRedirectForRole|queryRawUnsafe/);
  assert.doesNotMatch(page, /resolveRedirectForRole|queryRawUnsafe/);
});

test("목적지 판정: 로그인 확인이 먼저, DB 확인은 한 번의 동시 실행(2개)", () => {
  const lib = read("src/lib/auth/continue-destination.ts");
  const getUserAt = lib.indexOf("supabase.auth.getUser()");
  const loginAt = lib.indexOf('if (!user) return "/login"');
  const allAt = lib.indexOf("Promise.all([");
  assert.ok(getUserAt > 0 && loginAt > getUserAt && allAt > loginAt, "로그인 안 한 사람에게는 DB 를 읽지 않는다");
  assert.equal(lib.split("Promise.all(").length - 1, 1);
  const block = lib.slice(allAt, lib.indexOf("]);", allAt));
  assert.equal(block.split("$queryRawUnsafe").length - 1, 1);
  assert.equal(block.split("getParentViewAccessForAuthUser(user)").length - 1, 1);
  // 화면 이동을 직접 하지 않는다 — 주소만 돌려준다(시작 주소가 그 주소를 스크립트에 심는다)
  assert.doesNotMatch(lib, /next\/navigation/);
});

test("머리줄 계정 버튼은 로그인 상태를 한 곳에서 한 번만 묻는다", () => {
  const source = read("src/components/PublicAccountControls.tsx");
  assert.equal(source.split('fetch("/api/auth/account-role"').length - 1, 1);
  assert.match(source, /const answer = await loadAccountRoleOnce\(\);/);
  // «로그인 안 됨» 답은 다시 쓰지 않는다 — 방금 로그인한 사람에게 옛 답을 주지 않게
  assert.match(source, /current\.role !== null && now - current\.at < ACCOUNT_ROLE_REUSE_MS/);
  // 로그아웃하면 방금 받은 답을 버린다
  assert.match(source, /if \(event === "SIGNED_OUT"\) \{\s*forgetSharedAccountRole\(\);/);
  // 로그아웃 버튼을 누르는 순간에도 버린다(로그아웃은 서버에서 처리돼 브라우저 알림이 안 올 수 있다)
  const forms = source.split("<form action={logout}").length - 1;
  assert.ok(forms > 0);
  assert.equal((source.match(/<form action=\{logout\}[^>]*>\s*<button type="submit" onClick=\{forgetSharedAccountRole\}/g) ?? []).length, forms);
});
