// 목록 개편 8단계 B — 학부모 마이페이지 목록(휴대폰 390px · 앱 웹뷰).
// 지키는 약속: ① 한 줄 행(44~56px)·«·»로 이어 붙인 글을 요소로 나눔·말줄임 금지
//             ② 숫자·날짜 오른쪽 + tabular-nums ③ 상태 칩(목록과 같은 판정) ④ 날짜 중요한 목록은 날짜 묶음(KST 모듈만)
//             ⑤ 터치 44px ⑥ 제출 동작(신청·취소·신고·예약)과 확인 단계는 그대로
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const read = (path) => readFileSync(path, "utf8");

// TSX 를 실제로 렌더해 본다(날짜 묶음은 눈으로 읽어서는 하루 밀림을 못 잡는다)
function compileModule(path, imports = {}) {
  const compiled = ts.transpileModule(read(path), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Intl, Date, Number, Math, require: (name) => name in imports ? imports[name] : require(name) });
  return module.exports;
}
const Link = ({ children, ...props }) => React.createElement("a", props, children);
const kst = compileModule("src/lib/datetime/kst.ts");
const chips = compileModule("src/components/admin/list/StatusCountChips.tsx");
// 상태색 공용 지도(2026-11-09 색상 정리) — 학부모 보강·방학특강 배지가 쓴다
const statusTones = compileModule("src/lib/ui/statusTones.ts");
const monthGroups = compileModule("src/components/admin/list/monthDateGroups.ts", { "@/lib/datetime/kst": kst });
// 취소·거절의 «그 자리 확인» 공용 부품(게슈탈트 C-M1) — 취소 버튼을 쓰는 화면이 함께 불러온다
const inlineConfirm = compileModule("src/components/parent/InlineConfirm.tsx");
// 오류 원문 대신 고객용 한국어를 고르는 공용 함수(개발 언어 제거) — 오류를 보여 주는 화면이 함께 불러온다
const customerMessageModule = compileModule("src/components/parent/customerMessage.ts");

// 2026-11-09 원장 지시: «일정» 탭 = 연간일정·수업일·출결을 한 달 달력으로. 수납 기록·신청 줄은 뺐다.
const classSchedule = compileModule("src/lib/classSchedule.ts");
const parentSchedule = compileModule("src/lib/mypage/parentSchedule.ts", { "@/lib/datetime/kst": kst, "@/lib/classSchedule": classSchedule });

test("일정 탭 달력: 출결은 KST 날짜 칸에 찍히고, 수업일·휴무·행사가 한 달에 모이며 수납·신청 줄은 없다", () => {
  const view = parentSchedule.buildParentMonth({
    month: "2026-10",
    todayYmd: "2026-10-15",
    events: [
      { title: "학원 휴무", date: "2026-10-09T00:00:00.000Z" }, // 한글날 — 종일 일정(UTC 자정)
      { title: "가을 대회", date: "2026-10-24T00:00:00.000Z", endDate: "2026-10-25T00:00:00.000Z" },
      { title: "10월 2주차", date: "2026-10-05T00:00:00.000Z" }, // 운영용 주차 표시 — 목록에서 뺀다
      { title: "가을 대회", date: "2026-10-24T00:00:00.000Z" }, // 같은 날짜+제목 = 한 번만
      { title: "9월 행사", date: "2026-09-20T00:00:00.000Z" }, // 다른 달
    ],
    classDates: ["2026-10-01", "2026-10-08", "2026-10-09", "2026-10-15", "2026-11-05"],
    attendance: [
      // KST 10/1 00:00 = UTC 9/30 15:00 — toISOString 이면 9/30 으로 하루 밀린다
      { status: "PRESENT", date: "2026-09-30T15:00:00.000Z" },
      { status: "ABSENT", date: "2026-10-07T15:00:00.000Z" },
      { status: "PRESENT", date: "2026-09-29T15:00:00.000Z" }, // KST 9/30 — 다른 달
    ],
  });
  const cells = view.weeks.flat().filter(Boolean);
  const day = (n) => cells.find((c) => c.day === n);
  assert.equal(cells.length, 31);
  assert.equal(view.weeks[0].findIndex(Boolean), 4, "2026-10-01 은 목요일(일요일 시작 5번째 칸)");
  assert.equal(day(1).attendance, "PRESENT");
  assert.equal(day(8).attendance, "ABSENT");
  assert.equal(day(9).closed, true);
  assert.equal(day(9).isClass, false, "휴무일에는 수업 표시가 없다");
  assert.equal(day(15).isToday, true);
  assert.equal(day(24).hasEvent && day(25).hasEvent, true, "여러 날 행사는 끝 날까지");
  assert.deepEqual(JSON.parse(JSON.stringify(view.summary)), { classCount: 3, present: 1, late: 0, absent: 1 });
  assert.deepEqual(JSON.parse(JSON.stringify(view.events.map((e) => e.title))), ["학원 휴무", "가을 대회"]);

  const Hub = compileModule("src/app/mypage/history/ScheduleHub.tsx", {
    "next/link": { default: Link },
    "../ParentShuttleDetail": { default: () => null },
    "@/lib/datetime/kst": kst,
    "@/lib/mypage/parentSchedule": parentSchedule,
  }).default;
  const html = renderToStaticMarkup(React.createElement(Hub, {
    childList: [{ id: "c1", name: "합성 학생", enrollments: [{ id: "e1", className: "초등 저학년반", dayOfWeek: "Thu", startTime: "16:00", endTime: "17:00" }] }],
    selectedChildId: "c1", view, shuttleItems: [],
  }));
  assert.match(html, /2026년 10월/);
  assert.match(html, /href="\/mypage\/history\?child=c1&amp;month=2026-09"[^>]*aria-label="이전 달"/);
  assert.match(html, /href="\/mypage\/history\?child=c1&amp;month=2026-11"[^>]*aria-label="다음 달"/);
  assert.match(html, /수업 <span class="tabular-nums">3<\/span>회/);
  assert.match(html, /1일 출석/);
  assert.match(html, /8일 결석/);
  assert.match(html, /9일 휴무/);
  // 2026-11-09 원장 «색상 구분이 잘 안 돼» — 색만이 아니라 모양으로도 갈린다(색약 대비)
  assert.match(html, /15일 오늘/, "오늘도 낭독기에 읽힌다");
  assert.match(html, /ring-\[var\(--color-academy-cal-today\)\]/, "오늘 = 굵은 테두리");
  assert.match(html, /rounded-full bg-\[var\(--color-academy-cal-present\)\]/, "출석 = 채운 점");
  assert.match(html, /border-2 border-\[var\(--color-academy-cal-late\)\]/, "지각 = 빈 고리(범례)");
  assert.match(html, /text-\[var\(--color-academy-cal-absent\)\][^>]*>close</, "결석 = ×");
  assert.match(html, /text-\[var\(--color-academy-cal-event\)\][^>]*>star</, "행사 = 별");
  for (const token of ["present", "late", "absent", "event", "closed", "closed-soft", "class-soft", "class-line", "today"]) {
    assert.match(read("src/app/academy-theme.css"), new RegExp(`--color-academy-cal-${token}:`), `토큰 ${token} 정의`);
  }
  assert.match(html, /10\/24\(토\)~10\/25\(일\)/);
  assert.match(html, /id="schedule-records-heading"/, "옛 홈 «기록» 주소가 데려오는 자리");
  assert.match(html, /id="mypage-enrollments"/);
  // 수납·신청 줄은 이 화면에 없다(수납 = 청구 탭, 신청 = 홈 빠른 실행·«⋯» 메뉴)
  assert.doesNotMatch(html, /href="\/payments\/|납부|수납/);
  for (const href of ["/mypage/regular-absence", "/mypage/makeup", "/mypage/shuttle", "/mypage/enrollment-change", "/mypage/seasonal"]) {
    assert.doesNotMatch(html, new RegExp(`href="${href}"`), href);
  }
  const source = read("src/app/mypage/history/ScheduleHub.tsx");
  assert.match(source, /min-h-11 items-center gap-2 px-3 py-2/);
});

test("일정 탭 달 계산: 잘못된 ?month 는 이번 달, 수강월이 달력 달과 어긋나도 이 달 날짜만, 개시일 전은 뺀다", () => {
  assert.equal(parentSchedule.parseMonthParam("2026-13", "2026-11-09"), "2026-11");
  assert.equal(parentSchedule.parseMonthParam(undefined, "2026-11-09"), "2026-11");
  assert.equal(parentSchedule.parseMonthParam("2027-01", "2026-11-09"), "2027-01");
  assert.equal(parentSchedule.shiftMonth("2026-12", 1), "2027-01");
  assert.equal(parentSchedule.shiftMonth("2027-01", -1), "2026-12");
  const plan = { "2026-10": ["2026-10-26"], "2026-11": ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23"], "2026-12": ["2026-11-30", "2026-12-07"] };
  const dates = parentSchedule.classDatesForCalendarMonth("2026-11", "Mon", "2026-11-09", (ym) => plan[ym] ?? []);
  assert.deepEqual(JSON.parse(JSON.stringify(dates)), ["2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
  // 3개월 기준 — 말일 보정(5/31 의 3개월 전 = 2/28)
  assert.equal(parentSchedule.monthsBeforeYmd("2027-05-31", 3), "2027-02-28");
  assert.equal(parentSchedule.monthsBeforeYmd("2027-01-15", 3), "2026-10-15");
});

test("보강 예약은 4칸 집계판 대신 상태 칩(서버 집계와 같은 판정)과 한 목록의 행으로 보이고 예약·취소 흐름은 그대로다", () => {
  const Makeup = compileModule("src/app/mypage/makeup/MakeupClient.tsx", {
    "@/lib/ui/statusTones": statusTones,
    "@/components/parent/customerMessage": customerMessageModule, 
    "next/link": { default: Link },
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/app/actions/parent-makeup": { fetchMakeupOptions: async () => ({ ok: true, options: [] }), bookMakeupAction: async () => ({ ok: true }), cancelMakeupAction: async () => ({ ok: true }) },
    "@/components/admin/list/StatusCountChips": chips,
    "@/lib/datetime/kst": kst,
    "@/components/parent/InlineConfirm": inlineConfirm,
  }).default;
  const credit = (id, status, expiresYmd, booking = null) => ({ id, studentId: "s1", studentName: "합성", studentGrade: null, sourceLabel: "정규", absenceLabel: "10/1(목)", expiresLabel: "12/1(화)", expiresYmd, status, booking });
  const html = renderToStaticMarkup(React.createElement(Makeup, { initial: {
    counts: { available: 1, reserved: 1, used: 1, expired: 1 },
    credits: [
      credit("a", "AVAILABLE", "2999-12-01"),
      credit("b", "RESERVED", "2999-12-01", { sessionId: "x", className: "초등 고학년반", dateLabel: "11/5(목)" }),
      credit("c", "USED", "2999-12-01"),
      credit("d", "AVAILABLE", "2000-01-01"),
    ],
  } }));
  assert.match(html, /aria-label="보강권 상태별 건수"/);
  for (const label of ["사용 가능", "예약 중", "사용 완료", "만료"]) {
    assert.match(html, new RegExp(`>${label}<span class="tabular-nums[^"]*">1</span>`), `${label} 칩 1건`);
  }
  // «·»로 잇던 글을 요소로 나눴다
  assert.doesNotMatch(html, /정규 · 10\/1/);
  assert.doesNotMatch(html, /초등 고학년반 · 11\/5/);
  assert.match(html, /사용 기한 12\/1\(화\)까지/);
  assert.match(html, />보강 예약하기</);
  assert.match(html, />예약 취소</);

  const source = read("src/app/mypage/makeup/MakeupClient.tsx");
  assert.match(source, /const today = todayKst\(\);/);
  assert.doesNotMatch(source, /\.toISOString\(\)/);
  // 예약 = 반 열기 → 날짜 고르기 → «이 날짜로 예약», 취소 = 그 자리 확인 후 같은 cancel(c.id) (게슈탈트 M-02)
  assert.match(source, /bookMakeupAction\(\{ creditId, classId: pick\.classId, dateYmd: pick\.ymd \}\)/);
  assert.match(source, /onClick=\{\(\) => book\(c\.id\)\}[\s\S]*?이 날짜로 예약/);
  assert.match(source, /onConfirm=\{\(\) => cancel\(c\.id\)\}/);
});

test("정규 결석 신고는 반 카드 속 작은 카드 대신 날짜 묶음(오늘/이번 주/다음 주/이후)의 한 줄 행이고 신고 흐름은 그대로다", () => {
  const groups = compileModule("src/components/admin/list/upcomingDateGroups.ts", { "@/lib/datetime/kst": kst });
  const Absence = compileModule("src/app/mypage/regular-absence/RegularAbsenceClient.tsx", {
    "@/components/parent/customerMessage": customerMessageModule, 
    "next/link": { default: Link },
    "@/components/admin/list/upcomingDateGroups": groups,
    "@/lib/datetime/kst": kst,
    "@/components/parent/InlineConfirm": inlineConfirm,
  }).default;
  const today = kst.todayKst();
  const date = (offset, extra = {}) => {
    const ymd = kst.addDaysKst(today, offset);
    return { studentId: "s1", studentName: "합성", classId: "c1", className: "초등 저학년반", date: ymd, dateLabel: kst.kstLabel(ymd), startTime: "16:00", reason: null, reasonLabel: null, status: null, reported: false, locked: false, ...extra };
  };
  const html = renderToStaticMarkup(React.createElement(Absence, {
    initial: [{ studentId: "s1", studentName: "합성", classes: [{ classId: "c1", className: "초등 저학년반", dayOfWeek: "Mon", startTime: "16:00", dates: [
      date(0, { reported: true, reasonLabel: "개인 사정", reason: "PERSONAL", status: "REPORTED" }),
      date(30, { locked: true, reported: true, reasonLabel: "질병/부상", reason: "ILLNESS_INJURY", status: "CONFIRMED" }),
    ] }] }],
    makeups: [{ id: "m1", studentName: "합성", originalClassName: "초등 저학년반", originalDateLabel: "10/1(목)", makeupClassName: "초등 고학년반", makeupDateLabel: "11/5(목)", status: "SCHEDULED", statusLabel: "예정" }],
  }));
  assert.match(html, /aria-label="합성 오늘"/);
  assert.match(html, /aria-label="합성 이후"/);
  assert.match(html, />결석 신고됨<\/span><span class="text-xs[^"]*">개인 사정</);
  assert.match(html, /확정됨<\/span><span class="text-xs[^"]*">질병\/부상</);
  assert.doesNotMatch(html, /확정됨 · |결석 신고됨 · |초등 고학년반 · 11\/5/);
  assert.match(html, />신고 취소</);
  assert.match(html, /학원 확정 \(변경은 문의\)/);
  assert.match(html, /\(결석: 초등 저학년반 10\/1\(목\)\)/);

  const source = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(source, /groupByUpcomingDate\(child\.classes\.flatMap\(\(cl\) => cl\.dates\), \(d\) => d\.date, today, DATE_GROUP_LABELS\)/);
  assert.match(source, /const today = todayKst\(\);/);
  assert.doesNotMatch(source, /min-h-9/, "버튼·선택칸은 터치 44px");
  // 신고 = «결석 신고»로 폼 열기 → 사유 선택 → «신고하기» (기존 단계 보존)
  assert.match(source, /onClick=\{\(\) => setOpenKey\(key\)\}/);
  assert.match(source, /if \(!r\) \{\s*setErr\("결석 사유를 선택해 주세요\."\);/);
  assert.match(source, /onClick=\{\(\) => report\(d\)\}/);
  assert.match(source, /onConfirm=\{\(\) => cancel\(d\)\}/);
});

test("수업 리포트 목록은 KST 달별 묶음·한 줄 행(주제·날짜 오른쪽 / 반·시간·담당)이고 상세 링크는 그대로다", async () => {
  const Page = compileModule("src/app/mypage/reports/page.tsx", {
    "next/link": { default: Link },
    "@/lib/supabase/server": { createClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }) },
    "@/lib/auth-guard": { requireVerifiedParent: async () => ({ appUserId: "p1" }) },
    "@/lib/queries": { getStudentReports: async () => [
      // KST 10/1 00:00 = UTC 9/30 15:00 — 서버(UTC)의 toLocaleDateString 이면 9/30 으로 찍힌다
      { sessionId: "s1", date: "2026-09-30T15:00:00.000Z", topic: "드리블 기초", className: "초등 저학년반", dayOfWeek: "Thu", startTime: "16:00", endTime: "17:00", coachName: "합성 코치" },
      { sessionId: "s2", date: "2026-09-10T15:00:00.000Z", topic: null, className: "초등 저학년반", dayOfWeek: "Fri", startTime: "16:00", endTime: "17:00", coachName: null },
    ],
      // 2026-11-09 «소식» 탭 — 공지·피드백·사진을 함께 읽는다(이 검증은 리포트 목록만 본다)
      getMyPageData: async () => ({ children: [{ id: "c1", enrollments: [{ classId: "k1" }] }] }),
      getNoticesByClassIds: async () => [
        { id: "n1", title: "합성 공지", content: "<p>본문</p>", isPinned: false, createdAt: "2026-10-30T15:05:00.000Z" },
        { id: "n2", title: "둘째 공지", content: "", isPinned: false, createdAt: "2026-10-01T00:00:00.000Z" },
        { id: "n3", title: "셋째 공지", content: "", isPinned: false, createdAt: "2026-09-01T00:00:00.000Z" },
        { id: "n4", title: "넷째 공지", content: "", isPinned: false, createdAt: "2026-08-08T15:00:00.000Z" }, // KST 8/9 = 딱 3개월 전 → 보인다
        { id: "old", title: "오래된 공지", content: "", isPinned: false, createdAt: "2026-08-08T14:00:00.000Z" }, // KST 8/8 → 숨김
        { id: "pin", title: "고정 안내", content: "", isPinned: true, createdAt: "2026-03-02T00:00:00.000Z" }, // 고정 공지 = 오래돼도 보이고 맨 앞
      ],
      getChildrenFeedbacks: async () => [],
      getGalleryByClassIds: async () => [],
    },
    "@/components/pwa/HideInInstalledApp": { default: ({ children }) => children },
    "@/components/pwa/AppSafeLink": { default: Link },
    // 오늘을 고정 — 3개월 지난 공지 숨김이 실행 날짜에 따라 달라지지 않게
    "@/lib/datetime/kst": { ...kst, todayKst: () => "2026-11-09" },
    "@/lib/mypage/parentSchedule": parentSchedule,
    "@/components/admin/list/monthDateGroups": monthGroups,
  }).default;
  const html = renderToStaticMarkup(await Page());
  assert.match(html, /aria-label="2026년 10월"/);
  assert.match(html, /aria-label="2026년 9월"/);
  assert.match(html, /10\/1\(목\)/);
  assert.match(html, /9\/11\(금\)/);
  assert.match(html, /href="\/mypage\/reports\/s1"/);
  assert.match(html, />수업 리포트</);
  assert.match(html, /담당: 합성 코치/);
  assert.doesNotMatch(html, / \| 초등/,"«날짜 | 반 (요일 시간)» 이어 붙인 글은 요소로 나눴다");
  assert.doesNotMatch(read("src/app/mypage/reports/page.tsx"), /\.toLocaleDateString\(/);
  // «소식» 탭: 공지가 맨 위, 상세는 앱 안 주소, 날짜는 KST(UTC 10/30 15:05 = KST 10/31)
  assert.match(html, /<h1[^>]*>소식<\/h1>/);
  assert.match(html, /href="\/mypage\/news\/n1"/);
  assert.match(html, /합성 공지/);
  assert.match(html, /10\. 31\./);
  assert.ok(html.indexOf("합성 공지") < html.indexOf("드리블 기초"), "공지가 리포트보다 위");
  assert.doesNotMatch(html, /href="#news-feedback"|href="#news-photos"/, "건수 0 인 칸은 칩도 숨긴다");
  // 공지: 3개월 넘은 것은 숨기고(고정 공지는 예외·맨 앞), 3개만 먼저 — 나머지는 «더보기» 안
  assert.doesNotMatch(html, /오래된 공지/);
  assert.ok(html.indexOf("고정 안내") > 0 && html.indexOf("고정 안내") < html.indexOf("합성 공지"), "고정 공지는 오래돼도 맨 앞");
  assert.match(html, /href="#news-notices"[^>]*>공지<span class="tabular-nums[^"]*">5<\/span>/);
  const more = html.indexOf("<details");
  assert.ok(more > html.indexOf("둘째 공지") && more < html.indexOf("셋째 공지"), "고정 1 + 최근 2 = 3개, 셋째부터 더보기 안");
  assert.match(html, /더보기 <span class="tabular-nums">2<\/span>/);
});

test("셔틀 예정 변경은 날짜 묶음의 한 줄 행이고 행 탭=하단 시트, 행 안 «취소»는 번지지 않고 바로 취소한다", () => {
  const groups = compileModule("src/components/admin/list/upcomingDateGroups.ts", { "@/lib/datetime/kst": kst });
  const Shuttle = compileModule("src/app/mypage/shuttle/ShuttleExceptionClient.tsx", {
    "@/components/parent/customerMessage": customerMessageModule, 
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/lib/shuttle/dayExceptionRules": compileModule("src/lib/shuttle/dayExceptionRules.ts"),
    "@/lib/parent-staff-status": { deliveryStatusText: () => "사이트 알림 등록 1건 · 푸시 전송 접수 1건", matchesShuttleChange: () => false },
    "@/components/admin/list/ListDetailPanel": { default: ({ children }) => React.createElement("div", { "data-sheet": "" }, children) },
    "@/components/admin/list/upcomingDateGroups": groups,
    "@/lib/datetime/kst": kst,
    "@/components/parent/InlineConfirm": inlineConfirm,
  }).default;
  const today = "2026-10-29"; // 목요일
  const row = (id, serviceDate, extra = {}) => ({ id, studentId: "s1", studentName: "합성", serviceDate, direction: "PICKUP", kind: "LOCATION", location: "다산초 정문 앞", note: null, notificationStatus: { driverLinked: false }, ...extra });
  const html = renderToStaticMarkup(React.createElement(Shuttle, { initial: {
    today, maxDate: "2026-11-12", children: [{ studentId: "s1", studentName: "합성" }],
    upcoming: [row("a", "2026-10-29"), row("b", "2026-11-03", { kind: "SKIP", location: null })],
  } }));
  assert.match(html, /<span>오늘<\/span>/);
  assert.match(html, /<span>다음 주<\/span>/);
  assert.match(html, /10\/29\(목\)/);
  assert.match(html, /11\/3\(화\)/);
  assert.doesNotMatch(html, /2026-10-29 · 합성/, "«날짜 · 학생» 이어 붙인 글은 요소로 나눴다");
  assert.match(html, /다산초 정문 앞/);
  assert.match(html, /담당 기사님 배정은 학원에서 확인 중/);
  assert.doesNotMatch(html, /알림함 등록/, "긴 알림 결과는 행이 아니라 시트에서");
  assert.doesNotMatch(html, /data-sheet/, "처음엔 시트가 닫혀 있다");

  const source = read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx");
  assert.match(source, /function handleRowKeyDown\(event: KeyboardEvent<HTMLElement>, id: string\) \{\s*if \(event\.target !== event\.currentTarget\) return;/);
  // 행 안 «취소» = 그 자리 확인 후 같은 cancel(item.id), 행 탭으로 번지지 않게 stopPropagation (게슈탈트 M-02)
  assert.match(source, /<InlineConfirm[\s\S]*?onConfirm=\{\(\) => cancel\(item\.id\)\}[\s\S]*?stopPropagation[\s\S]*?\/>/);
  assert.match(source, /<ListDetailPanel onClose=\{\(\) => setDetailId\(null\)\}[\s\S]*?parentDeliveryText\(item\.notificationStatus\)/);
  // 저장·취소 흐름 보존(결과 확인 필요 시 재조회, 중복 제출 막기)
  assert.match(source, /if \(response\.status >= 500\) return reconcile\(body\);/);
  assert.match(source, /if \(!\(await send\(\{ action: "cancel", id \}\)\)\) return;/);
  assert.match(source, /disabled=\{pending \|\| Boolean\(uncertain\)\}/);
});

test("방학특강 결석·보강은 세 목록이 한 목록의 행이고 배지·사유·날짜를 요소로 나누며 신청·신고 흐름은 그대로다", () => {
  const Seasonal = compileModule("src/app/mypage/seasonal/SeasonalMakeupClient.tsx", { "@/lib/ui/statusTones": statusTones, "@/components/parent/customerMessage": customerMessageModule, "@/components/parent/InlineConfirm": inlineConfirm }).default;
  const html = renderToStaticMarkup(React.createElement(Seasonal, { initial: {
    phoneKnown: true,
    absences: [{ enrollmentDateId: "e1", childName: "합성", offeringTitle: "겨울 방학특강 저학년", absentLabel: "1/5(월)", seasonalCandidates: [], regularCandidates: [] }],
    makeups: [{ id: "m1", childName: "합성", offeringTitle: "겨울 방학특강 저학년", absentLabel: "1/5(월)", targetLabel: "1/12(월)", targetType: "SEASONAL", status: "REQUESTED" }],
  } }));
  assert.match(html, /<ul class="divide-y/);
  assert.doesNotMatch(html, /· 겨울 방학특강/, "«자녀 · 특강» 이어 붙인 글은 요소로 나눴다");
  assert.match(html, /1\/5\(월\) 결석/);
  assert.match(html, />보강 신청</);
  assert.match(html, /신청 접수 \(승인 대기\)/);

  const source = read("src/app/mypage/seasonal/SeasonalMakeupClient.tsx");
  assert.doesNotMatch(source, /결석 신고됨 · /);
  assert.doesNotMatch(source, /min-h-(?:8|9)\b|text-\[11px\]/, "터치 44px·글자 12px 이상");
  // 신청·신고·취소 흐름 보존
  assert.match(source, /onClick=\{\(\) => request\(ab\.enrollmentDateId, "SEASONAL", s\)\}/);
  assert.match(source, /onClick=\{\(\) => request\(ab\.enrollmentDateId, "REGULAR", c\)\}/);
  assert.match(source, /onClick=\{\(\) => reportAbsence\(s\.enrollmentDateId\)\} disabled=\{busy \|\| !seatReason\[s\.enrollmentDateId\]\}/);
  assert.match(source, /onConfirm=\{\(\) => cancelAbsence\(s\.enrollmentDateId\)\}/);
  assert.match(source, /신고하면 그날 셔틀 배차에서도 자동 제외됩니다\./);
});

test("가족 연결의 받은 요청·보낸 요청 행은 요소로 나뉘고 상태 칩·요청일(오른쪽)을 보이며 승인 확인 단계는 그대로다", () => {
  const source = read("src/app/mypage/children/ChildConnectionsClient.tsx");
  assert.doesNotMatch(source, /<\/b> · \{row\.requesterName/, "«자녀 · 요청자 · 연락처» 이어 붙인 글은 요소로 나눴다");
  assert.match(source, /<span className="ml-auto text-right tabular-nums[^"]*">\{kstLabel\(row\.createdAt\)\}<\/span>/);
  assert.match(source, /className="flex min-h-11 flex-wrap items-center gap-2 py-2 text-sm"/);
  // 승인·거절은 «검토» → 확인 문구 → 최종 버튼 2단계 그대로, 요청 취소도 그대로
  assert.match(source, /setDecision\(\{ id: row\.id, decision: "APPROVE" \}\)\}>승인 검토</);
  assert.match(source, /onClick=\{resolveRequest\}[\s\S]*?가족 연결 승인/);
  assert.match(source, /childLinkRequest\(\{ action: "cancel", requestId: row\.id \}\)/);
  assert.equal(kst.kstLabel("2026-10-29T16:30:00.000Z"), "10/30(금)", "KST 자정 넘긴 요청은 다음 날로");
});
