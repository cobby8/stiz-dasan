// 2026-11-17 원장 지시 — 「선생님·원장 계정에도 «간편로그인 연결» 열어」.
// 계기: 원장이 앱에서 Apple 로그인을 눌렀는데 연결된 적이 없어 «가입된 학원 계정이 없습니다»가 나왔다.
// 지키는 약속:
//  (a) 직원 화면은 직원 문지기를 쓰고, 앱→바깥 브라우저 1회용 표(handoff)를 만들지 않는다
//  (b) 연결 시작은 학부모 → 직원 순으로 확인하고 둘 다 아니면 거절한다
//  (c) 돌아갈 화면은 주소 파라미터가 아니라 서버가 로그인한 계정으로 정한다
//  (d) 브라우저 간편로그인 콜백이 직원 계정을 /auth/continue 로 보낸다(예전엔 학부모 가입 화면)
//  (e) 1회용 표 대상 판정(isLinkHandoffEligible)은 여전히 직원을 거절한다
// 순수 판정은 실제로 실행해서 확인한다. 날짜·시계에 기대는 단정은 없다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

const read = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const rules = await loadTsModule("src/lib/account/login-methods-rules.ts");
const handoffRules = await loadTsModule("src/lib/account-link-handoff/rules.ts");

const staffPage = read("src/app/staff/mypage/login-methods/page.tsx");
const staffButton = read("src/app/staff/mypage/login-methods/StaffLinkProviderButton.tsx");
const start = read("src/app/auth/oauth/[provider]/route.ts");
const callback = read("src/app/auth/callback/route.ts");

// 두 문지기를 흉내 낸 모듈 — 부른 순서를 적고, 상태에 따라 통과·거절한다(DB 없이 판정 함수를 실제로 돌리려고)
const guardStub = `data:text/javascript;base64,${Buffer.from(`
  export async function requireVerifiedParent() {
    globalThis.__linkGuard.calls.push("parent");
    if (!globalThis.__linkGuard.parent) throw new Error("not parent");
    return {};
  }
  export async function requireStaff() {
    globalThis.__linkGuard.calls.push("staff");
    if (!globalThis.__linkGuard.staff) throw new Error("not staff");
    return {};
  }
`).toString("base64")}`;
const actorModule = await loadTsModule("src/lib/account/link-actor.ts", { overrides: { "@/lib/auth-guard": guardStub } });

async function resolveWith(state) {
  globalThis.__linkGuard = { ...state, calls: [] };
  const actor = await actorModule.resolveLinkActor();
  return { actor, calls: globalThis.__linkGuard.calls };
}

test("(b) 연결할 수 있는 사람: 학부모 확인이 먼저, 아니면 직원, 둘 다 아니면 없음(실행)", async () => {
  // 학부모면 직원 확인은 하지 않는다(기존 학부모 흐름 그대로)
  assert.deepEqual(await resolveWith({ parent: true, staff: false }), { actor: "parent", calls: ["parent"] });
  // 자녀가 있는 직원은 학부모 확인을 통과한다 → 학부모로 본다
  assert.deepEqual(await resolveWith({ parent: true, staff: true }), { actor: "parent", calls: ["parent"] });
  // 학부모가 아니면 그때 직원 확인
  assert.deepEqual(await resolveWith({ parent: false, staff: true }), { actor: "staff", calls: ["parent", "staff"] });
  // 둘 다 아니면(로그인 없음·휴대폰 미인증 학부모 등) 연결할 수 없다
  assert.deepEqual(await resolveWith({ parent: false, staff: false }), { actor: null, calls: ["parent", "staff"] });

  assert.equal(rules.pickLinkActor({ parent: true, staff: true }), "parent");
  assert.equal(rules.pickLinkActor({ parent: false, staff: true }), "staff");
  assert.equal(rules.pickLinkActor({ parent: false, staff: false }), null);
});

test("(b) 시작 라우트: 판정 → 거절 → 연결 호출 순서, 연결 모드에서 새 로그인을 하지 않는다", () => {
  const getAt = start.indexOf("export async function GET(");
  const linkAt = start.indexOf('if (intent === "link") {', getAt);
  assert.ok(linkAt > getAt, "연결 모드가 없다");
  const block = start.slice(linkAt, start.indexOf("return NextResponse.redirect(data.url);", linkAt));
  const guardAt = block.indexOf("const actor = await resolveLinkActor();");
  const rejectAt = block.indexOf("if (!actor) return loginError(");
  const linkCallAt = block.indexOf("supabase.auth.linkIdentity(");
  assert.ok(guardAt > 0 && rejectAt > guardAt && linkCallAt > rejectAt, "판정 → 거절 → 연결 순서");
  assert.doesNotMatch(block, /signInWithOAuth/);
  // 판정은 공용 함수 하나로만 — 라우트가 문지기를 따로 부르지 않는다(두 군데가 어긋나지 않게)
  assert.match(start, /import \{ resolveLinkActor \} from "@\/lib\/account\/link-actor";/);
  assert.doesNotMatch(start, /requireVerifiedParent|requireStaff\(/);
  // 판정 함수는 앱 DB 문지기 둘만 쓴다(주소·OAuth 메타데이터를 보지 않는다)
  const actorSource = read("src/lib/account/link-actor.ts");
  assert.match(actorSource, /import \{ requireStaff, requireVerifiedParent \} from "@\/lib\/auth-guard";/);
  assert.doesNotMatch(actorSource, /searchParams|user_metadata|app_metadata/);
});

test("(c) 돌아갈 화면: 직원만 직원 화면, 그 밖은 학부모 화면 — 정해진 두 주소뿐(실행)", () => {
  assert.equal(rules.loginMethodsPath("staff"), "/staff/mypage/login-methods");
  assert.equal(rules.loginMethodsPath("parent"), "/mypage/login-methods");
  assert.equal(rules.loginMethodsPath(null), "/mypage/login-methods");
  // 엉뚱한 값이 들어와도 정해진 두 주소 밖으로 나가지 않는다
  for (const odd of [undefined, "", "admin", "https://evil.example", "//evil.example", "/admin"]) {
    assert.equal(rules.loginMethodsPath(odd), "/mypage/login-methods", String(odd));
  }
});

test("(c) 시작·마무리 라우트: 복귀 화면을 주소 파라미터로 받지 않고 서버 판정으로 정한다", () => {
  // 시작 라우트의 연결 실패 복귀
  const errorFn = start.slice(start.indexOf("async function loginError("), start.indexOf("export async function GET("));
  const linkBranch = errorFn.slice(errorFn.indexOf('if (intent === "link") {'), errorFn.indexOf('const url = new URL(intent === "login"'));
  assert.match(linkBranch, /const actor = knownActor !== undefined \? knownActor : await resolveLinkActor\(\);/);
  assert.match(linkBranch, /const url = new URL\(loginMethodsPath\(actor\), request\.url\);/);
  assert.doesNotMatch(linkBranch, /searchParams\.get\(/, "연결 복귀 주소에 요청 파라미터를 쓰지 않는다");
  // knownActor 는 라우트 안에서 판정한 값만 넘긴다(요청에서 읽은 값이 아니다)
  const calls = [...start.matchAll(/loginError\(request, [^\n]*?, (\w+)\);/g)].map((match) => match[1]);
  assert.deepEqual(calls.sort(), ["actor", "null"]);

  // 콜백의 연결 마무리
  const redirectFn = callback.slice(callback.indexOf("async function loginMethodsPageRedirect("), callback.indexOf("async function appLinkDoneRedirect("));
  assert.match(redirectFn, /const url = new URL\(loginMethodsPath\(await resolveLinkActor\(\)\), request\.url\);/);
  assert.doesNotMatch(redirectFn, /searchParams\.get\(/);
  const finish = callback.slice(callback.indexOf("async function finishLink("), callback.indexOf("export async function GET("));
  // 연결 마무리는 next·redirect·return 같은 «돌아갈 곳» 파라미터를 읽지 않는다
  const readParams = [...finish.matchAll(/searchParams\.get\("([^"]+)"\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(readParams, ["error_code", "via"]);
  // 성공·실패 모두 같은 복귀 함수를 지난다(앱 handoff 분기는 그대로)
  assert.match(finish, /: loginMethodsPageRedirect\(request, \{ error: message \}\)/);
  assert.match(finish, /: loginMethodsPageRedirect\(request, \{ linked: provider \}\);/);
  // 두 주소는 규칙 파일에만 적혀 있다(라우트에 직접 적지 않는다)
  for (const source of [start, callback]) assert.doesNotMatch(source, /"\/(staff\/)?mypage\/login-methods"/);
});

test("(a) 직원 연결 화면: 직원 문지기 · 1회용 표를 만들지 않는다 · 연결 버튼은 일반 링크", () => {
  assert.match(staffPage, /export const dynamic = "force-dynamic";/);
  // 문지기가 조회(연결된 간편로그인 읽기)보다 먼저다
  const guardAt = staffPage.indexOf("await requireStaff();");
  const identitiesAt = staffPage.indexOf("supabase.auth.getUserIdentities()");
  assert.ok(guardAt > 0 && identitiesAt > guardAt, "직원 확인 → 조회 순서");
  assert.doesNotMatch(staffPage, /requireVerifiedParent/);
  // handoff(앱 → 바깥 브라우저 자동 로그인)는 직원에게 쓰지 않는다 — 화면·부품 어디에도 없다
  for (const source of [staffPage, staffButton]) {
    assert.doesNotMatch(source, /account-link-handoff|issueLinkHandoffs|linkHandoffUrl|handoffHref|link-handoff/);
  }
  // 내용 구성은 학부모 화면과 같다: 켜진 제공자 + 연결된 것, 성공·실패 안내(주소 문장은 걸러서)
  assert.match(staffPage, /getEnabledParentOAuthProviders\(\)/);
  assert.match(staffPage, /PARENT_OAUTH_PROVIDERS\.filter\(\(provider\) => enabled\.includes\(provider\) \|\| linked\.has\(provider\)\)/);
  assert.match(staffPage, /customerMessage\(params\.error\.slice\(0, 200\)/);
  assert.match(staffPage, /parseParentOAuthProvider\(params\.linked \?\? ""\)/);
  // 앱 판정: 서버(사용자 에이전트) + 화면(useStoreApp) — 학부모 화면과 같은 판정 재사용
  assert.match(staffPage, /looksLikeStoreApp\(\{ userAgent: requestHeaders\.get\("user-agent"\) \}\)/);
  assert.match(staffButton, /const clientStoreApp = useStoreApp\(\);/);
  // 연결 버튼 = 일반 <a>(미리 불러오기 금지), 자바스크립트 이동 없음
  assert.match(staffButton, /<a\s+href=\{`\/auth\/oauth\/\$\{provider\}\?intent=link`\}/);
  assert.doesNotMatch(staffButton + staffPage, /from "next\/link"/);
  assert.doesNotMatch(staffButton, /location\.(href|assign|replace)|window\.open|router\.push/);
  // 돌아갈 곳을 주소에 싣지 않는다
  assert.doesNotMatch(staffButton, /[?&](next|redirect|return)=/);
});

test("(a) 앱 안에서는 «연결하기»를 숨기고 안내만 보인다(실행)", () => {
  const visible = (serverStoreApp, clientStoreApp) => ({
    button: rules.staffLinkButtonVisible({ serverStoreApp, clientStoreApp }),
    notice: rules.staffLinkNoticeVisible({ serverStoreApp, clientStoreApp }),
  });
  // 일반 브라우저: 버튼만
  assert.deepEqual(visible(false, false), { button: true, notice: false });
  // 아직 모름(서버 그림·첫 그림): 아무것도 그리지 않는다 — 앱에서 버튼이 잠깐 보이는 일 방지
  assert.deepEqual(visible(false, null), { button: false, notice: false });
  // 표식 없는 옛 앱(화면만 앱으로 알아봄): 안내만
  assert.deepEqual(visible(false, true), { button: false, notice: true });
  // 서버가 앱으로 알아봤으면 화면 판정과 상관없이 안내만
  for (const client of [null, true, false]) assert.deepEqual(visible(true, client), { button: false, notice: true });

  assert.equal(
    rules.STAFF_STORE_APP_LINK_NOTICE,
    "앱에서는 연결할 수 없어요. 휴대폰 브라우저(사파리·크롬)에서 www.stiz-dasan.kr 에 로그인한 뒤 연결해 주세요.",
  );
  assert.match(staffButton, /if \(!staffLinkButtonVisible\(\{ serverStoreApp, clientStoreApp \}\)\) return null;/);
  assert.match(staffButton, /if \(!staffLinkNoticeVisible\(\{ serverStoreApp, clientStoreApp \}\)\) return null;/);
  assert.match(staffButton, /\{STAFF_STORE_APP_LINK_NOTICE\}/);
});

test("(a) 직원 화면 모양: 색은 토큰만 · 굵기 네 단계 · 아이콘 없음(Apple 로고만) · 경고창 없음", () => {
  for (const [name, source] of [["page", staffPage], ["button", staffButton]]) {
    assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b|\b(bg|text|border)-(white|black|gray|slate|zinc|neutral|red|blue|green|yellow|orange)(-\d+)?\b/, `${name}: 직접 쓴 색`);
    assert.doesNotMatch(source, /font-(black|extrabold)|font-\[[89]00\]/, `${name}: 굵기`);
    assert.doesNotMatch(source, /material-symbols|<UiIcon|lucide|<svg/, `${name}: 아이콘`);
    assert.doesNotMatch(source, /text-\[(?:[0-9]|1[01])px\]/, `${name}: 12px 미만 글자`);
    assert.doesNotMatch(source, /\b(alert|confirm|prompt)\(/, `${name}: 브라우저 경고창`);
  }
  assert.match(staffPage, /\{provider === "apple" && <AppleLogo \/>\}/);
  // 누르는 버튼은 44px 를 맡는 공용 버튼 부품(브랜드 주 색 옅은 바탕)
  assert.match(staffButton, /className="academy-button-tonal shrink-0"/);
  // 화면 틀·제목은 다른 선생님 화면과 같다(뒤로 가기는 머리줄의 AppBackButton)
  assert.match(staffPage, /<main className="mx-auto max-w-lg [^"]*px-4 pb-8 pt-5">/);
  assert.match(staffPage, /<h1 className="academy-heading">간편로그인 연결<\/h1>/);
  assert.match(read("src/app/staff/layout.tsx"), /<AppBackButton fallbackHref="\/staff" scopeHref="\/staff" \/>/);
});

test("마이페이지에 «간편로그인 연결» 줄이 있고 청구 진입로는 없다", () => {
  const mypage = read("src/app/staff/mypage/page.tsx");
  assert.match(mypage, /<Link href="\/staff\/mypage\/login-methods" className=\{LINK_ROW\}>\s*<span className="flex-1 font-medium text-\[var\(--color-academy-primary\)\]">간편로그인 연결<\/span>/);
  assert.doesNotMatch(mypage, /staff\/billing|청구서|수납/);
  assert.doesNotMatch(staffPage + staffButton, /billing|청구/);
});

test("(d) 브라우저 간편로그인 콜백: 직원 계정은 /auth/continue 로, 앱 로그인과 같은 판정 함수", () => {
  const getAt = callback.indexOf("export async function GET(");
  const login = callback.slice(getAt);
  const parentAt = login.indexOf('if (appUser?.role === "PARENT" && (appUser.phoneVerifiedAt || appUser.username === null)) {');
  const staffAt = login.indexOf('if (appUser && appUser.role !== "PARENT" && await requireNativeAccount(user.id)) {');
  const signupAt = login.indexOf('const url = new URL("/signup/parent", request.url);');
  assert.ok(parentAt > 0 && staffAt > parentAt && signupAt > staffAt, "학부모 분기 → 직원 분기 → 학부모 가입 순서");
  const staffBranch = login.slice(staffAt, signupAt);
  assert.match(staffBranch, /const url = new URL\("\/auth\/continue", request\.url\);\s*url\.searchParams\.set\("redirect", next\);\s*return NextResponse\.redirect\(url\);/);
  // 직원 분기는 수강신청서 연결(학부모 몫)을 하지 않는다
  assert.doesNotMatch(staffBranch, /linkEnrollmentAccount|enrollmentHandoff/);
  // next 는 안쪽 주소만 통과시키는 기존 처리 그대로
  assert.match(login, /const next = safeInternalRedirect\(request\.nextUrl\.searchParams\.get\("next"\)\);/);
  // 판정 = 앱 로그인과 같은 함수(조건이 두 군데로 갈라지지 않는다). 역할 목록을 콜백에 따로 적지 않는다
  assert.match(callback, /import \{ requireNativeAccount \} from "@\/lib\/native-auth\/store";/);
  assert.doesNotMatch(callback, /"VICE_ADMIN"|"INSTRUCTOR"|"DRIVER"/);
  const store = read("src/lib/native-auth/store.ts");
  assert.match(store, /"withdrawnAt" IS NULL AND "withdrawRequestedAt" IS NULL LIMIT 2/);
  assert.match(store, /\["ADMIN","VICE_ADMIN","INSTRUCTOR","DRIVER","PARENT"\]\.includes\(rows\[0\]\.role\)/);
  // 권한은 앱 DB 로만 — OAuth 메타데이터를 보지 않는다
  assert.doesNotMatch(callback, /user_metadata|app_metadata/);
  // 앱 계정이 없는 간편로그인(처음 쓰는 사람)은 지금처럼 학부모 가입으로 간다(appUser 가 없으면 직원 분기를 타지 않는다)
  assert.match(login.slice(signupAt), /url\.searchParams\.set\("social", "1"\);/);
});

test("(e) 1회용 표 대상 판정은 여전히 직원을 거절한다(실행)", () => {
  const parentRow = { role: "PARENT", hasActiveStaffGrant: false, phoneVerifiedAt: "2026-01-01T00:00:00Z", withdrawnAt: null, withdrawRequestedAt: null };
  assert.equal(handoffRules.isLinkHandoffEligible([parentRow]), true);
  for (const role of ["ADMIN", "VICE_ADMIN", "INSTRUCTOR", "DRIVER"]) {
    assert.equal(handoffRules.isLinkHandoffEligible([{ ...parentRow, role }]), false, role);
  }
  // 학부모 겸 직원(승인된 추가 역할)도 거절
  assert.equal(handoffRules.isLinkHandoffEligible([{ ...parentRow, hasActiveStaffGrant: true }]), false);
  // 표를 실제로 쓰는 시작 라우트도 같은 판정을 그대로 쓴다
  assert.match(read("src/app/auth/link-handoff/start/route.ts"), /isLinkHandoffEligible\(await linkHandoffAccountRows\(claim\.authUserId\)\)/);
});
