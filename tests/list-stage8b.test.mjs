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
import * as seatLevelModule from "../src/lib/seats/seatLevel.ts";

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
// 수업 피드 순수 규칙(소식 목록의 개수 표시) — 실제 모듈을 돌린다
const feedRules = compileModule("src/lib/feed/rules.ts", {
  "@/lib/datetime/kst": kst,
  "@/lib/sessionVideo/rules": compileModule("src/lib/sessionVideo/rules.ts", { "@/lib/datetime/kst": kst }),
});
// 취소·거절의 «그 자리 확인» 공용 부품(게슈탈트 C-M1) — 취소 버튼을 쓰는 화면이 함께 불러온다
const inlineConfirm = compileModule("src/components/parent/InlineConfirm.tsx");
// 오류 원문 대신 고객용 한국어를 고르는 공용 함수(개발 언어 제거) — 오류를 보여 주는 화면이 함께 불러온다
const customerMessageModule = compileModule("src/components/parent/customerMessage.ts");
// 2026-11-15 마감 통일·날짜 바꾸기: 결석·셔틀·보강 화면이 함께 쓰는 마감 글(순수 모듈)
const changeDeadline = compileModule("src/lib/parent/changeDeadline.ts");

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
  // 2026-11-14 아이콘 완전 제거: ×·별을 아이콘 글꼴 이름(close·star)이 아니라 글자 기호로 그린다 — 모양·색 토큰은 그대로.
  assert.match(html, /text-\[var\(--color-academy-cal-absent\)\][^>]*>×</, "결석 = ×");
  assert.match(html, /text-\[var\(--color-academy-cal-event\)\][^>]*>★</, "행사 = 별");
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
    "@/lib/ui/statusTones": statusTones, "@/lib/seats/seatLevel": seatLevelModule,
    "@/lib/mypage/requestPreset": { presetIndex: () => 0, presetFirst: (list) => [...list] }, "@/components/parent/customerMessage": customerMessageModule, 
    "next/link": { default: Link },
    "@/lib/parent/changeDeadline": changeDeadline, // 2026-11-15 마감 통일·날짜 바꾸기: 마감 글(진짜 모듈)
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
    "@/lib/mypage/requestPreset": { presetIndex: () => 0, presetFirst: (list) => [...list] }, "@/components/parent/customerMessage": customerMessageModule, 
    "next/link": { default: Link },
    "@/components/admin/list/upcomingDateGroups": groups,
    "@/lib/datetime/kst": kst,
    "@/lib/parent/changeDeadline": changeDeadline, // 2026-11-15 마감 통일·날짜 바꾸기: 마감 글(진짜 모듈)
    "@/components/parent/InlineConfirm": inlineConfirm,
    "@/lib/enrollment/resumeWindow": compileModule("src/lib/enrollment/resumeWindow.ts"), // 2026-11-14 복귀 예정 안내 문구(진짜 규칙)
    // 2026-11-14 질병·부상 이월 검토: 상태 글자는 진짜 규칙, 사진 압축은 브라우저 전용이라 그대로 통과
    "@/lib/regular/illnessCarryRules": compileModule("src/lib/regular/illnessCarryRules.ts", { "@/lib/datetime/kst": kst }),
    "@/lib/clientImageCompression": { compressImageForUpload: async (file) => file },
    // 2026-11-15 여러 날 결석 칸 — 이 테스트는 «하루» 화면을 본다(여러 날 칸은 tests/parent-absence-period.test.mjs)
    "./PeriodAbsencePanel": { __esModule: true, default: () => null, ActivePeriodList: () => null },
    // 2026-11-14 묶음 B: 지각·조퇴 칸(이 테스트는 결석 줄만 본다 — 정보가 없으면 아무것도 그리지 않는다)
    "./ArrivalNoticeArea": { __esModule: true, default: () => null, arrivalAddableKinds: () => [] },
    "@/lib/regular/arrivalNoticeRules": compileModule("src/lib/regular/arrivalNoticeRules.ts", { "@/lib/parent/changeDeadline": changeDeadline }),
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
  // 2026-11-14 용어 통일(결정표 d2): 학부모 화면은 «신고» 대신 «알림»
  assert.match(html, />결석 알림<\/span><span class="text-xs[^"]*">개인 사정</);
  assert.doesNotMatch(html, /결석 신고됨|신고 취소|신고·취소/);
  assert.match(html, /수업 1시간 전까지 알리거나 취소할 수 있어요\./);
  assert.match(html, /확정됨<\/span><span class="text-xs[^"]*">질병\/부상</);
  assert.doesNotMatch(html, /확정됨 · |결석 알림 · |초등 고학년반 · 11\/5/);
  assert.match(html, />알림 취소</);
  // 2026-11-14 원장: «변경은 문의» 글 대신 한 단어 + 그 자리 전화 버튼(학원 전화가 설정돼 있을 때)
  assert.doesNotMatch(html, /변경은 문의/);
  assert.match(html, />학원 확정<\/span>/);
  assert.match(html, /<h1[^>]*>결석 알리기<\/h1>/);
  assert.match(html, /\(결석: 초등 저학년반 10\/1\(목\)\)/);

  // 2026-11-14 질병·부상 이월 검토 — 상태 한 단어·사진 장수·기한·사진 추가, 마감 줄은 «마감» + 그 자리 전화·문의 버튼
  const review = (extra) => ({ absenceId: "a1", studentId: "s1", studentName: "합성", classId: "c1", className: "초등 저학년반", date: today, dateLabel: "11/14(토)",
    status: "PENDING", statusLabel: "이월 검토 중", deadlineLabel: "11/21(토)", canEdit: true, canAdd: true, photos: [], ...extra });
  const html2 = renderToStaticMarkup(React.createElement(Absence, {
    initial: [{ studentId: "s1", studentName: "합성", classes: [{ classId: "c1", className: "초등 저학년반", dayOfWeek: "Mon", startTime: "16:00", dates: [
      date(0, { reported: true, reasonLabel: "질병/부상", reason: "ILLNESS_INJURY", status: "REPORTED", carryReview: "PENDING", changeOpen: false }),
      date(7, { reported: true, reasonLabel: "질병/부상", reason: "ILLNESS_INJURY", status: "CONFIRMED", locked: true, carryReview: "APPROVED" }),
      date(14),
    ] }] }],
    initialReviews: [
      review({ photos: [{ id: "mine-1", mine: true }, { id: "other-1", mine: false }] }),
      review({ absenceId: "a2", status: "APPROVED", statusLabel: "이월 승인", canEdit: false, canAdd: false }),
      review({ absenceId: "a3", status: "MAKEUP", statusLabel: "보강권으로 전환", canEdit: false, canAdd: false }),
    ],
    contact: { phone: "031-123-4567", kakaoChannelUrl: "https://pf.kakao.com/_stiz" },
  }));
  assert.match(html2, /<section aria-label="질병·부상 결석"/);
  for (const word of ["이월 검토 중", "이월 승인", "보강권으로 전환"]) assert.ok(html2.includes(`>${word}</span>`), word);
  assert.match(html2, /사진 2장 · 11\/21\(토\)까지 올릴 수 있어요/);
  assert.match(html2, /사진 0장<\/span>/, "끝난 검토는 기한 글이 없다");
  // 내가 올린 사진만 작은 사진으로(다른 보호자 사진은 장수만) · 검토 중일 때만 «사진 추가»
  assert.equal((html2.match(/<img /g) || []).length, 1);
  assert.match(html2, /src="\/api\/mypage\/regular-absence\/evidence\?id=mine-1"/);
  assert.doesNotMatch(html2, /other-1/);
  assert.equal((html2.match(/사진 추가/g) || []).length, 1);
  assert.match(html2, /accept="image\/jpeg,image\/png,image\/webp"/);
  assert.match(html2, /다음 달 수강료에서 1회분을 빼 드려요\./);
  assert.match(html2, /href="\/mypage\/makeup\?studentId=s1"[^>]*>보강 예약하기</);
  // 줄에도 상태 한 단어가 붙는다
  assert.match(html2, />질병\/부상<\/span><span class="text-xs[^"]*">이월 검토 중</);
  // 마감·학원 확정 줄: 한 단어 + 전화(숫자만)·카카오 문의 버튼 — «학원으로 연락» 글만 두지 않는다
  assert.match(html2, />마감<\/span><a href="tel:0311234567" class="academy-button-secondary[^"]*">전화<\/a><a href="https:\/\/pf\.kakao\.com\/_stiz"/);
  assert.match(html2, />학원 확정<\/span><a href="tel:0311234567"/);
  assert.doesNotMatch(html2, /학원으로 연락해 주세요|변경은 문의/);
  // 아직 알리지 않은 줄의 여는 버튼 이름 = «결석 알리기»
  assert.match(html2, />결석 알리기<\/button>/);
  // 아이콘·이모지 없이 글자만, 굵기는 4단계
  assert.doesNotMatch(html2, /material-symbols|font-extrabold|font-black/);

  const source = read("src/app/mypage/regular-absence/RegularAbsenceClient.tsx");
  assert.match(source, /groupByUpcomingDate\(child\.classes\.flatMap\(\(cl\) => cl\.dates\), \(d\) => d\.date, today, DATE_GROUP_LABELS\)/);
  assert.match(source, /const today = todayKst\(\);/);
  assert.doesNotMatch(source, /min-h-9/, "버튼·선택칸은 터치 44px");
  // 신고 = «결석 알리기»로 폼 열기 → 사유 선택 → «알리기» (기존 단계 보존, 2026-11-14 이름 통일)
  // (2026-11-14 묶음 B: 결석 칸을 열 때 열려 있던 지각·조퇴 칸을 함께 닫는다)
  assert.match(source, /onClick=\{\(\) => \{ setArrivalForm\(null\); setOpenKey\(key\); \}\}/);
  assert.match(source, /if \(!r\) \{\s*setErr\("결석 사유를 선택해 주세요\."\);/);
  assert.match(source, /onClick=\{\(\) => report\(d\)\}/);
  assert.match(source, /onConfirm=\{\(\) => cancel\(d\)\}/);
  // 2026-11-14 질병·부상: 사유 글이 비면 보내지 않고, 사유 글·사진 칸은 질병·부상을 골랐을 때만 보인다
  assert.match(source, /if \(illness && !text\) \{\s*setErr\("어디가 아픈지 한 줄로 적어 주세요\./);
  assert.match(source, /reasonText: illness \? text : null,/);
  // 이미 질병·부상인 줄에서 «사유 변경»을 열고 같은 사유면 사유 글·사진 칸을 숨기고 사진 올리는 곳을 알려 준다(막다른 길 제거)
  assert.match(source, /const sameIllness = illnessChosen && d\.reported && d\.reason === ILLNESS_REASON;/);
  assert.match(source, /\{sameIllness && \(\s*<p[^>]*>\s*사진은 위 «질병·부상 결석» 칸에서 추가할 수 있어요\./);
  assert.match(source, /\{illnessChosen && !sameIllness && \(\s*<div className="basis-full space-y-2">[\s\S]{0,400}어디가 아픈가요\?[\s\S]{0,500}placeholder="예: 독감, 발목 염좌"/);
  assert.match(source, /증빙 사진 고르기/);
  assert.match(source, /진단서·진료확인서·처방전·약 봉투 \(1~\$\{EVIDENCE_MAX_PHOTOS\}장\)/);
  // 완료 문구: 질병·부상이면 «사진을 확인한 뒤 다음 달 수강료에서 빼 드려요», 그 밖은 지금처럼
  assert.match(source, /const head = d\.reported \? "결석 사유를 바꿨어요\." : "결석을 알렸어요\.";/);
  assert.match(source, /\`\$\{head\} 사진을 확인한 뒤 다음 달 수강료에서 빼 드려요\.\`/);
  assert.match(source, /결석일부터 7일 안에 증빙 사진을 올려 주시면/);
  // 화면에 보이는 글에 «신고»가 남지 않는다(주석·코드 식별자는 제외하고 따옴표·JSX 글자만 본다)
  for (const text of ["결석 신고됨", "신고 취소", "결석 신고를", "신고에 실패", "신고·취소할 수"]) assert.ok(!source.includes(`"${text}`) && !source.includes(`>${text}`) && !new RegExp(`^\\s+${text}`, "m").test(source), text);
  // 홈의 길 안내 링크 글자도 «결석 알리기»
  // 홈 문의 폼의 길 안내는 한 줄로 줄였다(2026-11-14 문구 정리) — 결석·셔틀 버튼이 바로 위 «빠른 실행»에 있다
  assert.match(read("src/app/mypage/MyPageClient.tsx"), /결석·셔틀은 위 버튼으로 알려 주세요/);
  assert.match(read("src/app/mypage/MyPageClient.tsx"), /{ href: absenceHref, label: "결석 알리기" }/);
  assert.match(source, /\`\$\{head\} 보강권 1장이 생겼어요\.\`/);
  // 사진은 줄여서 보내고(서버가 다시 인코딩), 공개 업로드 주소는 쓰지 않는다
  assert.match(source, /compressImageForUpload\(file, \{ maxEdge: 2000,/);
  assert.match(source, /fetch\("\/api\/mypage\/regular-absence\/evidence", \{ method: "POST", body: form \}\)/);
  assert.doesNotMatch(source, /"\/api\/upload"/);
});

test("수업 리포트 목록은 KST 달별 묶음·한 줄 행(주제·날짜 오른쪽 / 반·시간·담당)이고 상세 링크는 그대로다", async () => {
  const Page = compileModule("src/app/mypage/reports/page.tsx", {
    "next/link": { default: Link },
    // 프로필 사진(2026-11-14 피드백 줄 연결) — 화면 검사와 무관해 빈 부품·주소 없음
    "@/components/common/ProfileAvatar": { default: () => null }, "@/lib/profilePhoto/rules": { profilePhotoUrl: () => null },
    // 2026-11-15 아이콘 예외(화살표·종·톱니): 공용 아이콘 부품은 실제 코드를 그대로 쓴다
    "@/components/common/UiIcon": compileModule("src/components/common/UiIcon.tsx"),
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
    // 2026-11-14 c4: 사진 타일은 앱 안 크게 보기 부품으로(이 테스트는 리포트 목록만 본다)
    "@/components/parent/FeedPhotoGallery": { default: () => null },
    // 오늘을 고정 — 3개월 지난 공지 숨김이 실행 날짜에 따라 달라지지 않게
    "@/lib/datetime/kst": { ...kst, todayKst: () => "2026-11-09" },
    "@/lib/mypage/parentSchedule": parentSchedule,
    "@/components/admin/list/monthDateGroups": monthGroups,
    // 2026-11-14 수업 피드: 행마다 «사진 n · 영상 n» — 개수는 공용 조회(상세가 실제로 보여 주는 것과 같은 집합)
    "@/lib/feed/server": { countSessionFeedMedia: async (sessions) => new Map(sessions.map((s) => [s.sessionId ?? s.id, s.id === "s1" ? { photoCount: 2, videoCount: 1 } : { photoCount: 0, videoCount: 0 }])) },
    "@/lib/feed/rules": feedRules,
  }).default;
  const html = renderToStaticMarkup(await Page());
  assert.match(html, /사진 2 · 영상 1/);
  assert.equal((html.match(/사진 \d+ · 영상|영상 \d+</g) ?? []).length, 1, "사진·영상이 없는 행에는 개수를 쓰지 않는다");
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
    "@/lib/mypage/requestPreset": { presetIndex: () => 0, presetFirst: (list) => [...list] }, "@/components/parent/customerMessage": customerMessageModule, 
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/lib/academyPhoneRules": compileModule("src/lib/academyPhoneRules.ts"), // 2026-11-15 «학원에 전화하기» 번호 판정(진짜 규칙)
    "next/link": { __esModule: true, default: Link }, // 2026-11-14: «결석 알리기» 링크
    "@/lib/shuttle/dayExceptionRules": compileModule("src/lib/shuttle/dayExceptionRules.ts"),
    "@/lib/parent-staff-status": { deliveryStatusText: () => "사이트 알림 등록 1건 · 푸시 전송 접수 1건", matchesShuttleChange: () => false },
    "@/components/admin/list/ListDetailPanel": { default: ({ children }) => React.createElement("div", { "data-sheet": "" }, children) },
    "@/components/admin/list/upcomingDateGroups": groups,
    "@/lib/datetime/kst": kst,
    "@/lib/parent/changeDeadline": changeDeadline, // 2026-11-15 마감 통일·날짜 바꾸기: 마감 글(진짜 모듈)
    "@/components/parent/InlineConfirm": inlineConfirm,
    "@/lib/enrollment/resumeWindow": compileModule("src/lib/enrollment/resumeWindow.ts"), // 2026-11-14 복귀 예정 안내 문구(진짜 규칙)
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
  // 2026-11-14 문구 정리: 줄마다 붙던 꼬리표(«변경 저장 완료»·«담당 기사님 배정은 학원에서 확인 중»)와 건수 나열은 없앴다
  assert.doesNotMatch(html, /담당 기사님 배정은 학원에서 확인 중|변경 저장 완료|알림함 등록|휴대폰 알림 \d+건/);
  // 이름 통일(d2)·짧은 라벨: 제목 «셔틀 변경», 칩 «등원», 버튼 «변경 신청», 결석은 «결석 알리기»로 보낸다
  // 2026-11-14 묶음 B: «안 타요» 칩은 방향에 맞춘 «직접 데려다줘요 / 직접 데리러 가요(자차)»로 바뀌었다(처음 고른 방향 = 등원)
  assert.match(html, /<h1[^>]*>셔틀 변경<\/h1>/);
  assert.match(html, />등원<\/button>/);
  assert.match(html, />직접 데려다줘요\(자차\)<\/button>/);
  assert.doesNotMatch(html, />안 타요</);
  assert.doesNotMatch(html, /셔틀 당일 변경|타러 갈 때|데려다줄 때|오늘 안 타요|결석 미리 알리기|알림 요청/);
  assert.match(html, /수업에 빠지면 <a[^>]*href="\/mypage\/regular-absence"[^>]*>결석 알리기<\/a>로 알려 주세요/);
  assert.match(html, />변경 신청<\/button>/);
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
  const Seasonal = compileModule("src/app/mypage/seasonal/SeasonalMakeupClient.tsx", { "@/lib/ui/statusTones": statusTones, "@/lib/seats/seatLevel": seatLevelModule, "@/lib/mypage/requestPreset": { presetIndex: () => 0, presetFirst: (list) => [...list] }, "@/components/parent/customerMessage": customerMessageModule, "@/components/parent/InlineConfirm": inlineConfirm,
    // 2026-11-14: 연락처가 없을 때의 막다른 안내를 «연락처 바꾸기» 버튼+«학원에 문의» 링크로 바꿔 부품 둘이 늘었다(이 테스트는 연락처가 있는 화면만 본다)
    "@/components/account/PhoneChangeButton": { __esModule: true, default: () => null }, "next/link": { __esModule: true, default: Link } }).default;
  const html = renderToStaticMarkup(React.createElement(Seasonal, { initial: {
    phoneKnown: true,
    absences: [{ enrollmentDateId: "e1", childName: "합성", offeringTitle: "겨울 방학특강 저학년", absentLabel: "1/5(월)", seasonalCandidates: [], regularCandidates: [] }],
    makeups: [{ id: "m1", childName: "합성", offeringTitle: "겨울 방학특강 저학년", absentLabel: "1/5(월)", targetLabel: "1/12(월)", targetType: "SEASONAL", status: "REQUESTED" }],
  } }));
  assert.match(html, /<ul class="divide-y/);
  assert.doesNotMatch(html, /· 겨울 방학특강/, "«자녀 · 특강» 이어 붙인 글은 요소로 나눴다");
  assert.match(html, /1\/5\(월\) 결석/);
  assert.match(html, />보강 신청</);
  // 2026-11-14 문구 정리: 상태는 «승인 대기» 한마디, 제목 아래 설명 문단·빈 칸 안내 상자는 없앴다
  assert.match(html, />승인 대기</);
  assert.doesNotMatch(html, /신청 접수 \(승인 대기\)|현재 보강이 필요한 결석이 없습니다|예정된 방학특강 회차가 없습니다|미리 결석 신고|최종 처리는 학원과 협의/);
  assert.match(html, /방학특강 결석 알리기 · 보강/);
  // 예정 회차 칸은 불러온 뒤 있을 때만 제목째 그린다 — 처음 그림(불러오는 중)에는 «없어요»가 아니라 «불러오는 중»이 보인다
  assert.doesNotMatch(html, /예정 회차 · 결석 알리기|예정된 회차나 보강할 결석이 없어요/);
  assert.match(html, /예정 회차를 불러오는 중이에요/);
  // 보강 기한(결석일부터 2개월)은 제목 옆 한마디로 남긴다
  assert.match(html, /보강이 필요한 결석<span[^>]*>결석일부터 2개월 안에<\/span>/);

  const source = read("src/app/mypage/seasonal/SeasonalMakeupClient.tsx");
  assert.doesNotMatch(source, /결석 신고됨 · /);
  assert.doesNotMatch(source, /min-h-(?:8|9)\b|text-\[11px\]/, "터치 44px·글자 12px 이상");
  // 신청·신고·취소 흐름 보존
  assert.match(source, /onClick=\{\(\) => request\(ab\.enrollmentDateId, "SEASONAL", s\)\}/);
  assert.match(source, /onClick=\{\(\) => request\(ab\.enrollmentDateId, "REGULAR", c\)\}/);
  assert.match(source, /onClick=\{\(\) => reportAbsence\(s\.enrollmentDateId\)\} disabled=\{busy \|\| !seatReason\[s\.enrollmentDateId\]\}/);
  assert.match(source, /onConfirm=\{\(\) => cancelAbsence\(s\.enrollmentDateId\)\}/);
  // 2026-11-14 원장 결정(문구 정리 62번): 칸 제목 아래 설명 문장(«…미리 신고할 수 있어요. 신고하면 그날 셔틀 배차에서도 자동 제외됩니다.»)은 없앴다
  assert.doesNotMatch(source, /셔틀 배차에서도 자동 제외됩니다|미리 신고할 수 있어요/);
  // 이름 통일(d2): 방학특강 화면도 «결석 알리기» — 화면에 보이는 글에 «결석 신고»가 남지 않는다(주석 제외)
  for (const text of ["결석 신고", "신고 취소", "결석 미리 신고"]) assert.ok(!source.includes(`"${text}`) && !source.includes(`>${text}`), text);
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
