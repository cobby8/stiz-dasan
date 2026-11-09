// 학부모 화면 구조 개편(2026-11-09 원장 결정 D1 안 A · D6 · D7 · D8) — 실제로 그려서 확인한다.
//  ① 메뉴 4개(홈·수업·청구·소식 — 2026-11-10 d5), 하위 화면에서도 소속 탭이 켜진다, 방학특강 탭 없음
//  ② 로그아웃은 «⋯» 메뉴 안
//  ③ 홈 = 납부 합계 한 줄(꽉 찬 버튼 1개) + 처리할 일 + 빠른 실행 4개, 접힌 칸 없음
//  ④ 일정 탭 = 한 달 달력(연간일정·수업일·출결) + 수강 반 + 셔틀 배정 — 수납·신청 줄 없음(2026-11-09 원장 지시)
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
const statusTones = load("src/lib/ui/statusTones.ts"); // 상태색 공용 지도(학부모 홈 요청 배지)
const link = { __esModule: true, default: ({ children, ...props }) => React.createElement("a", props, children) };
const kst = load("src/lib/datetime/kst.ts");
const summary = load("src/lib/mypage/summary.ts");

test("① 메뉴 4개 — 하위 화면에서도 소속 탭이 켜지고 방학특강 탭은 없다", () => {
  const nav = load("src/app/mypage/MyPageBottomNav.tsx", { "next/link": link, "next/navigation": { usePathname: () => "/mypage" } });
  assert.deepEqual(nav.PARENT_TABS.map((t) => t.label), ["홈", "수업", "청구", "소식"]);
  assert.deepEqual(nav.PARENT_TABS.map((t) => t.href), ["/mypage", "/mypage/classes", "/mypage/payments", "/mypage/reports"]);
  const activeAt = (path) => nav.PARENT_TABS.filter((t) => nav.isParentTabActive(t, path)).map((t) => t.label);
  assert.deepEqual(activeAt("/mypage"), ["홈"]);
  // 달력(/mypage/history)은 주소를 유지한 채 수업 탭 안으로 들어갔다 — 결석·보강·셔틀·수강 변경 화면도 «수업»
  for (const p of ["/mypage/classes", "/mypage/history", "/mypage/regular-absence", "/mypage/makeup", "/mypage/seasonal", "/mypage/shuttle", "/mypage/enrollment-change"]) {
    assert.deepEqual(activeAt(p), ["수업"], p);
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
    "@/lib/ui/statusTones": statusTones,
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
  assert.match(html, /href="\/mypage\/payments\/checkout" class="academy-button-primary shrink-0">한 번에 결제/, "2건 이상 = 한 번에 결제 화면");
  assert.equal((html.match(/academy-button-primary/g) || []).length, 1, "꽉 찬 버튼은 하나(문의 폼은 닫혀 있다)");
  assert.match(html, /계좌 000-111/, "무통장입금 계좌는 홈에서 계속 보인다");
  assert.ok(html.indexOf("납부할 청구") < html.indexOf("합성 첫째 학생"), "돈 낼 게 있으면 맨 위");
  assert.match(html, /보강권 <span class="tabular-nums">2<\/span>장/);
  assert.match(html, /안 읽은 알림 <span[^>]*>3<\/span>건/);
  assert.doesNotMatch(html, /방학특강 결석·보강/, "방학 기간이 아니면 방학특강 줄 없음");
  assert.match(html, /href="\/mypage\/regular-absence"[^>]*>[\s\S]*?결석 알리기/);
  assert.match(html, /보강 예약/);
  assert.match(html, /셔틀 변경/);
  assert.match(html, /문의/);
  assert.doesNotMatch(html, /<details/);
});

test("③ 홈: 청구 합계는 청구 탭과 같은 목록(pendingPayments) 기준 — 묶음 계좌는 한 번만, 연결 가족은 청구 보기", () => {
  const bundleVa = { bankName: "합성은행", accountNumber: "999-000", customerName: null, amount: 300000, dueDate: "2026-11-20", dueLabel: "", expired: false };
  // getMyPageData 는 최근 5건만 오므로 자녀 목록엔 1건뿐이어도, 청구 탭 기준 목록이 3건이면 3건으로 센다
  const html = renderHome({
    data: { parent: { id: "p" }, children: [childA([{ id: "p1", amount: 100000, status: "PENDING", dueDate: "2026-11-10", paidDate: null }])] },
    pendingPayments: [
      { id: "p1", amount: 100000, status: "PENDING", canCheckout: true, virtualAccount: bundleVa },
      { id: "p2", amount: 150000, status: "OVERDUE", canCheckout: true, virtualAccount: bundleVa },
      { id: "p3", amount: 50000, status: "PENDING", canCheckout: true, virtualAccount: null },
    ],
  });
  assert.match(html, /납부할 청구 <span class="tabular-nums">3<\/span>건/);
  assert.match(html, /합계 300,000원/);
  assert.equal((html.match(/계좌 999-000/g) || []).length, 1, "묶음 계좌는 한 번만");
  assert.match(html, /청구 2건을 묶은 계좌 · 합계 300,000원/);
  const one = renderHome({
    data: { parent: { id: "p" }, children: [childA([])] },
    pendingPayments: [{ id: "p1", amount: 100000, status: "PENDING", canCheckout: true }],
  });
  assert.match(one, /href="\/mypage\/payments\/checkout" class="academy-button-primary shrink-0">결제하기/, "1건이면 «결제하기»");
  const family = renderHome({
    data: { parent: { id: "p" }, children: [childA([])] },
    pendingPayments: [{ id: "p1", amount: 100000, status: "PENDING", canCheckout: false }],
  });
  assert.match(family, /href="\/mypage\/payments" class="academy-button-primary shrink-0">청구 보기/, "연결 가족은 결제 대신 청구 목록");
  assert.match(family, /대표 보호자 계정에서/);
});

test("③ 홈: 청구가 없으면 청구 줄이 없고, 방학특강만 다니면 «결석 알리기»가 방학특강 결석으로 간다", () => {
  const html = renderHome({
    data: { parent: { id: "p" }, children: [{ ...childA([]), enrollments: [] }] },
    seasonalUpcoming: 4,
  });
  assert.doesNotMatch(html, /납부할 청구/);
  assert.doesNotMatch(html, /academy-button-primary/);
  assert.match(html, /방학특강 결석·보강/);
  assert.match(html, /남은 <span class="tabular-nums">4<\/span>회/);
  assert.match(html, /href="\/mypage\/seasonal"[^>]*>[\s\S]{0,400}결석 알리기/);
  assert.match(html, /새 알림 없음/);
});

test("④ 일정 달력: 달력·수강 반·셔틀 배정만, 신청 줄은 없고 «수강 변경 신청»은 수업 탭 반 카드로 옮겼다", () => {
  const parentSchedule = load("src/lib/mypage/parentSchedule.ts", { "@/lib/datetime/kst": kst, "@/lib/classSchedule": load("src/lib/classSchedule.ts") });
  const Hub = load("src/app/mypage/history/ScheduleHub.tsx", {
    "next/link": link, "@/lib/datetime/kst": kst, "@/lib/mypage/parentSchedule": parentSchedule,
    "../ParentShuttleDetail": load("src/app/mypage/ParentShuttleDetail.tsx", { "next/link": link, "@/lib/datetime/kst": kst }),
  }).default;
  const children = [
    { id: "a", name: "합성 첫째", enrollments: [{ id: "e1", className: "초등 저학년반", dayOfWeek: "Mon", startTime: "16:00", endTime: "17:00" }] },
    { id: "b", name: "합성 둘째", enrollments: [{ id: "e2", className: "중등반", dayOfWeek: "Sat", startTime: "10:00", endTime: "11:30", displayStatus: "ACTIVE", startsLater: true, startsOn: "2026-12-05" }] },
  ];
  const view = parentSchedule.buildParentMonth({ month: "2026-11", todayYmd: "2026-11-09", events: [], classDates: ["2026-11-14"], attendance: [] });
  const shuttle = [{ id: "s1", studentId: "b", sourceType: "REGULAR_CLASS", direction: "PICKUP", status: "CONFIRMED", label: "정규", title: "토요 등원", serviceDate: "2026-11-14", routeName: "A노선", stopName: "정문", stopAddress: null, plannedAt: "2026-11-14T00:40:00.000Z", vehicleName: "1호차", rideStatus: null }];
  const html = renderToStaticMarkup(React.createElement(Hub, { childList: children, selectedChildId: "b", view, shuttleItems: shuttle, driverContact: { name: "합성 기사", phone: "010-0000-1111" } }));
  for (const href of ["/mypage/regular-absence", "/mypage/makeup", "/mypage/enrollment-change", "/mypage/seasonal"]) assert.doesNotMatch(html, new RegExp(`href="${href}"`), href);
  assert.match(html, /href="\/mypage\/history\?child=a&amp;month=2026-11" class="academy-choice"/, "자녀를 바꿔도 같은 달");
  assert.match(html, /href="\/mypage\/history\?child=b&amp;month=2026-11" aria-current="page" class="academy-choice is-selected"/);
  assert.match(html, /id="mypage-enrollments"/);
  assert.match(html, /중등반/);
  assert.doesNotMatch(html, /초등 저학년반/, "수강 반은 고른 자녀 것만(달력과 같은 기준)");
  assert.match(html, /12월 5일부터 수업 시작/, "승인된 반은 개시일 전에도 수강 중 — 개시일만 안내");
  assert.doesNotMatch(html, /수강 예정/);
  assert.match(html, /14일 수업/);
  assert.match(html, /이 달 행사·휴무 없음/);
  // 셔틀 배정은 남는다(홈 «오늘 셔틀»이 데려오는 자리) — 셔틀 변경 화면 링크는 배정 칸 안에만
  assert.match(html, /id="mypage-shuttle"/);
  assert.match(html, /2026년 11월 14일 토/);
  assert.match(html, /dateTime="2026-11-14T00:40:00.000Z">[^<]*09:40</, "확정 시간은 KST(UTC 00:40 = 09:40)");
  assert.match(html, /href="tel:01000001111"/);
  const empty = renderToStaticMarkup(React.createElement(Hub, { childList: children, selectedChildId: "a", view, planReady: false, shuttleItems: [] }));
  assert.doesNotMatch(empty, /id="mypage-shuttle"/);
  assert.match(empty, /이 달 수업일은 연간일정 확정 후 보여요/);
  // «수강 변경 신청»은 «⋯» 메뉴에서 빠지고(2026-11-10 d5) 수업 탭 반 카드의 [반 변경·휴원 ▾]가 길이다
  assert.doesNotMatch(read("src/app/mypage/ParentMoreMenu.tsx"), /href: "\/mypage\/enrollment-change"/);
  assert.match(read("src/lib/parent/classCards.ts"), /presetHref\("\/mypage\/enrollment-change"/);
});

test("⑤ 앱 안 공지 상세: 전체 공지·우리 아이 반 공지만 보이고 남의 반 공지는 404, 본문은 sanitize 를 거친다", async () => {
  const NOT_FOUND = new Error("NEXT_NOT_FOUND");
  const notices = {
    all: { id: "all", title: "전체 공지", content: "<p>안녕</p><script>x</script>", targetType: "ALL", targetClassIds: null, attachmentsJSON: null, isPinned: true, createdAt: "2026-10-30T15:05:00.000Z" },
    mine: { id: "mine", title: "우리 반 공지", content: "옛 글", targetType: "CLASS", targetClassIds: "k9, k1", attachmentsJSON: null, isPinned: false, createdAt: "2026-10-30T15:05:00.000Z" },
    other: { id: "other", title: "남의 반 공지", content: "비밀", targetType: "CLASS", targetClassIds: "k2", attachmentsJSON: null, isPinned: false, createdAt: "2026-10-30T15:05:00.000Z" },
    // 선생님 반 공지(actions/staff-notices.ts)는 JSON 배열로 저장된다 — 우리 반이면 보여야 한다
    teacher: { id: "teacher", title: "선생님 반 공지", content: "준비물", targetType: "CLASS", targetClassIds: '["k1"]', attachmentsJSON: null, isPinned: false, createdAt: "2026-10-30T15:05:00.000Z" },
    teacherOther: { id: "teacherOther", title: "남의 반 선생님 공지", content: "비밀", targetType: "CLASS", targetClassIds: '["k2"]', attachmentsJSON: null, isPinned: false, createdAt: "2026-10-30T15:05:00.000Z" },
    // 전체·반 공지가 아닌 대상은 학부모에게 보이지 않는다
    staff: { id: "staff", title: "직원 공지", content: "내부", targetType: "STAFF", targetClassIds: null, attachmentsJSON: null, isPinned: false, createdAt: "2026-10-30T15:05:00.000Z" },
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
    "@/lib/noticeTargets": load("src/lib/noticeTargets.ts", {}),
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
  assert.match(renderToStaticMarkup(await Page({ params: Promise.resolve({ id: "teacher" }) })), /선생님 반 공지/, "JSON 배열 대상 반도 읽는다");
  await assert.rejects(Page({ params: Promise.resolve({ id: "teacherOther" }) }), NOT_FOUND);
  await assert.rejects(Page({ params: Promise.resolve({ id: "staff" }) }), NOT_FOUND, "ALL·CLASS 말고는 404");
});
