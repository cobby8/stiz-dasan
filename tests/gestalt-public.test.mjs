// 게슈탈트 디자인 점검(공개 홈페이지) 약속을 소스 수준에서 못박는다.
// 화면을 띄우지 않고 파일 글자를 읽어 확인하는 가벼운 테스트다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
