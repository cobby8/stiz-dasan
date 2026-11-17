// 2026-11-17 원장 지시 — 「선생님·원장 계정에도 «간편로그인 연결» 열어」.
// 계기: 원장이 앱에서 Apple 로그인을 눌렀는데 연결된 적이 없어 «가입된 학원 계정이 없습니다»가 나왔다.
// 지키는 약속:
//  (a) 직원 화면은 직원 문지기를 쓰고, 앱→바깥 브라우저 1회용 표(handoff)를 만들지 않는다
//  (b) 연결 시작은 학부모 → 직원 순으로 확인하고 둘 다 아니면 거절한다
//  (c) 돌아갈 화면은 주소 파라미터가 아니라 서버가 로그인한 계정으로 정한다
//  (d) 브라우저 간편로그인 콜백이 직원 계정을 /auth/continue 로 보낸다(예전엔 학부모 가입 화면)
//  (e) 1회용 표 대상 판정(isLinkHandoffEligible)은 여전히 직원을 거절한다
// 보안 검수 반영(같은 날):
//  (f) 직원은 주소(GET)만으로 연결을 시작하지 못한다 — 학부모 GET 은 예전 그대로
//  (g) 연결 시작 POST 는 출처 검사를 통과해야 한다
//  (h) 직원 화면의 오류는 주소의 «코드»를 표로 바꾼 것만 보인다(주소의 문장은 읽지 않는다)
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
  // 직원은 GET 으로 시작하지 않는다 — 직원 거절이 연결 호출보다 먼저다(실행 확인은 아래 «(f)» 테스트)
  // 예외 하나(2026-11-17): 방금 이 브라우저에서 본인인증으로 그 계정에 로그인된 직후 — 서버가 구운 1회용 표식이
  // «지금 로그인한 계정 + 이 제공자»와 맞을 때만 직원 GET 시작을 통과시킨다. 표식 확인도 연결 호출보다 먼저다.
  const staffRejectAt = block.indexOf('if (actor === "staff" && !justVerified) return loginError(request, "", actor, "start");');
  const verifiedAt = block.indexOf("await isLinkStartForCurrentUser(request.cookies.get(LINK_START_COOKIE)?.value, provider)");
  assert.ok(verifiedAt > rejectAt && staffRejectAt > verifiedAt && linkCallAt > staffRejectAt, "직원 GET: 표식 확인 → 거절 → 연결 순서");
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
  assert.match(linkBranch, /return linkErrorRedirect\(request, actor, message, staffCode\);/);
  assert.doesNotMatch(linkBranch, /searchParams\.get\(/, "연결 복귀 주소에 요청 파라미터를 쓰지 않는다");
  // 복귀 주소를 만드는 곳은 한 함수 — 판정된 actor 로만 화면을 고르고, 요청 파라미터를 읽지 않는다
  const redirectHelper = start.slice(start.indexOf("function linkErrorRedirect("), start.indexOf("async function loginError("));
  assert.match(redirectHelper, /const url = new URL\(loginMethodsPath\(actor\), request\.url\);/);
  assert.doesNotMatch(redirectHelper, /searchParams\.get\(/);
  // knownActor 는 라우트 안에서 판정한 값만 넘긴다(요청에서 읽은 값이 아니다)
  const calls = [...start.matchAll(/loginError\(request, [^\n]*?, (actor|null|undefined)(?:, "\w+")?\);/g)].map((match) => match[1]);
  assert.deepEqual(calls.sort(), ["actor", "actor", "null", "undefined"]);
  const helperActors = [...start.matchAll(/linkErrorRedirect\(\s*request,\s*([^,]+),/g)].map((match) => match[1].trim()).sort();
  assert.deepEqual(helperActors, ["actor", "await resolveLinkActor()", "await resolveLinkActor()", "await resolveLinkActor()", "linkActor", "null"]);

  // 콜백의 연결 마무리
  const redirectFn = callback.slice(callback.indexOf("async function loginMethodsPageRedirect("), callback.indexOf("async function appLinkDoneRedirect("));
  assert.match(redirectFn, /const actor = await resolveLinkActor\(\);\s*const url = new URL\(loginMethodsPath\(actor\), request\.url\);/);
  assert.doesNotMatch(redirectFn, /searchParams\.get\(/);
  const finish = callback.slice(callback.indexOf("async function finishLink("), callback.indexOf("export async function GET("));
  // 연결 마무리는 next·redirect·return 같은 «돌아갈 곳» 파라미터를 읽지 않는다
  const readParams = [...finish.matchAll(/searchParams\.get\("([^"]+)"\)/g)].map((match) => match[1]).sort();
  assert.deepEqual(readParams, ["error_code", "via"]);
  // 성공·실패 모두 같은 복귀 함수를 지난다(앱 handoff 분기는 그대로)
  assert.match(finish, /: loginMethodsPageRedirect\(request, \{ error: message, code: doneCode \}\)/);
  assert.match(finish, /: loginMethodsPageRedirect\(request, \{ linked: provider \}\);/);
  // 두 주소는 규칙 파일에만 적혀 있다(라우트에 직접 적지 않는다)
  for (const source of [start, callback]) assert.doesNotMatch(source, /"\/(staff\/)?mypage\/login-methods"/);
});

test("(a) 직원 연결 화면: 직원 문지기 · 1회용 표를 만들지 않는다 · 연결 버튼은 폼 POST", () => {
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
  // 내용 구성은 학부모 화면과 같다: 켜진 제공자 + 연결된 것, 성공·실패 안내
  assert.match(staffPage, /getEnabledParentOAuthProviders\(\)/);
  assert.match(staffPage, /PARENT_OAUTH_PROVIDERS\.filter\(\(provider\) => enabled\.includes\(provider\) \|\| linked\.has\(provider\)\)/);
  // (c') 실패 안내는 주소의 코드(e)를 표로 바꾼 것만 — 주소의 문장(error)은 읽지 않는다
  assert.match(staffPage, /const error = staffLinkErrorMessage\(params\.e\);/);
  assert.doesNotMatch(staffPage, /params\.error|customerMessage|error\?: string/, "직원 화면은 주소의 문장을 읽지 않는다");
  // 주소에서 읽는 값은 linked(정해진 제공자 이름일 때만)와 e 둘뿐
  assert.deepEqual([...new Set([...staffPage.matchAll(/params\.(\w+)/g)].map((match) => match[1]))].sort(), ["e", "linked"]);
  assert.match(staffPage, /parseParentOAuthProvider\(params\.linked \?\? ""\)/);
  // 앱 판정: 서버(사용자 에이전트) + 화면(useStoreApp) — 학부모 화면과 같은 판정 재사용
  assert.match(staffPage, /looksLikeStoreApp\(\{ userAgent: requestHeaders\.get\("user-agent"\) \}\)/);
  assert.match(staffButton, /const clientStoreApp = useStoreApp\(\);/);
  // (d') 연결 버튼 = 폼 POST 의 제출 버튼. 주소(GET)로 여는 링크가 아니다 → 미리 불러오기도, 남이 보낸 링크로 시작하기도 안 된다
  assert.match(staffButton, /<form method="post" action=\{`\/auth\/oauth\/\$\{provider\}\?intent=link`\} className="shrink-0">/);
  assert.match(staffButton, /<button type="submit" className="academy-button-tonal shrink-0">\s*연결하기\s*<\/button>/);
  assert.doesNotMatch(staffButton, /<a\b|href=|<Link\b/, "시작 주소를 링크로 두지 않는다");
  assert.doesNotMatch(staffButton, /onSubmit|onClick|fetch\(/, "자바스크립트 없이 폼 그대로 보낸다");
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

// ── 2026-11-17 보안 검수 반영: 직원 연결 시작 = 폼 POST + 출처 확인, 직원 화면 오류 = 코드 ──

test("(g) 출처 판정: 우리 화면에서 보낸 폼만 통과한다(실행)", () => {
  const allowed = handoffRules.isAllowedLinkHandoffOrigin;
  const self = "https://www.stiz-dasan.kr";
  // 운영 출처 · 요청을 받은 서버 자신의 출처(개발 서버·미리보기 배포)
  assert.equal(allowed(self, self, "same-origin"), true);
  assert.equal(allowed("http://localhost:4000", "http://localhost:4000", null), true);
  // 다른 사이트 출처는 거절 — 비슷하게 생긴 주소·apex·http 도 마찬가지
  for (const origin of ["https://evil.example", "https://www.stiz-dasan.kr.evil.example", "https://stiz-dasan.kr", "http://www.stiz-dasan.kr"]) {
    assert.equal(allowed(origin, "http://localhost:4000", "cross-site"), false, origin);
  }
  // 출처가 없으면 거절(빈 문자열 포함)
  for (const origin of [null, undefined, ""]) assert.equal(allowed(origin, self, "same-origin"), false, String(origin));
  // 출처가 «null» 이면 브라우저가 붙이는 Sec-Fetch-Site 가 same-origin 일 때만
  assert.equal(allowed("null", self, "same-origin"), true);
  for (const site of ["cross-site", "same-site", "none", null, undefined]) assert.equal(allowed("null", self, site), false, String(site));
  // 시작 라우트의 POST 가 바로 이 함수로, 요청 머리말(Origin·Sec-Fetch-Site)과 서버 자신의 출처를 넣어 판정한다
  assert.match(start, /import \{ isAllowedLinkHandoffOrigin \} from "@\/lib\/account-link-handoff\/rules";/);
  const post = start.slice(start.indexOf("export async function POST("));
  assert.match(post, /if \(!isAllowedLinkHandoffOrigin\(request\.headers\.get\("origin"\), request\.nextUrl\.origin, request\.headers\.get\("sec-fetch-site"\)\)\) \{/);
});

// 시작 라우트를 «실제로 실행»한다 — 바깥 의존(Next 응답·제공자 설정·본인 확인·Supabase)만 흉내 모듈로 바꾼다.
// 규칙 파일(login-methods-rules·account-link-handoff/rules·parent-oauth)은 진짜를 쓴다.
const stub = (code) => `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const startRoute = await loadTsModule("src/app/auth/oauth/[provider]/route.ts", {
  overrides: {
    "next/server": stub(`
      export class NextRequest {}
      export class NextResponse {
        constructor(body, init) { this.status = init?.status ?? 200; this.location = null; }
        static redirect(url, status) { const r = new NextResponse(null, { status: status ?? 307 }); r.location = String(url); return r; }
      }
    `),
    "@/lib/auth-providers": stub(`export async function getEnabledParentOAuthProviders() { return globalThis.__linkRoute.enabled; }`),
    "@/lib/account/link-actor": stub(`export async function resolveLinkActor() { return globalThis.__linkRoute.actor; }`),
    // 본인인증 직후 표식 확인(2026-11-17) — 표식 자체의 위조·만료 검증은 native-app-login-production 테스트가 실행으로 못박는다
    "@/lib/account/link-start-session": stub(`export async function isLinkStartForCurrentUser(token, provider) { globalThis.__linkRoute.startChecks.push([token, provider]); return globalThis.__linkRoute.justVerified === true; }`),
    "@/lib/supabase/server": stub(`
      export async function createClient() {
        return { auth: {
          async linkIdentity(input) {
            globalThis.__linkRoute.linkCalls.push(input);
            return globalThis.__linkRoute.linkFails
              ? { data: { url: null }, error: new Error("x") }
              : { data: { url: "https://provider.example/authorize" }, error: null };
          },
          async signInWithOAuth() { globalThis.__linkRoute.signInCalls += 1; return { data: { url: "https://provider.example/login" }, error: null }; },
        } };
      }
    `),
  },
});

const SITE = "http://localhost:4000";
function linkRequest(method, { provider = "apple", query = "?intent=link", headers = {}, form = null } = {}) {
  const nextUrl = new URL(`/auth/oauth/${provider}${query}`, SITE);
  const lower = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    method,
    url: nextUrl.toString(),
    nextUrl,
    headers: { get: (name) => lower[name.toLowerCase()] ?? null },
    cookies: { get: (name) => (globalThis.__linkRoute?.cookies?.[name] ? { name, value: globalThis.__linkRoute.cookies[name] } : undefined) },
    formData: async () => { if (!form) throw new Error("no body"); return new Map(Object.entries(form)); },
  };
}
async function runLink(method, state, requestOptions = {}) {
  globalThis.__linkRoute = { enabled: ["apple", "google"], actor: null, linkFails: false, justVerified: false, cookies: {}, ...state, linkCalls: [], signInCalls: 0, startChecks: [] };
  const provider = requestOptions.provider ?? "apple";
  const response = await startRoute[method](linkRequest(method, requestOptions), { params: Promise.resolve({ provider }) });
  const location = response.location ? new URL(response.location) : null;
  return {
    status: response.status,
    path: location ? location.origin === SITE ? location.pathname : location.origin + location.pathname : null,
    query: location ? Object.fromEntries(location.searchParams) : null,
    linkCalls: globalThis.__linkRoute.linkCalls.length,
    signInCalls: globalThis.__linkRoute.signInCalls,
  };
}
const SAME_ORIGIN = { Origin: SITE, "Sec-Fetch-Site": "same-origin" };

test("(f) 직원의 GET intent=link 는 연결을 시작하지 않는다 — 학부모 GET 은 예전 그대로(실행)", async () => {
  // 직원: linkIdentity 를 부르지 않고 직원 연결 화면으로, 코드만 싣는다
  assert.deepEqual(await runLink("GET", { actor: "staff" }), {
    status: 307, path: "/staff/mypage/login-methods", query: { e: "start" }, linkCalls: 0, signInCalls: 0,
  });
  // 학부모: 지금처럼 GET 으로 제공자 화면까지 간다
  assert.deepEqual(await runLink("GET", { actor: "parent" }), {
    status: 307, path: "https://provider.example/authorize", query: {}, linkCalls: 1, signInCalls: 0,
  });
  // 로그인 없음: 예전처럼 학부모 화면 + 문장
  assert.deepEqual(await runLink("GET", { actor: null }), {
    status: 307, path: "/mypage/login-methods", query: { error: "로그인한 뒤 연결해 주세요." }, linkCalls: 0, signInCalls: 0,
  });
  // 학부모의 실패 안내도 예전 그대로 문장(error)이다 — 코드(e)를 싣지 않는다
  const parentFail = await runLink("GET", { actor: "parent", linkFails: true });
  assert.equal(parentFail.path, "/mypage/login-methods");
  assert.deepEqual(Object.keys(parentFail.query), ["error"]);
  assert.match(parentFail.query.error, /^Apple .*연결을 시작하지 못했습니다/);
  const parentClosed = await runLink("GET", { actor: "parent", enabled: [] });
  assert.deepEqual(Object.keys(parentClosed.query), ["error"]);
  // 직원: 꺼진 제공자도 코드로
  assert.deepEqual((await runLink("GET", { actor: "staff", enabled: [] })).query, { e: "closed" });
  // 예외(2026-11-17): 방금 본인인증으로 그 계정에 로그인된 직후(서버가 구운 표식이 지금 계정·제공자와 맞음)면 직원도 GET 으로 시작한다
  assert.deepEqual(await runLink("GET", { actor: "staff", justVerified: true, cookies: { "stiz-link-start": "token" } }), {
    status: 307, path: "https://provider.example/authorize", query: {}, linkCalls: 1, signInCalls: 0,
  });
  assert.deepEqual(globalThis.__linkRoute.startChecks, [["token", "apple"]], "표식은 쿠키 값·제공자로 확인한다");
  // 표식이 맞지 않으면(없음·만료·다른 계정) 지금처럼 막는다
  assert.deepEqual((await runLink("GET", { actor: "staff", justVerified: false, cookies: { "stiz-link-start": "stale" } })).query, { e: "start" });
});

test("(g) POST 연결 시작: 출처 검사를 통과해야 linkIdentity 까지 간다(실행)", async () => {
  // 우리 화면에서 보낸 폼 + 직원 → 제공자 화면으로 303
  assert.deepEqual(await runLink("POST", { actor: "staff" }, { headers: SAME_ORIGIN }), {
    status: 303, path: "https://provider.example/authorize", query: {}, linkCalls: 1, signInCalls: 0,
  });
  // 학부모도 받는다(더 안전한 길이라 막지 않는다)
  assert.equal((await runLink("POST", { actor: "parent" }, { headers: SAME_ORIGIN })).linkCalls, 1);
  // 다른 사이트가 보낸 폼 · 출처 없음 · 출처 «null»+cross-site → 연결을 시작하지 않고 직원 화면에 코드 origin
  for (const headers of [
    { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    {},
    { Origin: "null", "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-origin" },
  ]) {
    assert.deepEqual(await runLink("POST", { actor: "staff" }, { headers }), {
      status: 303, path: "/staff/mypage/login-methods", query: { e: "origin" }, linkCalls: 0, signInCalls: 0,
    }, JSON.stringify(headers));
  }
  // 출처가 틀리면 학부모도 시작하지 못한다(학부모 화면에는 문장으로)
  const parentCross = await runLink("POST", { actor: "parent" }, { headers: { Origin: "https://evil.example" } });
  assert.equal(parentCross.linkCalls, 0);
  assert.equal(parentCross.path, "/mypage/login-methods");
  assert.deepEqual(Object.keys(parentCross.query), ["error"]);
  // 로그인 없음 · 꺼진 제공자 · 모르는 제공자 · 제공자 쪽 실패 → 시작하지 않고 303 으로 돌려보낸다
  assert.deepEqual(await runLink("POST", { actor: null }, { headers: SAME_ORIGIN }), {
    status: 303, path: "/mypage/login-methods", query: { error: "로그인한 뒤 연결해 주세요." }, linkCalls: 0, signInCalls: 0,
  });
  assert.deepEqual((await runLink("POST", { actor: "staff", enabled: [] }, { headers: SAME_ORIGIN })).query, { e: "closed" });
  assert.deepEqual((await runLink("POST", { actor: "staff" }, { headers: SAME_ORIGIN, provider: "nope" })).query, { e: "failed" });
  const failed = await runLink("POST", { actor: "staff", linkFails: true }, { headers: SAME_ORIGIN });
  assert.deepEqual({ status: failed.status, query: failed.query, linkCalls: failed.linkCalls }, { status: 303, query: { e: "start" }, linkCalls: 1 });
  // POST 는 연결 전용 — intent 가 link 가 아니면(로그인·가입·없음) 아무것도 하지 않는다. 폼 본문의 intent=link 는 받는다
  for (const query of ["?intent=login", "?intent=parent-signup", ""]) {
    assert.deepEqual(await runLink("POST", { actor: "staff" }, { headers: SAME_ORIGIN, query }), {
      status: 405, path: null, query: null, linkCalls: 0, signInCalls: 0,
    }, query);
  }
  assert.equal((await runLink("POST", { actor: "staff" }, { headers: SAME_ORIGIN, query: "", form: { intent: "link" } })).linkCalls, 1);
  assert.equal((await runLink("POST", { actor: "staff" }, { headers: SAME_ORIGIN, query: "", form: { intent: "login" } })).status, 405);
});

test("(h) 직원 화면의 오류: 코드 → 정해 둔 문구만, 임의 문장은 나오지 않는다(실행)", () => {
  const message = rules.staffLinkErrorMessage;
  const table = rules.STAFF_LINK_ERROR_MESSAGES;
  assert.deepEqual(Object.keys(table).sort(), ["already", "cancelled", "closed", "expired", "failed", "origin", "start"]);
  for (const [code, text] of Object.entries(table)) {
    assert.equal(message(code), text, code);
    assert.match(text, /[가-힣]/);
  }
  // 임의 문장·모르는 코드·빈 값·물려받은 이름·문자열이 아닌 값 → 아무것도 보이지 않는다
  const odd = [
    "비밀번호가 만료되었습니다. 010-0000-0000 으로 전화해 주세요.", "<b>학원 공지</b>", "START", " start", "start ",
    "unknown", "", null, undefined, "constructor", "toString", "__proto__", "hasOwnProperty", ["start"], { code: "start" }, 0,
  ];
  for (const value of odd) assert.equal(message(value), null, String(value));
  // 콜백이 넘기는 마무리 코드(앱 완료 화면과 같은 이름)는 전부 직원 표에 있다 — 빠지면 안내가 사라진다
  for (const code of Object.keys(handoffRules.LINK_DONE_ERROR_MESSAGES)) assert.ok(message(code), code);
  // 콜백의 실패 → 코드 대응(빠짐없이)
  const finish = callback.slice(callback.indexOf("async function finishLink("), callback.indexOf("export async function GET("));
  assert.deepEqual([...finish.matchAll(/fail\("(\w+)"/g)].map((match) => match[1]), ["failed", "already", "cancelled", "expired"]);
  assert.match(finish, /if \(!provider\) return fail\("failed",/);
  assert.match(finish, /if \(errorCode === "identity_already_exists"\) \{\s*return fail\("already",/);
  assert.match(finish, /return fail\("cancelled",/);
  assert.match(finish, /if \(error\) return fail\("expired",/);
  // 직원이면 코드만(e), 그 밖은 예전처럼 문장(error) — 한 요청에 둘을 같이 싣지 않는다
  const redirectFn = callback.slice(callback.indexOf("async function loginMethodsPageRedirect("), callback.indexOf("async function appLinkDoneRedirect("));
  assert.match(redirectFn, /if \(actor === "staff"\) url\.searchParams\.set\("e", result\.code \?\? "failed"\);\s*else url\.searchParams\.set\("error", result\.error\);/);
  const helper = start.slice(start.indexOf("function linkErrorRedirect("), start.indexOf("async function loginError("));
  assert.match(helper, /if \(actor === "staff"\) url\.searchParams\.set\("e", staffCode\);\s*else url\.searchParams\.set\("error", message\);/);
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
