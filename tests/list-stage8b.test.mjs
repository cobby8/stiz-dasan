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
const monthGroups = compileModule("src/components/admin/list/monthDateGroups.ts", { "@/lib/datetime/kst": kst });

test("출결 히스토리는 KST 날짜로 달별 묶음·오른쪽 날짜·상태 칩을 보이고 수납 탭은 손대지 않는다", () => {
  const History = compileModule("src/app/mypage/history/HistoryClient.tsx", {
    "next/link": { default: Link },
    "@/components/admin/list/StatusCountChips": chips,
    "@/lib/datetime/kst": kst,
    "@/components/admin/list/monthDateGroups": monthGroups,
  }).default;
  const html = renderToStaticMarkup(React.createElement(History, { children: [{
    id: "c1", name: "합성 학생",
    attendance: { total: 3, present: 2, absent: 1, late: 0, rate: 67, records: [
      // KST 10/1 00:00 = UTC 9/30 15:00 — toISOString 이면 9/30 으로 하루 밀린다
      { status: "PRESENT", date: "2026-09-30T15:00:00.000Z", className: "초등 저학년반" },
      { status: "ABSENT", date: "2026-09-29T15:00:00.000Z", className: "초등 저학년반" },
      { status: "PRESENT", date: "2026-08-31T15:00:00.000Z", className: null },
    ] },
    payments: [],
  }] }));
  assert.match(html, /2026년 10월/);
  assert.match(html, /2026년 9월/);
  assert.match(html, /10\/1\(목\)/);
  assert.match(html, /9\/30\(수\)/);
  assert.match(html, /9\/1\(화\)/);
  assert.doesNotMatch(html, /2026-09-30/, "옛 UTC 날짜 문자열이 남으면 안 된다");
  assert.match(html, /출석률 <span class="tabular-nums">67%/);
  assert.match(html, /aria-label="출결 상태별 건수"/);
  assert.match(html, /aria-pressed="false"[^>]*>출석<span class="tabular-nums[^"]*">2<\/span>/);

  const source = read("src/app/mypage/history/HistoryClient.tsx");
  assert.match(source, /min-h-11 items-center gap-2 px-3 py-2/);
  assert.match(source, /shrink-0 text-right text-sm tabular-nums/);
  // 수납(결제 심사 중) 부분은 그대로 — 납부·청구서·영수증 링크와 판정식 보존
  assert.match(source, /const canPay = p\.canCheckout !== false && Boolean\(p\.invoiceId\) && \(p\.status === "PENDING" \|\| p\.status === "OVERDUE"\);/);
  assert.match(source, /href=\{`\/payments\/\$\{p\.invoiceId\}`\}/);
  assert.match(source, /<p className="text-xs text-gray-400">기한: \{toDateStr\(p\.dueDate\)\}<\/p>/);
});

test("보강 예약은 4칸 집계판 대신 상태 칩(서버 집계와 같은 판정)과 한 목록의 행으로 보이고 예약·취소 흐름은 그대로다", () => {
  const Makeup = compileModule("src/app/mypage/makeup/MakeupClient.tsx", {
    "next/link": { default: Link },
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/app/actions/parent-makeup": { fetchMakeupOptions: async () => ({ ok: true, options: [] }), bookMakeupAction: async () => ({ ok: true }), cancelMakeupAction: async () => ({ ok: true }) },
    "@/components/admin/list/StatusCountChips": chips,
    "@/lib/datetime/kst": kst,
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
  // 예약 = 반 열기 → 날짜 고르기 → «이 날짜로 예약», 취소 = 버튼 한 번 (기존 흐름 보존)
  assert.match(source, /bookMakeupAction\(\{ creditId, classId: pick\.classId, dateYmd: pick\.ymd \}\)/);
  assert.match(source, /onClick=\{\(\) => book\(c\.id\)\}[\s\S]*?이 날짜로 예약/);
  assert.match(source, /onClick=\{\(\) => cancel\(c\.id\)\}/);
});

test("정규 결석 신고는 반 카드 속 작은 카드 대신 날짜 묶음(오늘/이번 주/다음 주/이후)의 한 줄 행이고 신고 흐름은 그대로다", () => {
  const groups = compileModule("src/components/admin/list/upcomingDateGroups.ts", { "@/lib/datetime/kst": kst });
  const Absence = compileModule("src/app/mypage/regular-absence/RegularAbsenceClient.tsx", {
    "next/link": { default: Link },
    "@/components/admin/list/upcomingDateGroups": groups,
    "@/lib/datetime/kst": kst,
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
  assert.match(source, /onClick=\{\(\) => cancel\(d\)\}/);
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
    ] },
    "@/lib/datetime/kst": kst,
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
});

test("셔틀 예정 변경은 날짜 묶음의 한 줄 행이고 행 탭=하단 시트, 행 안 «취소»는 번지지 않고 바로 취소한다", () => {
  const groups = compileModule("src/components/admin/list/upcomingDateGroups.ts", { "@/lib/datetime/kst": kst });
  const Shuttle = compileModule("src/app/mypage/shuttle/ShuttleExceptionClient.tsx", {
    "next/navigation": { useRouter: () => ({ refresh() {} }) },
    "@/lib/shuttle/dayExceptionRules": compileModule("src/lib/shuttle/dayExceptionRules.ts"),
    "@/lib/parent-staff-status": { deliveryStatusText: () => "사이트 알림 등록 1건 · 푸시 전송 접수 1건", matchesShuttleChange: () => false },
    "@/components/admin/list/ListDetailPanel": { default: ({ children }) => React.createElement("div", { "data-sheet": "" }, children) },
    "@/components/admin/list/upcomingDateGroups": groups,
    "@/lib/datetime/kst": kst,
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
  assert.match(html, /담당 기사 연결·알림 확인 필요/);
  assert.doesNotMatch(html, /사이트 알림 등록/, "긴 알림 결과는 행이 아니라 시트에서");
  assert.doesNotMatch(html, /data-sheet/, "처음엔 시트가 닫혀 있다");

  const source = read("src/app/mypage/shuttle/ShuttleExceptionClient.tsx");
  assert.match(source, /function handleRowKeyDown\(event: KeyboardEvent<HTMLElement>, id: string\) \{\s*if \(event\.target !== event\.currentTarget\) return;/);
  assert.match(source, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); cancel\(item\.id\); \}\}/);
  assert.match(source, /<ListDetailPanel onClose=\{\(\) => setDetailId\(null\)\}[\s\S]*?deliveryStatusText\(item\.notificationStatus\)/);
  // 저장·취소 흐름 보존(결과 확인 필요 시 재조회, 중복 제출 막기)
  assert.match(source, /if \(response\.status >= 500\) return reconcile\(body\);/);
  assert.match(source, /if \(!\(await send\(\{ action: "cancel", id \}\)\)\) return;/);
  assert.match(source, /disabled=\{pending \|\| Boolean\(uncertain\)\}/);
});

test("방학특강 결석·보강은 세 목록이 한 목록의 행이고 배지·사유·날짜를 요소로 나누며 신청·신고 흐름은 그대로다", () => {
  const Seasonal = compileModule("src/app/mypage/seasonal/SeasonalMakeupClient.tsx").default;
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
  assert.match(source, /onClick=\{\(\) => cancelAbsence\(s\.enrollmentDateId\)\}/);
  assert.match(source, /신고하면 그날 셔틀 배차에서도 자동 제외됩니다\./);
});
