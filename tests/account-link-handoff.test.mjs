import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { loadTsModule } from "./_ts-module.mjs";

// 앱에서 간편로그인 «연결하기»(2026-11-15 원장 승인 A안).
// 앱 화면이 1회용 표를 붙인 apex 주소(https://stiz-dasan.kr/...)를 «누르면» 앱이 휴대폰 기본 브라우저로 열고,
// 그 브라우저가 표 주인 계정으로 잠깐 들어가 연결을 마친 뒤 바로 로그아웃한다.

const rules = await loadTsModule("src/lib/account-link-handoff/rules.ts");
const token = await loadTsModule("src/lib/account-link-handoff/token.ts");
const read = (file) => fs.readFileSync(file, "utf8");

// ── 순수 규칙(실행해서 확인) ─────────────────────────────────────────────
test("1회용 표: 43글자 base64url, 매번 다르고, DB 에는 SHA-256 hash 만 저장한다", () => {
  const a = token.newLinkHandoffToken();
  const b = token.newLinkHandoffToken();
  assert.match(a, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  const id = token.linkHandoffTokenId(a);
  assert.equal(id, createHash("sha256").update(a).digest("base64url"));
  assert.notEqual(id, a, "원문 토큰을 그대로 저장하지 않는다");
  assert.equal(token.isLinkHandoffToken(a), true);
  for (const bad of [undefined, null, 42, "", "a".repeat(42), "a".repeat(44), "+".repeat(43), `${"a".repeat(42)}=`]) {
    assert.equal(token.isLinkHandoffToken(bad), false, String(bad));
  }
});

test("앱 버튼 주소는 www 가 없는 apex 다(www 면 앱 안에서 열려 기능이 무너진다)", () => {
  const t = "A".repeat(43);
  const url = new URL(rules.linkHandoffUrl(t));
  assert.equal(url.origin, "https://stiz-dasan.kr");
  assert.equal(url.pathname, "/auth/link-handoff");
  assert.equal(url.searchParams.get("t"), t);
  assert.equal([...url.searchParams.keys()].length, 1, "표 말고 다른 값은 싣지 않는다");
  assert.equal(rules.LINK_HANDOFF_TTL_SECONDS, 300, "표 수명 5분(검수 반영)");
});

test("버튼 그리기 방식: 앱 표식 + 스위치 켜짐일 때만 바깥 브라우저 링크", () => {
  assert.equal(rules.linkButtonMode({ storeAppUserAgent: true, nativeAuthEnabled: true }), "handoff");
  assert.equal(rules.linkButtonMode({ storeAppUserAgent: true, nativeAuthEnabled: false }), "hidden");
  assert.equal(rules.linkButtonMode({ storeAppUserAgent: false, nativeAuthEnabled: true }), "client");
  assert.equal(rules.linkButtonMode({ storeAppUserAgent: false, nativeAuthEnabled: false }), "client");
});

test("완료 화면 계정 이름은 가린다(아이디 앞 2글자 + 별 4개, 없으면 이름 첫 글자)", () => {
  assert.equal(rules.maskAccountLabel({ username: "snowman77", name: "김수빈" }), "아이디 sn****");
  assert.equal(rules.maskAccountLabel({ username: "abc" }), "아이디 ab****");
  assert.equal(rules.maskAccountLabel({ username: "ab" }), "아이디 a****", "2글자 아이디는 1글자만");
  assert.equal(rules.maskAccountLabel({ username: "  ", name: "김수빈" }), "김** 님");
  assert.equal(rules.maskAccountLabel({ username: null, name: null }), "이 계정");
  assert.equal(rules.maskAccountLabel({}), "이 계정");
  // 별 개수가 길이를 드러내지 않는다
  assert.equal(rules.maskAccountLabel({ username: "abcdefghijklmnop" }), "아이디 ab****");
  // 완료 화면은 이 모양만 보인다(주소로 임의 문장을 넣어도 안 보임)
  for (const ok of ["아이디 sn****", "아이디 a****", "김** 님"]) assert.equal(rules.isMaskedAccountLabel(ok), true, ok);
  for (const bad of ["", null, undefined, "아이디 snow****", "아이디 sn***", "학원에 전화하세요", "아이디 s*****", "김수빈 님"]) {
    assert.equal(rules.isMaskedAccountLabel(bad), false, String(bad));
  }
});

test("확인 화면은 가린 아이디 + 가린 이름을 함께 보인다(내 계정인지 알아보기)", () => {
  assert.equal(rules.maskPersonName("김수빈"), "김*빈");
  assert.equal(rules.maskPersonName("김수"), "김*");
  assert.equal(rules.maskPersonName("남궁민수"), "남**수");
  assert.equal(rules.maskPersonName("김"), "*");
  assert.equal(rules.maskPersonName("  "), "");
  assert.equal(rules.maskPersonName(null), "");
  assert.equal(rules.confirmAccountLabel({ username: "snowman77", name: "김수빈" }), "아이디 sn**** · 김*빈 님");
  assert.equal(rules.confirmAccountLabel({ username: "snowman77", name: null }), "아이디 sn****");
  assert.equal(rules.confirmAccountLabel({ username: null, name: "김수빈" }), "김*빈 님");
  assert.equal(rules.confirmAccountLabel({}), "이 계정");
});

test("앱 연결 대상 계정: 학부모 하나 · 직원 역할 없음 · 휴대폰 인증 · 탈퇴(요청) 아님", () => {
  const ok = { role: "PARENT", hasActiveStaffGrant: false, phoneVerifiedAt: new Date(), withdrawnAt: null, withdrawRequestedAt: null };
  assert.equal(rules.isLinkHandoffEligible([ok]), true);
  assert.equal(rules.isLinkHandoffEligible([]), false, "앱 계정 없음");
  assert.equal(rules.isLinkHandoffEligible([ok, ok]), false, "계정이 둘");
  for (const change of [
    { role: "ADMIN" }, { role: "VICE_ADMIN" }, { role: "INSTRUCTOR" }, { role: "DRIVER" },
    { hasActiveStaffGrant: true }, { phoneVerifiedAt: null }, { withdrawnAt: new Date() }, { withdrawRequestedAt: "2026-11-15T00:00:00Z" },
  ]) {
    assert.equal(rules.isLinkHandoffEligible([{ ...ok, ...change }]), false, JSON.stringify(change));
  }
});

test("시작(POST) 출처: 운영 www·서버 자신 통과, Origin null 은 Sec-Fetch-Site same-origin 일 때만", () => {
  assert.equal(rules.isAllowedLinkHandoffOrigin("https://www.stiz-dasan.kr", "https://x.vercel.app"), true);
  assert.equal(rules.isAllowedLinkHandoffOrigin("http://localhost:4000", "http://localhost:4000"), true);
  assert.equal(rules.isAllowedLinkHandoffOrigin("https://evil.example", "https://www.stiz-dasan.kr"), false);
  assert.equal(rules.isAllowedLinkHandoffOrigin("https://evil.example", "https://www.stiz-dasan.kr", "same-origin"), false, "출처가 있으면 출처로만 판정");
  assert.equal(rules.isAllowedLinkHandoffOrigin("https://stiz-dasan.kr.evil.example", "https://www.stiz-dasan.kr"), false);
  assert.equal(rules.isAllowedLinkHandoffOrigin("null", "https://www.stiz-dasan.kr", "same-origin"), true);
  for (const site of ["cross-site", "same-site", "none", null, undefined, ""]) {
    assert.equal(rules.isAllowedLinkHandoffOrigin("null", "https://www.stiz-dasan.kr", site), false, String(site));
  }
  assert.equal(rules.isAllowedLinkHandoffOrigin(null, "https://www.stiz-dasan.kr", "same-origin"), false);
  assert.equal(rules.isAllowedLinkHandoffOrigin("", "https://www.stiz-dasan.kr"), false);
});

test("완료 화면 주소·오류 코드: 문장 대신 정해 둔 코드만", () => {
  assert.equal(rules.linkHandoffDonePath({ linked: "apple" }), "/auth/link-handoff/done?linked=apple");
  const ok = new URL(rules.linkHandoffDonePath({ linked: "apple", account: "아이디 sn****" }), "https://x.test");
  assert.equal(ok.searchParams.get("acct"), "아이디 sn****");
  assert.equal(new URL(rules.linkHandoffDonePath({ linked: "apple", account: "아무 문장" }), "https://x.test").searchParams.has("acct"), false);
  assert.equal(rules.linkHandoffDonePath({ code: "already" }), "/auth/link-handoff/done?e=already");
  assert.equal(rules.linkHandoffDonePath({ linked: "apple", code: "expired" }), "/auth/link-handoff/done?e=expired", "실패가 우선");
  assert.equal(rules.linkHandoffDonePath({}), "/auth/link-handoff/done");
  for (const code of ["already", "cancelled", "expired", "failed"]) assert.match(rules.linkDoneErrorMessage(code), /[가-힣]/);
  for (const bad of ["", null, undefined, "toString", "__proto__", "아무 문장"]) {
    assert.equal(rules.linkDoneErrorMessage(bad), rules.LINK_DONE_ERROR_MESSAGES.failed, String(bad));
  }
  for (const code of ["expired", "origin", "closed", "account", "failed"]) {
    assert.match(rules.linkHandoffErrorMessage(code), /[가-힣]/);
  }
  assert.equal(rules.linkHandoffErrorMessage("expired"), "연결 시간이 지났어요. 앱에서 다시 눌러 주세요.");
  for (const bad of ["", null, undefined, "toString", "__proto__", "아무 문장"]) assert.equal(rules.linkHandoffErrorMessage(bad), null);
});

test("세션 쿠키 이름: 로그인 세션과 조각만, PKCE 열쇠 쿠키는 아니다", () => {
  assert.deepEqual(rules.supabaseSessionCookieNames("https://abcdref.supabase.co"), [
    "sb-abcdref-auth-token", "sb-abcdref-auth-token.0", "sb-abcdref-auth-token.1",
    "sb-abcdref-auth-token.2", "sb-abcdref-auth-token.3", "sb-abcdref-auth-token.4",
  ]);
  assert.deepEqual(rules.supabaseSessionCookieNames("not a url"), []);
  assert.equal(rules.isSupabaseSessionCookieName("sb-abcdref-auth-token"), true);
  assert.equal(rules.isSupabaseSessionCookieName("sb-abcdref-auth-token.1"), true);
  assert.equal(rules.isSupabaseSessionCookieName("sb-abcdref-auth-token-code-verifier"), false);
  assert.equal(rules.isSupabaseSessionCookieName("stiz-link-app"), false);
});

test("화면 부품이 import 하는 규칙 파일에는 node:crypto 가 없다(브라우저 번들 깨짐 방지)", () => {
  assert.doesNotMatch(read("src/lib/account-link-handoff/rules.ts"), /^import.*crypto/m);
  assert.doesNotMatch(read("src/app/mypage/login-methods/LinkProviderButton.tsx"), /account-link-handoff\/(token|store)/);
});

// ── DB 표·저장소 ─────────────────────────────────────────────────────────
test("마이그레이션: 원문 토큰 칸 없음 · provider CHECK · RLS + 공개 권한 회수 · 만료 인덱스", () => {
  const sql = read("prisma/migrations/20261115020000_account_link_handoff/migration.sql");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\."AccountLinkHandoff"/);
  assert.match(sql, /provider text NOT NULL CHECK \(provider IN \('google','kakao','naver','apple'\)\)/);
  assert.match(sql, /"expiresAt" timestamptz NOT NULL/);
  assert.match(sql, /"consumedAt" timestamptz,/);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /REVOKE ALL ON public\."AccountLinkHandoff" FROM PUBLIC/);
  assert.match(sql, /REVOKE ALL ON public\."AccountLinkHandoff" FROM anon/);
  assert.match(sql, /REVOKE ALL ON public\."AccountLinkHandoff" FROM authenticated/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "AccountLinkHandoff_expiry"/);
  const ddl = sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  assert.doesNotMatch(ddl, /\btoken\b/i, "원문 토큰 칸을 만들지 않는다");
  const schema = read("prisma/schema.prisma");
  assert.match(schema, /model AccountLinkHandoff \{/);
  assert.match(read("src/lib/dataRetention.ts"), /DELETE FROM "AccountLinkHandoff" WHERE "expiresAt" < NOW\(\)-INTERVAL '1 day'/);
});

test("저장소: raw SQL 만, 확인은 읽기만, 사용은 조건부 UPDATE 한 문장(원자적), 발급 때 옛 표 무효화", () => {
  const store = read("src/lib/account-link-handoff/store.ts");
  assert.doesNotMatch(store, /prisma\.\w+\.(findMany|findFirst|findUnique|create|update|upsert|delete)/, "ORM 기본 메서드 금지");
  const peekAt = store.indexOf("export async function peekLinkHandoff");
  const peek = store.slice(peekAt, store.indexOf("return rows[0]", peekAt));
  assert.doesNotMatch(peek, /UPDATE|DELETE/, "확인 화면은 표를 쓰지 않는다(링크 미리보기 안전)");
  assert.match(peek, /"consumedAt" IS NULL AND "expiresAt" > now\(\)/);
  const consume = store.slice(store.indexOf("export async function consumeLinkHandoff"), store.indexOf("export async function linkHandoffAccountLabel"));
  assert.match(consume, /UPDATE "AccountLinkHandoff" SET "consumedAt" = now\(\)\s+WHERE id = \$1 AND "consumedAt" IS NULL AND "expiresAt" > now\(\)\s+RETURNING "authUserId", provider/);
  assert.match(store, /linkHandoffTokenId\(token\)/, "조회는 hash 로");
  assert.match(store, /now\(\) \+ \(\$4::int \* interval '1 second'\)/, "만료 시각은 DB now() 기준");
  // 같은 계정·제공자의 안 쓴 표는 새 표를 넣는 같은 문장에서 막는다(동시에 유효한 표 1개)
  assert.match(store, /WITH revoked AS \(\s*UPDATE "AccountLinkHandoff" SET "consumedAt" = now\(\)\s+WHERE "authUserId" = \$3 AND provider = ANY\(\$2::text\[\]\) AND "consumedAt" IS NULL/);
  // 계정 판정 줄: 직접 연결된 계정 · 활성 직원 추가 역할 · 탈퇴 칸
  const rowsFn = store.slice(store.indexOf("export async function linkHandoffAccountRows"));
  assert.match(rowsFn, /g\.status = 'ACTIVE'/);
  assert.match(rowsFn, /u\."withdrawnAt", u\."withdrawRequestedAt"/);
  assert.match(rowsFn, /WHERE u\."authUserId" = \$1/);
});

// ── 연결 화면(앱에서 발급) ─────────────────────────────────────────────
test("연결 화면: 앱 + 스위치 + 대상 계정일 때만, 본인(parent.id)에게, 아직 연결 안 된 켜진 제공자만 발급", () => {
  const page = read("src/app/mypage/login-methods/page.tsx");
  const guardAt = page.indexOf('if (!parent) redirect("/mypage/continue?bounced=1")');
  const eligibleAt = page.indexOf("isLinkHandoffEligible(await linkHandoffAccountRows(parent.id).catch(() => []))");
  const issueAt = page.indexOf("issueLinkHandoffs(parent.id, pending)");
  assert.ok(guardAt > 0 && eligibleAt > guardAt && issueAt > eligibleAt, "학부모 확인 → 계정 판정 → 발급 순서");
  assert.match(page, /looksLikeStoreApp\(\{ userAgent: requestHeaders\.get\("user-agent"\) \}\)/);
  assert.match(page, /nativeAuthEnabled: nativeAuthEnabled\(\)/);
  assert.match(page, /if \(mode === "handoff" && eligible\) \{/);
  assert.match(page, /rows\.filter\(\(provider\) => enabled\.includes\(provider\) && !linked\.has\(provider\)\)/);
  assert.match(page, /\.catch\(\(issueError: unknown\) =>/, "표를 못 만들어도 화면은 열린다(지금처럼 숨김)");
});

test("앱 버튼: 일반 <a> 한 번 탭(자바스크립트 이동·<Link> 금지) + 안내 + 돌아오면 새로 그림", () => {
  const button = read("src/app/mypage/login-methods/LinkProviderButton.tsx");
  assert.match(button, /<a href=\{handoffHref\} rel="noreferrer noopener"/);
  assert.doesNotMatch(button, /from "next\/link"/);
  assert.doesNotMatch(button, /location\.(href|assign|replace)|window\.open/);
  assert.match(button, /\{LINK_HANDOFF_BUTTON_NOTICE\}/);
  assert.equal(rules.LINK_HANDOFF_BUTTON_NOTICE, "휴대폰 브라우저가 열려요. 연결 후 앱으로 돌아와 주세요.");
  assert.match(button, /document\.visibilityState === "visible"\) router\.refresh\(\)/);
  // 표가 없으면 기존 동작(브라우저 = 기존 연결 링크, 앱 = 숨김) 그대로
  assert.match(button, /if \(storeApp !== false\) return null;/);
});

// ── 바깥 브라우저 확인·시작·완료 ───────────────────────────────────────
test("확인 화면: 읽기만, [계속]은 폼 POST, referrer same-origin(Origin null 방지), 주소의 t 지우기", () => {
  const page = read("src/app/auth/link-handoff/page.tsx");
  assert.match(page, /peekLinkHandoff\(token\)/);
  assert.doesNotMatch(page, /consumeLinkHandoff/);
  assert.match(page, /<form method="post" action=\{LINK_HANDOFF_START_PATH\}/);
  assert.match(page, /<input type="hidden" name="t" value=\{token\} \/>/);
  assert.match(page, /referrer: "same-origin"/);
  assert.doesNotMatch(page, /referrer: "no-referrer"/, "no-referrer 면 같은 사이트 POST 에도 Origin null 이 붙을 수 있다");
  assert.match(page, /robots: \{ index: false, follow: false \}/);
  assert.match(page, /export const dynamic = "force-dynamic"/);
  assert.match(page, /confirmAccountLabel\(account \?\? \{\}\)/);
  assert.match(page, /<StripHandoffToken \/>/);
  const strip = read("src/app/auth/link-handoff/StripHandoffToken.tsx");
  assert.match(strip, /url\.searchParams\.delete\("t"\)/);
  assert.match(strip, /window\.history\.replaceState\(window\.history\.state, ""/);
  const config = read("next.config.ts");
  assert.match(config, /source: "\/auth\/link-handoff\/:path\*",\s*headers: \[\s*\{ key: "Cache-Control", value: "no-store" \},\s*\{ key: "X-Robots-Tag", value: "noindex, nofollow" \}/);
});

test("시작(POST) 순서: 출처 → 스위치 → 1회 사용 → 계정·제공자 재확인 → 로그인 → 같은 계정 → 연결 → 세션 끊기 → 표시 쿠키", () => {
  const route = read("src/app/auth/link-handoff/start/route.ts");
  const order = [
    'isAllowedLinkHandoffOrigin(request.headers.get("origin"), request.nextUrl.origin, request.headers.get("sec-fetch-site"))',
    "if (!nativeAuthEnabled())",
    "consumeLinkHandoff(token)",
    "return await startLink(request, claim);",
    "isLinkHandoffEligible(await linkHandoffAccountRows(claim.authUserId))",
    "getEnabledParentOAuthProviders()",
    "admin.auth.admin.getUserById(claim.authUserId)",
    'generateLink({ type: "magiclink", email: ownerEmail })',
    'verifyOtp({ type: "magiclink", token_hash: tokenHash })',
    "signedIn.data.user?.id !== claim.authUserId",
    "supabase.auth.linkIdentity(",
    'admin.auth.admin.signOut(accessToken, "local")',
    "await clearSessionCookies();",
    "cookieStore.set(LINK_HANDOFF_GATE_COOKIE",
    "return NextResponse.redirect(data.url, 303);",
  ];
  // 앞 단계 다음 위치부터 찾는다(세션 쿠키 지우기 헬퍼는 catch 에서도 불린다)
  let last = -1;
  for (const step of order) {
    const at = route.indexOf(step, last + 1);
    assert.ok(at > last, `순서가 어긋남: ${step}`);
    last = at;
  }
  // 표를 쓴 뒤의 예외는 500 대신 e=failed + 세션 쿠키 삭제(보안 재검수 반영)
  assert.match(route, /\} catch \(error\) \{[\s\S]*?await clearSessionCookies\(\)[\s\S]*?return backToConfirm\(request, "failed"\);/);
  const helper = route.slice(route.indexOf("async function clearSessionCookies"));
  assert.match(helper, /cookieStore\.set\(name, "", \{ path: "\/", maxAge: 0 \}\)/);
  assert.match(route, /return backToConfirm\(request, "account"\)/);
  assert.match(route, /callbackUrl\.searchParams\.set\("via", LINK_HANDOFF_VIA\)/);
  assert.match(route, /skipBrowserRedirect: true/);
  // 세션 쿠키만 지운다 — 열쇠 쿠키까지 지우는 클라이언트 signOut 은 성공 경로에서 쓰지 않는다(끊기 실패 경로 한 곳만)
  const success = route.slice(route.indexOf('admin.auth.admin.signOut(accessToken, "local")'));
  assert.equal((success.match(/supabase\.auth\.signOut\(/g) ?? []).length, 1);
  assert.match(route, /isSupabaseSessionCookieName/);
  assert.match(route, /httpOnly: true,\s*secure: request\.nextUrl\.protocol === "https:",\s*sameSite: "lax"/);
  assert.match(route, /NextResponse\.redirect\(url, 303\)/);
  assert.doesNotMatch(route, /signInWithOAuth/);
  assert.equal(rules.LINK_HANDOFF_GATE_COOKIE_PATH, "/auth");
});

test("콜백: via=app «그리고» 표시 쿠키가 있을 때만 앱 마무리(로그아웃+완료 화면·쿠키 삭제), 아니면 기존 그대로", () => {
  const callback = read("src/app/auth/callback/route.ts");
  const done = callback.slice(callback.indexOf("async function appLinkDoneRedirect"), callback.indexOf("async function finishLink"));
  assert.match(done, /signOut\(\{ scope: "local" \}\)/);
  assert.match(done, /cookieStore\.set\(LINK_HANDOFF_GATE_COOKIE, "", \{ path: LINK_HANDOFF_GATE_COOKIE_PATH, maxAge: 0 \}\)/);
  assert.match(done, /linkHandoffDonePath\(\{ linked: result\.linked, account, code: result\.code \}\)/);
  assert.match(done, /maskAccountLabel\(row\)/);
  const finish = callback.slice(callback.indexOf("async function finishLink"), callback.indexOf("export async function GET("));
  assert.match(finish, /const viaAppParam = request\.nextUrl\.searchParams\.get\("via"\) === LINK_HANDOFF_VIA;/);
  // 실패 경로는 via=app + 표시 쿠키(남이 링크로 로그아웃시키기 방지)
  assert.match(finish, /const viaApp = viaAppParam && request\.cookies\.get\(LINK_HANDOFF_GATE_COOKIE\)\?\.value === "1";/);
  assert.match(finish, /viaApp \? appLinkDoneRedirect\(request, \{ code: doneCode \}\) : loginMethodsPageRedirect\(request, \{ error: message \}\)/);
  // 코드 교환 성공 경로는 via=app 만으로 앱 마무리(표시 쿠키 만료 뒤에도 바깥 브라우저 로그인이 남지 않게)
  assert.match(finish, /return viaAppParam\s*\? appLinkDoneRedirect\(request, \{ linked: provider, authUserId: data\.user\?\.id \}\)/);
  for (const code of ["already", "cancelled", "expired", "failed"]) assert.ok(finish.includes(`fail("${code}"`), code);
  // 연결 알림 문자는 그대로
  assert.match(finish, /notifyAccountSecurityEvent\(\{ authUserId: data\.user\?\.id, eventType: "SOCIAL_LOGIN_LINKED"/);
  assert.match(callback, /const url = new URL\("\/mypage\/login-methods", request\.url\);/);
});

test("완료 화면: 코드 → 정해 둔 문구, 가린 아이디는 모양 검사 뒤에만, 아이콘·하드코딩 색 없음", () => {
  const donePage = read("src/app/auth/link-handoff/done/page.tsx");
  assert.match(donePage, /linkDoneErrorMessage\(errorCode\)/);
  assert.match(donePage, /isMaskedAccountLabel\(account\)/);
  assert.doesNotMatch(donePage, /customerMessage|params\.error/, "주소의 임의 문장을 보이지 않는다");
  const files = [donePage, read("src/app/auth/link-handoff/page.tsx"), read("src/app/auth/link-handoff/LinkHandoffShell.tsx")].join("\n");
  assert.match(files, /연결을 마쳤습니다\. 스티즈 앱으로 돌아가 주세요\./);
  assert.doesNotMatch(files, /material-symbols|lucide|<svg|\p{Extended_Pictographic}/u);
  assert.doesNotMatch(files, /font-(extrabold|black)/);
  assert.doesNotMatch(files, /#[0-9a-fA-F]{3,8}\b|rgb\(/);
  assert.doesNotMatch(files, /\b(bg|text|border)-(red|green|blue|gray|slate|neutral|zinc)-\d/);
});

test("바깥 브라우저 경로는 앱 링크(유니버설 링크·앱 링크)에 잡히지 않는다 — 잡히면 앱으로 되돌아와 연결이 안 된다", () => {
  const manifest = read("apps/driver-android/app/src/main/AndroidManifest.xml");
  assert.doesNotMatch(manifest, /link-handoff|android:pathPrefix="\/auth/);
  assert.doesNotMatch(manifest, /android:host="stiz-dasan\.kr"/, "apex 를 앱 링크로 잡지 않는다");
  const aasa = read("src/lib/app-site-association.ts");
  assert.doesNotMatch(aasa, /link-handoff|"\/auth\/\*"|"\/\*"/);
  assert.doesNotMatch(read("apps/stiz-ios/STIZ/STIZ.entitlements"), /applinks:stiz-dasan\.kr/);
});
