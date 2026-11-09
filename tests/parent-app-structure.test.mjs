// 학부모 화면 구조 개편(2026-11-09 원장 결정 D1 안 A · D6 · D7 · D8) — 실제로 그려서 확인한다.
//  ① 메뉴 4개(홈·일정·청구·소식), 하위 화면에서도 소속 탭이 켜진다, 방학특강 탭 없음
//  ② 로그아웃은 «⋯» 메뉴 안
//  ③ 홈 = 납부 합계 한 줄(꽉 찬 버튼 1개) + 처리할 일 + 빠른 실행 4개, 접힌 칸 없음
//  ④ 일정 탭 = 결석·보강·셔틀·수강 변경 + 수강 반 + 셔틀 배정, 방학특강 줄은 방학 기간에만
//  ⑤ 앱 안 공지 상세는 우리 아이 반 공지·전체 공지만(남의 반 공지는 404)
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
  const compiled = ts.transpileModule(read(absolute), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : require(name);
  module._compile(compiled, absolute);
  return module.exports;
}
const nullComponent = { __esModule: true, default: () => null };
const link = { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
const kst = load("src/lib/datetime/kst.ts");
const summary = load("src/lib/mypage/summary.ts");

test("① 메뉴 4개 — 하위 화면에서도 소속 탭이 켜지고 방학특강 탭은 없다", () => {
  const nav = load("src/app/mypage/MyPageBottomNav.tsx", { "next/link": link, "next/navigation": { usePathname: () => "/mypage" } });
  assert.deepEqual(nav.PARENT_TABS.map((t) => t.label), ["홈", "일정", "청구", "소식"]);
  assert.deepEqual(nav.PARENT_TABS.map((t) => t.href), ["/mypage", "/mypage/history", "/mypage/payments", "/mypage/reports"]);
  const activeAt = (path) => nav.PARENT_TABS.filter((t) => nav.isParentTabActive(t, path)).map((t) => t.label);
  assert.deepEqual(activeAt("/mypage"), ["홈"]);
  for (const p of ["/mypage/history", "/mypage/regular-absence", "/mypage/makeup", "/mypage/seasonal", "/mypage/shuttle", "/mypage/enrollment-change"]) {
    assert.deepEqual(activeAt(p), ["일정"], p);
  }
  assert.deepEqual(activeAt("/mypage/payments"), ["청구"]);
  assert.deepEqual(activeAt("/mypage/reports/s1"), ["소식"]);
  assert.deepEqual(activeAt("/mypage/news/n1"), ["소식"]);
  assert.deepEqual(activeAt("/mypage/children"), [], "계정 화면은 어느 탭도 아니다");
  assert.deepEqual(activeAt("/mypage/historyx"), [], "앞부분만 같은 주소는 켜지 않는다");

  const bottom = renderToStaticMarkup(React.createElement(nav.default));
  assert.match(bottom, /aria-current="page"[^>]*>[\s\S]*?홈/);
  assert.doesNotMatch(bottom, /방학특강/);
  const top = renderToStaticMarkup(React.createElement(nav.default, { variant: "top" }));
  assert.match(top, /aria-label="학부모 메뉴"/);
  assert.equal((top.match(/min-h-11/g) || []).length, 4, "PC 메뉴도 누르는 높이 44px");
});

test("② 로그아웃은 헤더 «⋯» 메뉴 안(휴대폰·PC 둘 다), 메뉴 버튼은 44×44", () => {
  const layout = read("src/app/mypage/layout.tsx");
  assert.equal((layout.match(/<ParentMoreMenu>\s*<form action=\{logout\}>/g) || []).length, 2);
  assert.doesNotMatch(layout.replace(/<ParentMoreMenu>[\s\S]*?<\/ParentMoreMenu>/g, ""), />\s*로그아웃\s*</, "메뉴 밖 로그아웃 버튼 없음");
  const menu = read("src/app/mypage/ParentMoreMenu.tsx");
  assert.match(menu, /aria-label="더보기 메뉴"/);
  assert.match(menu, /inline-flex size-11/);
  assert.match(menu, /useEffect\(\(\) => \{ setOpen\(false\); \}, \[pathname\]\)/, "화면을 옮기면 닫힌다");
});

function renderHome(props) {
  const Client = load("src/app/mypage/MyPageClient.tsx", {
    "@/components/account/ChildConnectionNotice": nullComponent, "next/link": link,
    "@/app/actions/admin": {}, "@/lib/mypage/summary": summary, "@/lib/datetime/kst": kst,
    "@/components/parent/VirtualAccountNotice": { __esModule: true, default: ({ account }) => React.createElement("p", null, `계좌 ${account.accountNumber}`) },
  }).default;
  return renderToStaticMarkup(React.createElement(Client, props));
}
const childA = (payments, extra = {}) => ({
  id: "a", name: "합성 첫째", birthDate: "2016-01-01", gender: null,
  enrollments: [{ id: "e1", classId: "k1", className: "초등 저학년반", dayOfWeek: "Mon", startTime: "16:00", endTime: "17:00", programName: "정규" }],
  attendance: { total: 0, present: 0, absent: 0, late: 0, records: [] }, payments, ...extra,
});

test("③ 홈: 납부할 청구 합계 한 줄(형제 합산) + 꽉 찬 버튼 1개 + 처리할 일 + 빠른 실행 4개", () => {
  const va = { bankName: "합성은행", accountNumber: "000-111", customerName: null, amount: 50000, dueDate: "2026-11-20", dueLabel: "", expired: false };
  const html = renderHome({
    data: { parent: { id: "p" }, children: [
      childA([{ id: "p1", amount: 180000, status: "PENDING", dueDate: "2026-11-10", paidDate: null, invoiceId: "i1" }, { id: "p9", amount: 99000, status: "PAID", dueDate: "2026-10-10", paidDate: "2026-10-09" }]),
      { ...childA([{ id: "p2", amount: 50000, status: "OVERDUE", dueDate: "2026-11-01", paidDate: null, invoiceId: "i2", virtualAccount: va }]), id: "b", name: "합성 둘째" },
    ] },
    makeupAvailable: 2, seasonalUpcoming: 0, unreadCount: 3,
  });
  assert.match(html, /납부할 청구 <span class="tabular-nums">2<\/span>건/);
  assert.match(html, /합계 230,000원/);
  assert.match(html, /href="\/mypage\/payments" class="academy-button-primary shrink-0">청구 보기/);
  assert.equal((html.match(/academy-button-primary/g) || []).length, 1, "꽉 찬 버튼은 하나(문의 폼은 닫혀 있다)");
  assert.match(html, /계좌 000-111/, "무통장입금 계좌는 홈에서 계속 보인다");
  assert.ok(html.indexOf("납부할 청구") < html.indexOf("합성 첫째 학생"), "돈 낼 게 있으면 맨 위");
  assert.match(html, /보강권 <span class="tabular-nums">2<\/span>장/);
  assert.match(html, /안 읽은 알림 <span[^>]*>3<\/span>건/);
  assert.doesNotMatch(html, /방학특강 결석 신고 · 보강/, "방학 기간이 아니면 방학특강 줄 없음");
  assert.match(html, /href="\/mypage\/regular-absence"[^>]*>[\s\S]*?결석 알리기/);
  assert.match(html, /보강 예약/);
  assert.match(html, /셔틀 변경/);
  assert.match(html, /문의/);
  assert.doesNotMatch(html, /<details/);
});

test("③ 홈: 청구가 없으면 청구 줄이 없고, 방학특강만 다니면 «결석 알리기»가 방학특강 결석으로 간다", () => {
  const html = renderHome({
    data: { parent: { id: "p" }, children: [{ ...childA([]), enrollments: [] }] },
    seasonalUpcoming: 4,
  });
  assert.doesNotMatch(html, /납부할 청구/);
  assert.doesNotMatch(html, /academy-button-primary/);
  assert.match(html, /방학특강 결석 신고 · 보강/);
  assert.match(html, /남은 <span class="tabular-nums">4<\/span>회/);
  assert.match(html, /href="\/mypage\/seasonal"[^>]*>[\s\S]{0,400}결석 알리기/);
  assert.match(html, /새 알림 없음/);
});

test("④ 일정 탭: 신청 줄·수강 반·셔틀 배정, 방학특강 줄은 남은 회차가 있을 때만", () => {
  const Hub = load("src/app/mypage/history/ScheduleHub.tsx", {
    "next/link": link,
    "../ParentShuttleDetail": load("src/app/mypage/ParentShuttleDetail.tsx", { "next/link": link, "@/lib/datetime/kst": kst }),
  }).default;
  const children = [
    { id: "a", name: "합성 첫째", enrollments: [{ id: "e1", className: "초등 저학년반", dayOfWeek: "Mon", startTime: "16:00", endTime: "17:00" }] },
    { id: "b", name: "합성 둘째", enrollments: [{ id: "e2", className: "중등반", dayOfWeek: "Sat", startTime: "10:00", endTime: "11:30", displayStatus: "ACTIVE", startsLater: true, startsOn: "2026-12-05" }] },
  ];
  const shuttle = [{ id: "s1", studentId: "b", sourceType: "REGULAR_CLASS", direction: "PICKUP", status: "CONFIRMED", label: "정규", title: "토요 등원", serviceDate: "2026-11-14", routeName: "A노선", stopName: "정문", stopAddress: null, plannedAt: "2026-11-14T00:40:00.000Z", vehicleName: "1호차", rideStatus: null }];
  const off = renderToStaticMarkup(React.createElement(Hub, { childList: children, shuttleItems: shuttle, driverContact: { name: "합성 기사", phone: "010-0000-1111" }, makeupAvailable: 1, seasonalUpcoming: 0 }));
  for (const href of ["/mypage/regular-absence", "/mypage/makeup", "/mypage/shuttle", "/mypage/enrollment-change"]) assert.match(off, new RegExp(`href="${href}"`));
  assert.doesNotMatch(off, /href="\/mypage\/seasonal"/);
  assert.match(off, /보강권 1장/);
  assert.match(off, /id="mypage-enrollments"/);
  assert.match(off, /합성 둘째<\/span>중등반/, "자녀가 둘이면 이름을 붙인다");
  assert.match(off, /2026-12-05부터 수업 시작/, "승인된 반은 개시일 전에도 수강 중 — 개시일만 안내");
  assert.doesNotMatch(off, /수강 예정/);
  assert.match(off, /id="mypage-shuttle"/);
  assert.match(off, /2026년 11월 14일 토/);
  assert.match(off, /dateTime="2026-11-14T00:40:00.000Z">[^<]*09:40</, "확정 시간은 KST(UTC 00:40 = 09:40)");
  assert.match(off, /href="tel:01000001111"/);
  const on = renderToStaticMarkup(React.createElement(Hub, { childList: children, shuttleItems: [], seasonalUpcoming: 3 }));
  assert.match(on, /href="\/mypage\/seasonal"/);
  assert.match(on, /남은 3회/);
  assert.doesNotMatch(on, /id="mypage-shuttle"/);
});

test("⑤ 앱 안 공지 상세: 전체 공지·우리 아이 반 공지만 보이고 남의 반 공지는 404, 본문은 sanitize 를 거친다", async () => {
  const NOT_FOUND = new Error("NEXT_NOT_FOUND");
  const notices = {
    all: { id: "all", title: "전체 공지", content: "<p>안녕</p><script>x</script>", targetType: "ALL", targetClassIds: null, attachmentsJSON: null, isPinned: true, createdAt: "2026-10-30T15:05:00.000Z" },
    mine: { id: "mine", title: "우리 반 공지", content: "옛 글", targetType: "CLASS", targetClassIds: "k9, k1", attachmentsJSON: null, isPinned: false, createdAt: "2026-10-30T15:05:00.000Z" },
    other: { id: "other", title: "남의 반 공지", content: "비밀", targetType: "CLASS", targetClassIds: "k2", attachmentsJSON: null, isPinned: false, createdAt: "2026-10-30T15:05:00.000Z" },
  };
  let sanitized = 0;
  const Page = load("src/app/mypage/news/[id]/page.tsx", {
    "next/link": link,
    "next/navigation": { notFound: () => { throw NOT_FOUND; } },
    "@/lib/auth-guard": { requireVerifiedParent: async () => ({ appUserId: "p1" }) },
    "@/lib/queries": {
      getNoticeById: async (id) => notices[id] ?? null,
      getMyPageData: async (id) => { assert.equal(id, "p1", "인증된 부모 기준으로만 자녀 반을 읽는다"); return { children: [{ id: "c1", enrollments: [{ classId: "k1" }] }] }; },
    },
    "@/lib/noticeContent": { isHtmlContent: (c) => c.startsWith("<"), isImageAttachment: () => false, toNoticeHtml: (c) => c },
    "@/lib/sanitize": { sanitizeHtml: (html) => { sanitized++; return html.replace(/<script>.*?<\/script>/g, ""); } },
    "@/lib/datetime/kst": kst,
  }).default;
  const all = renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "all" }) }));
  assert.match(all, /전체 공지/);
  assert.match(all, /중요 공지/);
  assert.match(all, /2026년 10월 31일/, "게시일 KST");
  assert.doesNotMatch(all, /<script>/);
  assert.equal(sanitized, 1);
  assert.match(all, /href="\/mypage\/reports#news-notices"/, "돌아가는 길도 앱 안");
  assert.match(renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "mine" }) })), /우리 반 공지/);
  await assert.rejects(Page({ params: Promise.resolve({ id: "other" }) }), NOT_FOUND);
  await assert.rejects(Page({ params: Promise.resolve({ id: "none" }) }), NOT_FOUND);
});
