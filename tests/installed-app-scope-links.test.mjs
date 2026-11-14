import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// 원장 지시(2026-08-09): 학부모·선생님·기사님 앱은 제 목적에 맞는 페이지 안에서만 움직인다.
// 설치된 앱이 manifest scope 를 벗어나면 주소표시줄이 뜨면서 브라우저로 새어 나가고,
// 돌아올 길이 없다. 브라우저로 들어온 사람에게는 같은 링크가 필요하므로 지우지 않고
// "설치된 앱에서만" 막는다.

const mypageLayout = await readFile("src/app/mypage/layout.tsx", "utf8");
const mypageClient = await readFile("src/app/mypage/MyPageClient.tsx", "utf8");
const newsPage = await readFile("src/app/mypage/reports/page.tsx", "utf8");
const bottomNav = await readFile("src/app/mypage/MyPageBottomNav.tsx", "utf8");
const staffLayout = await readFile("src/app/staff/layout.tsx", "utf8");
const quickPost = await readFile("src/app/staff/quick-post/QuickPostClient.tsx", "utf8");
const driverClient = await readFile("src/components/shuttle/UnifiedDriverClient.tsx", "utf8");
const hideComponent = await readFile("src/components/pwa/HideInInstalledApp.tsx", "utf8");
const safeLink = await readFile("src/components/pwa/AppSafeLink.tsx", "utf8");

test("학부모 앱의 로고는 공개 홈페이지가 아니라 앱 홈으로 간다", () => {
  // 로고를 무심코 누르는 일이 잦다. 여기서 새면 학부모가 앱으로 못 돌아온다.
  // 로고 2개(모바일·데스크탑). 데스크탑 «마이페이지» 글자 링크는 2026-11-09 PC 탭 메뉴(홈·일정·청구·소식)로 바뀌었다.
  assert.equal((mypageLayout.match(/<Link href="\/mypage"/g) || []).length, 2);
  assert.match(mypageLayout, /<MyPageBottomNav variant="top" \/>/);
  assert.match(bottomNav, /\{ href: "\/mypage", label: "홈"/);
  // 로고가 공개 홈페이지로 되돌아가면 안 된다.
  assert.doesNotMatch(mypageLayout, /<Link href="\/"[^>]*>\s*<Image/);
  // 남아 있는 "/" 링크는 홈으로 하나뿐이고, 그것도 설치 앱에서는 감춘다.
  assert.match(mypageLayout, /<HideInInstalledApp>[\s\S]{0,300}href="\/"[\s\S]{0,120}<\/HideInInstalledApp>/);
});

// 공지·사진은 2026-11-09 홈에서 «소식» 탭(/mypage/reports)으로 옮겼다 — 같은 약속을 그 화면에서 지킨다.
test("학부모 앱의 공개 홈페이지 길잡이는 설치 앱에서 감춘다", () => {
  // 2026-11-14 c10: 공지 «전체보기»(공개 /notices)는 앱 안 «지난 공지»(/mypage/news)로 바뀌어 감출 것이 없다 — 사진 «전체보기»만 남는다
  assert.doesNotMatch(newsPage, /href="\/notices"/);
  assert.match(newsPage, /<Link href="\/mypage\/news" className="academy-button-text">지난 공지<\/Link>/);
  for (const href of ["/gallery"]) {
    assert.match(
      newsPage,
      new RegExp(`<HideInInstalledApp>[\\s\\S]{0,200}href="${href}"[\\s\\S]{0,200}</HideInInstalledApp>`),
      `${href} 전체보기 링크`,
    );
  }
  // 공지 상세는 앱 범위 안(/mypage/news/[id])으로 연다 — 공개 /notices/[id] 로 보내면 주소창이 뜬다
  assert.match(newsPage, /href=\{`\/mypage\/news\/\$\{n\.id\}`\}/);
  assert.doesNotMatch(newsPage + mypageClient, /href=\{`\/notices\/\$\{n\.id\}`\}/);
});

test("사진 타일은 감추지 않고 앱 안에서 크게 본다(공개 갤러리로 보내지 않는다)", () => {
  // 2026-11-14 c4: 예전엔 이동만 막아(AppSafeLink) 설치 앱에서 타일이 눌리지 않았다 → 같은 화면 안 크게 보기(FeedPhotoGallery)
  assert.match(newsPage, /<FeedPhotoGallery photos=\{photos\} \/>/);
  assert.doesNotMatch(newsPage, /<Link key=\{g\.id\} href="\/gallery"/);
  assert.doesNotMatch(newsPage, /<AppSafeLink/);
});

test("선생님 앱의 홈 버튼은 /staff 로 간다", () => {
  assert.match(quickPost, /href="\/staff"[\s\S]{0,400}홈\s*\n?\s*<\/Link>/);
  // 공개 홈페이지 갤러리는 설치 앱에서 감춘다.
  assert.match(quickPost, /<HideInInstalledApp>[\s\S]{0,120}href="\/gallery"[\s\S]{0,600}<\/HideInInstalledApp>/);
});

test("관리자 화면으로 나가는 길은 그대로 둔다", () => {
  // 원장이 승인한 의도적 이탈이다. 브라우저로 나가 큰 화면에서 보는 게 맞다.
  assert.match(staffLayout, /scopeHref="\/staff"/);
  assert.match(quickPost, /href="\/admin\/gallery"/);
});

test("기사님 앱은 웹 화면을 벗어나는 링크가 없다", () => {
  // tmap:// 과 tel: 은 다른 앱으로 넘겨주는 것이라 이 화면을 대체하지 않는다.
  const webLinks = [...driverClient.matchAll(/href=\{?["'`]?(\/[^"'`}\s]*)/g)].map((m) => m[1]);
  assert.deepEqual(webLinks, [], `기사님 화면에 내부 이동 링크가 생겼습니다: ${webLinks.join(", ")}`);
});

test("설치 여부 판별은 한 곳에서만 한다", () => {
  // 같은 판별을 여러 벌 두면 한 곳만 고쳐져 조용히 어긋난다.
  for (const source of [hideComponent, safeLink]) {
    assert.match(source, /useInstalledApp/);
    assert.doesNotMatch(source, /display-mode: standalone/);
  }
});
