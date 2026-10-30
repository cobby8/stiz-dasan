// 게슈탈트 디자인 점검(공개 홈페이지) 약속을 소스 수준에서 못박는다.
// 화면을 띄우지 않고 파일 글자를 읽어 확인하는 가벼운 테스트다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const sportCss = read("src/components/public-sport.css");
const homeCss = read("src/components/landing/public-home.css");

// 폴더 안의 .tsx 파일 목록(하위 폴더 포함)
function walk(dir) {
  const root = new URL(`../${dir}`, import.meta.url);
  const out = [];
  for (const name of readdirSync(root)) {
    const rel = join(dir, name).replaceAll("\\", "/");
    if (statSync(new URL(`../${rel}`, import.meta.url)).isDirectory()) out.push(...walk(rel));
    else if (/\.tsx$/.test(name)) out.push(rel);
  }
  return out;
}

test("C-P1 버튼 3등급(주인공·보조·글자)이 44px 이상으로 정의돼 있다", () => {
  for (const name of ["public-btn-primary", "public-btn-secondary", "public-btn-text"]) {
    assert.ok(sportCss.includes(`.${name}`), name);
  }
  assert.match(sportCss, /:is\(\.public-btn-primary, \.public-btn-secondary, \.public-btn-text\) \{[^}]*min-height: 44px/);
  assert.match(sportCss, /\.public-btn-primary \{[^}]*background: var\(--color-public-accent\)/);
  assert.match(sportCss, /\.public-btn-secondary \{[^}]*background: transparent/);
  assert.match(sportCss, /\.public-btn-secondary--on-dark \{[^}]*border-color: var\(--color-public-white\)/);
});

test("P-02 홈 히어로·하단 CTA 의 두 번째 버튼은 보조(투명+흰 테두리)다", () => {
  assert.match(homeCss, /\.public-home-hero__actions a\+a\{background:transparent;color:var\(--color-public-white\);border:1px solid var\(--color-public-white\)\}/);
  assert.match(homeCss, /\.public-cta__actions>\*\+\*\{background:transparent;color:var\(--color-public-white\);border:1px solid var\(--color-public-white\)\}/);
});

test("P-05 /apply 두 신청 버튼은 같은 주인공 모양, 카드 머리는 같은 중립색", () => {
  const src = read("src/app/apply/ApplyPageClient.tsx");
  assert.equal(src.match(/className="public-btn-primary/g)?.length, 2);
  assert.equal(src.match(/bg-\[var\(--color-public-tint\)\] px-6 py-4/g)?.length, 2);
  assert.doesNotMatch(src, /bg-brand-navy-900 px-6 py-5/);
  // 기능 보존: 두 신청 경로와 투어 표적
  assert.ok(src.includes('href="/apply/trial"') && src.includes('href="/apply/enroll"'));
  assert.ok(src.includes('data-tour-target="trial-apply-btn"'));
});

test("C-P1 오류·404·시뮬레이터 버튼이 등급 클래스를 쓴다", () => {
  const error = read("src/app/error.tsx");
  assert.match(error, /onClick=\{\(\) => reset\(\)\}\s*className="public-btn-primary/);
  assert.match(error, /href="\/"\s*className="public-btn-secondary/);
  assert.match(read("src/app/not-found.tsx"), /href="\/"\s*className="public-btn-primary/);
  const sim = read("src/app/simulator/SimulatorClient.tsx");
  assert.match(sim, /href=\{`tel:\$\{phone\.replace\(\/-\/g, ""\)\}`\}\s*className="public-btn-primary/);
  assert.match(sim, /href="\/apply\/enroll"\s*className="public-btn-secondary/);
});

// 공개 화면 범위(관리자·마이페이지·직원·/programs 제외)
const PUBLIC_ROOTS = ["src/app/about", "src/app/schedule", "src/app/annual", "src/app/gallery", "src/app/notices",
  "src/app/faq", "src/app/apply", "src/app/seasonal", "src/app/shop", "src/app/simulator", "src/app/login",
  "src/components/landing", "src/components/chat", "src/components/guide-tour", "src/components/seasonal"];
const PUBLIC_FILES = [...PUBLIC_ROOTS.flatMap(walk), "src/components/PublicHeader.tsx", "src/components/PublicAccountControls.tsx",
  "src/app/LandingPageClient.tsx", "src/app/error.tsx", "src/app/not-found.tsx"];

test("C-P2·P-04 hover 색 바로 뒤의 dark: 강조색은 dark:hover: 여야 한다(다크 모드에서 늘 강조되던 오타)", () => {
  // 버튼의 «정적» 다크 바탕(dark:bg-brand-neon-lime)은 의도된 것이라 제외하고, 글자색·옅은 hover 바탕만 본다.
  const typos = [/\bhover:text-[^\s"'`]+ dark:text-brand-neon-lime/, /\bhover:bg-[^\s"'`]+ dark:bg-brand-neon-lime\/10/,
    /hover:bg-gray-100 dark:bg-gray-800 dark:hover:bg-gray-800/];
  const bad = PUBLIC_FILES.filter((file) => typos.some((re) => re.test(read(file))));
  assert.deepEqual(bad, []);
  const header = read("src/components/PublicHeader.tsx");
  assert.ok((header.match(/dark:hover:text-brand-neon-lime/g)?.length ?? 0) >= 8);
  assert.ok((header.match(/dark:hover:bg-brand-neon-lime\/10/g)?.length ?? 0) >= 8);
});

test("P-08 다크 모드의 «선택됨»은 공개 주황 바탕 + 어두운 글자(토큰)", () => {
  const sel = "dark:bg-[var(--color-public-orange)] dark:text-[var(--color-public-dark)]";
  assert.equal(read("src/app/simulator/SimulatorClient.tsx").split(sel).length - 1, 2);
  assert.equal(read("src/app/annual/AnnualEventsClient.tsx").split(sel).length - 1, 2);
  assert.ok(read("src/app/schedule/ScheduleClient.tsx").includes(sel));
});

test("C-P3·P-03 플로팅 버튼은 하단 고정 바 높이만큼 올라가고 모달이 열리면 숨는다", () => {
  assert.match(sportCss, /\.public-floating-btn \{ bottom: calc\(var\(--public-floating-offset, 24px\) \+ var\(--public-bottom-bar, 0px\)\); \}/);
  assert.match(sportCss, /body\[data-public-overlay\] \.stiz-public-sport \.public-floating-btn \{ display: none; \}/);
  assert.ok(read("src/components/chat/ChatBotButton.tsx").includes("public-floating-btn public-floating-btn--chat"));
  for (const file of ["src/components/guide-tour/GuideTourLazyTrigger.tsx", "src/components/guide-tour/GuideTourTrigger.tsx"]) {
    const src = read(file);
    assert.ok(src.includes("public-floating-btn public-floating-btn--guide"), file);
    assert.doesNotMatch(src, /style=\{\{ bottom: 88 \}\}/, file);
  }
  for (const file of ["src/components/seasonal/SeasonalDetailClient.tsx", "src/components/seasonal/SeasonalApplyClient.tsx"]) {
    assert.match(read(file), /<PublicBottomBar className="fixed inset-x-0 bottom-0/, file);
  }
  for (const file of ["src/app/annual/EventDetailPanel.tsx", "src/components/PublicHeader.tsx", "src/components/chat/ChatBotButton.tsx", "src/components/seasonal/SeasonalApplyClient.tsx"]) {
    assert.match(read(file), /usePublicOverlayOpen\(/, file);
  }
  const helper = read("src/components/public-floating.tsx");
  assert.ok(helper.includes('root.style.setProperty("--public-bottom-bar"') && helper.includes("body.dataset.publicOverlay"));
});

test("P-01 홈 히어로는 컴팩트(영문 kicker 없음·제목 clamp·소개 1줄·PC 한 줄 배치)", () => {
  const landing = read("src/app/LandingPageClient.tsx");
  assert.doesNotMatch(landing, /public-home-kicker|STIZ BASKETBALL CLUB/);
  assert.match(landing, /<p className="public-home-lead">[^<]+<\/p>/); // <br> 없는 한 줄
  assert.doesNotMatch(homeCss, /min-height:2[57]rem/);
  assert.match(homeCss, /\.public-home-hero__content\{[^}]*min-height:8\.5rem;padding-block:1\.25rem;display:flex;flex-direction:row/);
  assert.match(homeCss, /\.public-home-hero h1\{font-size:clamp\(1\.6rem,3vw,2\.2rem\)/);
  // 기능 보존: 두 버튼 경로와 사진 위 글자(스크림 오버레이)
  assert.ok(landing.includes('<Link href="/apply">') && landing.includes('<Link href="/programs">'));
  assert.match(homeCss, /\.public-home-hero::after\{[^}]*linear-gradient/);
});

test("P-06 홈 섹션 제목은 왼쪽 정렬 22px 하나, 영문 라벨 없음 — 다른 페이지는 기존 모양", () => {
  const landing = read("src/app/LandingPageClient.tsx");
  assert.doesNotMatch(landing, /label="(VIDEO|GALLERY)"/);
  assert.equal(landing.match(/<SectionLayout compactHeading /g)?.length, 2);
  assert.match(read("src/components/landing/TestimonialCarousel.tsx"), /compactHeading/);
  assert.doesNotMatch(read("src/components/landing/TestimonialCarousel.tsx"), /label="REVIEWS"/);
  const layout = read("src/components/ui/SectionLayout.tsx");
  assert.match(layout, /compactHeading && title && \(\s*<h2 className="mb-4 text-left text-\[22px\]/);
  assert.match(layout, /!compactHeading && \(label \|\| title \|\| description\)/);
  assert.match(layout, /text-center mb-12 md:mb-16/); // 기존(예: /programs) 제목 모양 유지
  assert.match(homeCss, /\.public-process h2\{font-size:1\.375rem/);
  assert.match(homeCss, /\.public-cta h2\{font-size:1\.375rem/);
});

test("P-07 /schedule 필터는 버튼 하나 + 모달(모바일 하단 시트), 칩 줄·중복 필터 카드 없음", () => {
  const src = read("src/app/schedule/ScheduleClient.tsx");
  assert.doesNotMatch(src, /public-filter-row/);
  assert.doesNotMatch(src, /프로그램 필터<\/p>/); // 옛 중복 «프로그램 필터» 카드
  assert.match(src, /aria-haspopup="dialog"/);
  assert.match(src, /selectedProgram \? "필터 1" : "필터"/);
  assert.match(src, /role="dialog" aria-modal="true" aria-label="프로그램 필터"/);
  assert.match(src, /items-end justify-center sm:items-center/); // 모바일 하단 시트
  assert.ok(src.includes(">초기화</button>") && src.includes(">적용</a>"));
  // 기능 보존: 같은 주소로 필터, 카드/표 전환, 투어 표적
  assert.ok(src.includes("`/schedule?program=${pendingProgramId}`"));
  assert.ok(src.includes('searchParams.get("program")'));
  assert.match(src, /setViewMode\("card"\)/);
  assert.match(src, /setViewMode\("table"\)/);
  assert.equal(src.match(/flex min-h-11 items-center gap-1 px-4 text-xs/g)?.length, 2);
  assert.ok(src.includes('data-tour-target="schedule-grid"'));
});

test("P-12·P-13 /schedule 빈 상태는 한 줄 + 전화 링크, 마감 배지는 12px", () => {
  const src = read("src/app/schedule/ScheduleClient.tsx");
  assert.match(src, /className="py-6 text-center text-sm/);
  assert.match(src, /href=\{`tel:\$\{phone\.replace\(\/-\/g, ""\)\}`\}/);
  assert.doesNotMatch(src, /py-20 text-gray-400 bg-white/);
  assert.doesNotMatch(src, /text-\[10px\][^"]*">마감/);
  assert.match(src, /text-xs leading-none bg-red-50 text-red-500 font-black px-1\.5 py-0\.5 rounded uppercase">마감/);
});

test("P-09·P-12 /notices 목록은 한 줄 행(약 52px), 미리보기·썸네일 없음, 빈 상태 한 줄 + 전화", () => {
  const src = read("src/app/notices/page.tsx");
  assert.match(src, /flex min-h-\[52px\] items-center gap-2 px-4/);
  assert.doesNotMatch(src, /stripHtmlForPreview|line-clamp-2|firstImage|w-16 h-16/);
  assert.match(src, /from "@\/lib\/datetime\/kst"/);
  assert.match(src, /dateTime=\{toKstYmd\(n\.createdAt\) \|\| undefined\}/);
  assert.match(src, /className="py-6 text-center text-sm/);
  assert.match(src, /href=\{`tel:\$\{phone\.replace\(\/-\/g, ""\)\}`\}/);
  // 기능 보존: 상세 링크, 전체 대상 공지만, 중요(고정) 표시
  assert.ok(src.includes("href={`/notices/${n.id}`}"));
  assert.ok(src.includes('n.targetType === "ALL"'));
  assert.ok(src.includes("n.isPinned &&"));
});

test("P-10 모바일 메뉴 로그아웃은 맨 아래 회색 글자 링크, 위 버튼과 16px 이상 떨어짐", () => {
  const controls = read("src/components/PublicAccountControls.tsx");
  const mobile = controls.slice(controls.indexOf("export function MobileAccountControls"));
  assert.match(mobile, /<form action=\{logout\} className="order-last mt-4 [^"]*" data-account-logout="mobile">/);
  assert.match(mobile, /className="inline-flex min-h-11 items-center px-3 text-sm text-gray-500/);
  assert.doesNotMatch(mobile, /MOBILE_SECONDARY_ACTION_CLASS\} w-full`\}>\s*로그아웃/);
  // 부모(모바일 메뉴 하단)는 flex 세로여야 order-last 가 먹는다
  assert.match(read("src/components/PublicHeader.tsx"), /<div className="shrink-0 flex flex-col p-4 border-t/);
  // 기능 보존: 데스크톱 로그아웃·사진 올리기·계정 전환
  assert.match(controls, /className=\{DESKTOP_LOGOUT_CLASS\}/);
  assert.ok(mobile.includes('href="/staff/quick-post"') && mobile.includes("<AccountViewSwitcher"));
});

const COMPACT_HERO_FILES = ["src/app/about/page.tsx", "src/app/annual/page.tsx", "src/app/apply/page.tsx", "src/app/apply/enroll/page.tsx",
  "src/app/apply/trial/page.tsx", "src/app/apply/uniform/page.tsx", "src/app/faq/page.tsx", "src/app/gallery/page.tsx",
  "src/app/notices/page.tsx", "src/app/notices/[id]/page.tsx", "src/app/privacy/page.tsx", "src/app/schedule/page.tsx",
  "src/app/seasonal/page.tsx", "src/app/shop/page.tsx", "src/app/simulator/page.tsx", "src/app/terms/page.tsx",
  "src/components/seasonal/SeasonalDetailClient.tsx"];

test("P-11 하위 페이지 배너: 영문 라벨·장식 원 없음, 제목 clamp(22px,3vw,32px)", () => {
  assert.match(sportCss, /\.public-page-hero--compact :is\(h1, h2\) \{\s*font-size: clamp\(22px, 3vw, 32px\)/);
  for (const file of COMPACT_HERO_FILES) {
    const src = read(file);
    const hero = src.slice(src.indexOf("public-page-hero"), src.indexOf("</section>", src.indexOf("public-page-hero")));
    assert.ok(hero.startsWith("public-page-hero public-page-hero--compact "), file);
    assert.doesNotMatch(hero, /uppercase tracking-widest/, file);
    assert.doesNotMatch(hero, /rounded-full translate-x-1\/3/, file);
    assert.doesNotMatch(hero, /SEASONAL PROGRAM/, file);
  }
});

test("토스 심사 중 /programs·결제·푸터는 이번 작업에서 바뀌지 않았다", () => {
  // /programs 배너는 컴팩트 클래스를 달지 않아 기존 모양(영문 라벨·장식 원·큰 제목) 그대로다.
  const programs = read("src/app/programs/page.tsx");
  assert.doesNotMatch(programs, /public-page-hero--compact|compactHeading|public-btn-|public-floating/);
  assert.match(programs, /className="public-page-hero relative overflow-hidden/);
  assert.match(programs, /uppercase tracking-widest/);
  // 공용 규칙 중 /programs 에도 닿는 .public-page-hero 기본 규칙은 그대로 둔다.
  assert.match(sportCss, /\.stiz-public-sport \.public-page-hero :is\(h1, h2\) \{[^}]*font-size: clamp\(26px, 4vw, 42px\)/);
  assert.match(sportCss, /\.stiz-public-sport \.public-page-hero \{[^}]*padding-block: clamp\(24px, 4vw, 44px\)/);
  // SectionLayout 기본(라벨·가운데 큰 제목)도 유지 — /programs 가 쓴다.
  assert.match(read("src/components/ui/SectionLayout.tsx"), /text-3xl md:text-4xl font-extrabold/);
  // 이 작업 커밋들이 금지 구역 파일을 건드리지 않았는지(작업 기준점 68be6db3 이후, 있으면 확인).
  // 카드사 심사가 끝나 /programs 를 다시 고칠 때는 이 git 비교 단언을 지운다.
  let changed = "";
  try {
    changed = execFileSync("git", ["diff", "--name-only", "68be6db3", "HEAD", "--", "src/app/programs", "src/app/payments", "src/components/PublicFooter.tsx", "src/app/programs/order"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch { changed = ""; }
  assert.equal(changed.trim(), "");
});

test("P-13 작은 글자 12px·닫기/글씨 버튼 44px", () => {
  assert.match(read("src/app/annual/AnnualEventsClient.tsx"), /<span className="text-xs">\{isScheduleOpen \? "▲" : "▼"\}<\/span>/);
  assert.match(read("src/components/PublicHeader.tsx"), /"public-mobile-font md:hidden flex h-11 w-11 /);
  assert.match(read("src/app/annual/EventDetailPanel.tsx"), /className="shrink-0 w-11 h-11 flex items-center justify-center rounded-full[^"]*"\s*aria-label="닫기"/);
  assert.match(read("src/components/chat/ChatPanel.tsx"), /className="flex h-11 w-11 items-center justify-center hover:bg-orange-600 rounded-full transition-colors"\s*aria-label="채팅 닫기"/);
});

test("P-14 갤러리 좌우 화살표는 닫기와 같은 반투명 검은 원 44px + 80% 흰색", () => {
  const src = read("src/app/gallery/GalleryLightboxOverlay.tsx");
  assert.equal(src.match(/flex h-11 w-11 items-center justify-center rounded-full bg-black\/70 text-white\/80/g)?.length, 2);
  assert.doesNotMatch(src, /text-white\/40/);
  assert.match(src, /aria-label="이전 사진"/);
  assert.match(src, /aria-label="다음 사진"/);
  assert.match(src, /rounded-full bg-black\/70 text-white hover:bg-white\/10 transition-colors"\s*aria-label="닫기"/); // 닫기 버튼 기준 모양
});
