// 소식 사진 크게 보기(c4) · 지난 공지 전체 보기 · 연간 일정 한눈에 보기(c10) — 2026-11-14 원장 결정표. 실제로 실행·렌더해서 확인한다.
//  ① 쪽 나눔 경계: 0건·딱 한 쪽·한 건 넘침·범위 밖 쪽 번호
//  ② 지난 공지 범위: 전체 공지 + 우리 아이 반 공지(쉼표 글·JSON 배열 둘 다) · 화면 렌더(첫 쪽·끝 쪽)
//  ③ 연간 일정: «일정» 탭 달력과 같은 규칙 · 해 넘김 · 주소의 해
//  ④ 사진: 앱 안에서 크게 보기(링크 아님) · 저장 길 없음
//  ⑤ 길: 앱 밖(공개 화면)으로 나가는 링크가 없다
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const read = (path) => readFileSync(path, "utf8");

// TS/TSX 파일을 CommonJS 로 올린다. mocks 에 없는 «@/…»·상대 경로는 진짜 파일을 같은 방식으로 따라간다.
function load(path, mocks = {}) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(read(absolute), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
    fileName: absolute,
  }).outputText;
  const mod = new Module(absolute);
  mod.filename = absolute;
  mod.paths = Module._nodeModulePaths(resolve("."));
  mod.require = (name) => {
    if (name in mocks) return mocks[name];
    if (name.startsWith("@/") || name.startsWith(".")) {
      const base = name.startsWith("@/") ? `src/${name.slice(2)}` : resolve(absolute, "..", name);
      const file = [".ts", ".tsx", ""].map((ext) => base + ext).find((p) => existsSync(p) && statSync(p).isFile());
      if (file) return load(file, mocks);
    }
    return require(name);
  };
  mod._compile(compiled, absolute);
  return mod.exports;
}

const Link = ({ href, children, ...rest }) => React.createElement("a", { href, ...rest }, children);
const schedule = load("src/lib/mypage/parentSchedule.ts");

// ── ① 쪽 나눔 ────────────────────────────────────────────────────────────────

test("① 쪽 나눔 경계: 0건 · 딱 20건 · 21건 · 범위 밖 쪽 번호", () => {
  const list = (n) => Array.from({ length: n }, (_, i) => i + 1);
  assert.deepEqual(schedule.paginateList([], undefined, 20), { items: [], page: 1, totalPages: 1, total: 0 });
  const exact = schedule.paginateList(list(20), "1", 20);
  assert.deepEqual([exact.items.length, exact.page, exact.totalPages], [20, 1, 1], "딱 한 쪽이면 다음 쪽이 없다");
  const over = schedule.paginateList(list(21), "2", 20);
  assert.deepEqual([over.items, over.page, over.totalPages, over.total], [[21], 2, 2, 21], "한 건이 넘치면 둘째 쪽에 그 한 건");
  assert.deepEqual(schedule.paginateList(list(21), "1", 20).items.at(-1), 20);
  // 범위 밖·이상한 값은 가장 가까운 쪽으로
  assert.equal(schedule.paginateList(list(45), "99", 20).page, 3);
  assert.deepEqual(schedule.paginateList(list(45), "99", 20).items, [41, 42, 43, 44, 45]);
  for (const bad of ["0", "-1", "abc", "1.5", "", null, undefined, "2; DROP"]) assert.equal(schedule.paginateList(list(45), bad, 20).page, 1, String(bad));
});

// ── ② 지난 공지 ──────────────────────────────────────────────────────────────

test("② 볼 수 있는 공지: 전체 + 우리 아이 반(쉼표 글·JSON 배열) · 남의 반·다른 대상은 빠진다", async () => {
  const mine = new Set(["class-a"]);
  const v = schedule.noticeVisibleToClasses;
  assert.equal(v({ targetType: "ALL", targetClassIds: [] }, mine), true);
  assert.equal(v({ targetType: "CLASS", targetClassIds: ["class-b", "class-a"] }, mine), true);
  assert.equal(v({ targetType: "CLASS", targetClassIds: ["class-b"] }, mine), false);
  assert.equal(v({ targetType: "STAFF", targetClassIds: ["class-a"] }, mine), false);

  const calls = [];
  const rows = [
    { id: "n1", title: "전체 공지", targetType: "ALL", targetClassIds: null, isPinned: true, createdAt: new Date("2026-11-01T00:00:00Z") },
    { id: "n2", title: "우리 반(쉼표)", targetType: "CLASS", targetClassIds: "class-b,class-a", isPinned: false, createdAt: "2026-05-01T00:00:00Z" },
    { id: "n3", title: "우리 반(JSON)", targetType: "CLASS", targetClassIds: '["class-a"]', isPinned: null, createdAt: "2025-01-01T00:00:00Z" },
    { id: "n4", title: "남의 반", targetType: "CLASS", targetClassIds: '["class-z"]', isPinned: false, createdAt: "2026-10-01T00:00:00Z" },
  ];
  const { listParentNoticeLines } = load("src/lib/mypage/parentNotices.ts", {
    "@/lib/prisma": { prisma: { $queryRawUnsafe: async (sql, ...args) => { calls.push({ sql, args }); return rows; } } },
  });
  const lines = await listParentNoticeLines(["class-a"]);
  assert.deepEqual(lines.map((l) => l.id), ["n1", "n2", "n3"], "1년 넘은 공지도 남는다(3개월 제한 없음)");
  assert.deepEqual([lines[0].isPinned, lines[2].isPinned, lines[0].createdAt], [true, false, "2026-11-01T00:00:00.000Z"]);
  assert.match(calls[0].sql, /WHERE "targetType" IN \('ALL', 'CLASS'\)/, "직원 공지 등 다른 대상은 SQL 에서 뺀다");
  assert.doesNotMatch(calls[0].sql, /content|attachmentsJSON/, "목록은 본문·첨부를 읽지 않는다");
  assert.match(calls[0].sql, /LIMIT \$1/);
});

async function renderNews(lineCount, pageParam) {
  const lines = Array.from({ length: lineCount }, (_, i) => ({ id: `n${i + 1}`, title: `공지 ${i + 1}`, isPinned: i === 0, createdAt: "2026-11-01T03:00:00.000Z" }));
  const seen = {};
  const Page = load("src/app/mypage/news/page.tsx", {
    "next/link": { default: Link, __esModule: true },
    "next/navigation": { redirect: (to) => { throw new Error(`REDIRECT ${to}`); } },
    "@/lib/auth-guard": { requireVerifiedParent: async () => ({ appUserId: "parent-a" }) },
    "@/lib/queries": { getMyPageData: async (id) => { seen.parent = id; return { children: [{ enrollments: [{ classId: "class-a" }, { classId: null }] }] }; } },
    "@/lib/mypage/parentNotices": { listParentNoticeLines: async (classIds) => { seen.classIds = classIds; return lines; } },
  }).default;
  const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve(pageParam === undefined ? {} : { page: pageParam }) }));
  return { html, seen };
}

test("② 지난 공지 화면: 한 줄 행 · 앱 안 상세 링크 · 첫 쪽엔 «이전» 없음 · 끝 쪽엔 «다음» 없음", async () => {
  const first = await renderNews(45);
  assert.deepEqual([first.seen.parent, first.seen.classIds], ["parent-a", ["class-a"]], "로그인한 학부모의 아이 반으로만");
  assert.equal((first.html.match(/href="\/mypage\/news\/n\d+"/g) ?? []).length, 20);
  assert.match(first.html, /href="\/mypage\/news\/n1"[^>]*>.*?중요<\/span>공지 1</s);
  assert.match(first.html, />1 \/ 3</);
  assert.match(first.html, /href="\/mypage\/news\?page=2"[^>]*>다음 ›</);
  assert.doesNotMatch(first.html, /‹ 이전/);
  assert.match(first.html, /45건/);

  const last = await renderNews(45, "3");
  assert.equal((last.html.match(/href="\/mypage\/news\/n\d+"/g) ?? []).length, 5);
  assert.match(last.html, /href="\/mypage\/news\?page=2"[^>]*>‹ 이전</);
  assert.doesNotMatch(last.html, /다음 ›/);

  // 한 쪽이면 쪽 이동 줄이 없다 · 0건이면 한 줄 안내
  assert.doesNotMatch((await renderNews(20)).html, /쪽 이동/);
  const empty = await renderNews(0);
  assert.match(empty.html, /공지가 아직 없어요/);
  assert.doesNotMatch(empty.html, /쪽 이동/);
  // 돌아가는 길은 앱 안
  assert.match(first.html, /href="\/mypage\/reports#news-notices"/);
  assert.doesNotMatch(first.html, /href="\/notices/);
});

// ── ③ 연간 일정 ──────────────────────────────────────────────────────────────

test("③ 연간 일정: 달마다 달력과 같은 규칙 · 주차 표시는 빼고 · 해를 넘는 일정은 걸친 달마다", () => {
  const events = [
    { title: "12월 1주차 시작", date: "2026-11-30T00:00:00.000Z" },
    { title: "학원 휴무", date: "2026-10-05T00:00:00.000Z" },
    { title: "겨울방학특강", date: "2026-12-28T00:00:00.000Z", endDate: "2027-01-08T00:00:00.000Z" },
    { title: "대회", date: "2026-10-05T00:00:00.000Z" },
    { title: "대회", date: "2026-10-05T00:00:00.000Z" }, // 같은 날 같은 제목은 한 번
  ];
  const y2026 = schedule.buildParentYear(events, 2026);
  assert.equal(y2026.length, 12);
  assert.deepEqual(y2026.map((m) => m.month).slice(0, 2).concat(y2026.at(-1).month), ["2026-01", "2026-02", "2026-12"]);
  const oct = y2026[9].events;
  assert.deepEqual(oct.map((e) => [e.title, e.closed]), [["대회", false], ["학원 휴무", true]]);
  assert.deepEqual(y2026[10].events, [], "주차 표시는 학부모 화면에 안 보인다");
  assert.deepEqual(y2026[11].events.map((e) => [e.title, e.startYmd, e.endYmd]), [["겨울방학특강", "2026-12-28", "2027-01-08"]]);
  assert.deepEqual(schedule.buildParentYear(events, 2027)[0].events.map((e) => e.title), ["겨울방학특강"], "1월에도 보인다");
  assert.equal(schedule.buildParentYear(events, 2027).slice(1).every((m) => m.events.length === 0), true);
  // 달력 한 달 화면과 같은 줄
  assert.deepEqual(oct, schedule.buildParentMonth({ month: "2026-10", todayYmd: "2026-10-01", events, classDates: [], attendance: [] }).events);
});

test("③ 주소의 해: 4자리 숫자만 · 그 밖에는 오늘(KST)의 해", () => {
  assert.equal(schedule.parseYearParam("2027", "2026-11-14"), 2027);
  for (const bad of [undefined, "", "27", "20270", "abcd", "1999", "2101", "2027-01"]) assert.equal(schedule.parseYearParam(bad, "2026-11-14"), 2026, String(bad));
  // 연말 자정 경계는 넘겨받은 KST 날짜를 그대로 믿는다(서버 시계로 다시 계산하지 않는다)
  assert.equal(schedule.parseYearParam(undefined, "2027-01-01"), 2027);
  assert.doesNotMatch(read("src/app/mypage/annual/page.tsx"), /new Date\(\)\.get|toISOString\(\)\.slice/);
});

async function renderAnnual(events, yearParam, today = "2026-11-14") {
  const Page = load("src/app/mypage/annual/page.tsx", {
    "next/link": { default: Link, __esModule: true },
    "next/navigation": { redirect: (to) => { throw new Error(`REDIRECT ${to}`); } },
    "@/lib/auth-guard": { requireVerifiedParent: async () => ({ appUserId: "parent-a" }) },
    "@/lib/datetime/kst": { ...load("src/lib/datetime/kst.ts"), todayKst: () => today },
    "@/lib/enrollment/monthlyClassDates": { loadAnnualPlanEvents: async () => { if (events === null) throw new Error("캘린더 실패"); return events; } },
  }).default;
  return renderToStaticMarkup(await Page({ searchParams: Promise.resolve(yearParam ? { year: yearParam } : {}) }));
}

test("③ 연간 일정 화면: 일정 있는 달만 · 이번 달 표시 · 해 이동 · 조회 실패에도 열린다", async () => {
  const html = await renderAnnual([
    { title: "학원 휴무", date: "2026-10-05T00:00:00.000Z" },
    { title: "종강", date: "2026-11-28T00:00:00.000Z" },
  ]);
  assert.match(html, /2026년/);
  assert.equal((html.match(/<section /g) ?? []).length, 2, "일정이 없는 달은 그리지 않는다");
  assert.match(html, /aria-label="10월 일정"[\s\S]*학원 휴무[\s\S]*휴무<\/span>/);
  assert.match(html, /11월<span[^>]*>이번 달<\/span>/);
  assert.match(html, /href="\/mypage\/history\?month=2026-11"/, "달 제목 = 그 달 달력");
  assert.match(html, /href="\/mypage\/annual\?year=2025"[^>]*aria-label="이전 해"/);
  assert.match(html, /href="\/mypage\/annual\?year=2027"[^>]*aria-label="다음 해"/);
  assert.match(await renderAnnual([], "2027"), /2027년에 등록된 일정이 아직 없어요/);
  assert.match(await renderAnnual(null), /2026년에 등록된 일정이 아직 없어요/, "캘린더를 못 읽어도 화면은 열린다");
});

// ── ④ 사진 ───────────────────────────────────────────────────────────────────

test("④ 수업 사진: 타일이 버튼(앱 안 크게 보기)이고 링크·저장 길이 없다", () => {
  const Gallery = load("src/components/parent/FeedPhotoGallery.tsx").default;
  const html = renderToStaticMarkup(React.createElement(Gallery, { photos: [{ src: "https://img.example/a.jpg" }, { src: "https://img.example/b.jpg" }] }));
  assert.equal((html.match(/<button type="button" aria-label="수업 사진 \d 크게 보기"/g) ?? []).length, 2);
  assert.doesNotMatch(html, /<a /, "링크가 아니라 설치 앱에서도 눌린다");
  assert.doesNotMatch(read("src/components/parent/FeedPhotoGallery.tsx"), /download|저장/, "저장 버튼은 두지 않는다(원장 결정)");
  assert.equal(renderToStaticMarkup(React.createElement(Gallery, { photos: [] })), "", "사진이 없으면 아무것도 그리지 않는다");
});

test("④ 소식 화면: 사진은 갤러리 부품으로 · 묶음의 사진을 모두 · 30장까지 · 영상은 저장 막음", () => {
  const page = read("src/app/mypage/reports/page.tsx");
  assert.match(page, /<FeedPhotoGallery photos=\{photos\} \/>/);
  assert.doesNotMatch(page, /AppSafeLink/, "눌러도 아무 일 없는 타일은 없앴다");
  assert.match(page, /const PHOTO_LIMIT = 30;/);
  assert.match(page, /\.slice\(0, PHOTO_LIMIT\)/);
  assert.match(page, /<video src=\{v\.url\}[^>]*controlsList="nodownload"/);
  assert.doesNotMatch(page, /download=|다운로드/);
  // 공개 갤러리 «전체보기»는 브라우저에서만(설치 앱에서는 숨김)
  assert.match(page, /<HideInInstalledApp>\s*<Link href="\/gallery" className="academy-button-text">전체보기<\/Link>\s*<\/HideInInstalledApp>/);
});

// ── ⑤ 길 ─────────────────────────────────────────────────────────────────────

test("⑤ 지난 공지·연간 일정으로 가는 길은 늘 있고, 앱 안 주소다", () => {
  const page = read("src/app/mypage/reports/page.tsx");
  assert.match(page, /<Link href="\/mypage\/news" className="academy-button-text">지난 공지<\/Link>/);
  assert.match(page, /\{notices\.length === 0 && \(\s*<Link href="\/mypage\/news"/, "최근 공지가 없어도 길은 남는다");
  assert.doesNotMatch(page, /href="\/notices"/, "공개 공지 목록으로 보내지 않는다");
  const hub = read("src/app/mypage/history/ScheduleHub.tsx");
  assert.match(hub, /<Link href=\{`\/mypage\/annual\?year=\$\{view\.month\.slice\(0, 4\)\}`\}/);
  assert.doesNotMatch(hub.slice(hub.indexOf("/mypage/annual") - 400, hub.indexOf("/mypage/annual")), /view\.events\.length > 0 && \(\s*$/, "조건 칸 안이 아니다");
  const annual = read("src/app/mypage/annual/page.tsx");
  assert.match(annual, /loadAnnualPlanEvents\(\)\.catch\(\(\) => \[\]\)/, "공개 연간일정·청구와 같은 원본");
  for (const source of [annual, read("src/app/mypage/news/page.tsx")]) {
    const hrefs = [...source.matchAll(/href=(?:"|\{`)([^"`]+)/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 0);
    for (const href of hrefs) assert.ok(href.startsWith("/mypage"), `앱 밖 주소: ${href}`);
    assert.doesNotMatch(source, /#[0-9a-fA-F]{6}\b|font-(extrabold|black)|material-symbols|UiIcon/);
  }
  // 아래 탭: 지난 공지 = 소식, 연간 일정 = 수업
  const nav = load("src/app/mypage/MyPageBottomNav.tsx", { "next/link": { default: Link }, "next/navigation": { usePathname: () => "/mypage" } });
  const tabOf = (path) => nav.PARENT_TABS.find((tab) => nav.isParentTabActive(tab, path))?.label;
  assert.deepEqual([tabOf("/mypage/news"), tabOf("/mypage/news/abc"), tabOf("/mypage/annual"), tabOf("/mypage/requests/r1")], ["소식", "소식", "수업", "홈"]);
});
