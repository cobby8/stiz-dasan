import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module, { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import ts from "typescript";
import { computeNextClass, nextClassWhenLabel } from "../src/lib/mypage/summary.ts";

const require = createRequire(import.meta.url);
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(path, mocks) {
  const absolute = resolve(path);
  const compiled = ts.transpileModule(readFileSync(absolute, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }, fileName: absolute }).outputText;
  const module = new Module(absolute);
  module.filename = absolute;
  module.paths = Module._nodeModulePaths(resolve("."));
  module.require = (name) => name in mocks ? mocks[name] : require(name);
  module._compile(compiled, absolute);
  return module.exports;
}
const nullComponent = { __esModule: true, default: () => null };
const link = { __esModule: true, default: ({ children, href }) => React.createElement("a", { href }, children) };
// 2026-11-09 원장 기준: 승인돼 ACTIVE 면 개시일(미래)과 무관하게 수강 중. 서버는 displayStatus=ACTIVE·startsLater=true 를 준다
const kstModule = load("src/lib/datetime/kst.ts", {});
const statusTones = load("src/lib/ui/statusTones.ts", {}); // 상태색 공용 지도(2026-11-09 색상 정리)
const commencement = load("src/lib/enrollment/commencement.ts", { "@/lib/datetime/kst": kstModule });
const enrollment = { id: "enrollment-a", classId: "class-a", status: "ACTIVE", displayStatus: "ACTIVE", startsLater: true, startsOn: "2099-12-01", className: "월요일 5교시", dayOfWeek: "Mon", startTime: "17:00", endTime: "17:55", programName: "합성반", createdAt: "2026-11-03" };

test("첫 다음 수업은 개시일 이전 주차를 건너뛴다", () => {
  const now = { dayIndex: 2, minutes: 12 * 60 }; // 2026-11-03 화요일
  const next = computeNextClass([{ ...enrollment, startsOn: "2026-12-01" }], now, "2026-11-03");
  assert.equal(next.serviceDate, "2026-12-07");
  assert.equal(nextClassWhenLabel(next, now), "12월 7일");
  const onStart = computeNextClass([{ ...enrollment, startsOn: "2026-11-09" }], { dayIndex: 1, minutes: 12 * 60 }, "2026-11-09");
  assert.equal(onStart.serviceDate, "2026-11-09");
  assert.equal(nextClassWhenLabel(onStart, { dayIndex: 1, minutes: 12 * 60 }), "오늘");
});

test("관리자 원생 상세는 개시일이 미래인 ACTIVE 반을 «수강 중»으로 세고 개시일을 안내한다", () => {
  const Client = load("src/app/admin/students/[id]/StudentDetailClient.tsx", {
    "@/lib/ui/statusTones": statusTones,
    "@/components/admin/adminDisplayText": {}, "next/link": link, "@/app/actions/admin": {},
    "@/lib/datetime/kst": { todayKst: () => "2026-11-03" },
    "@/lib/enrollment/commencement": commencement,
    // 반 줄 ⋯ 메뉴(반 이동·삭제) — 메뉴 항목 글자만 그려 확인한다
    "@/components/admin/AdminQuickActionMenu": { __esModule: true, default: ({ actions }) => React.createElement("div", {}, actions.map((a) => a.label).join("|")) },
    "@/components/admin/AdminConfirmDialog": { useAdminConfirm: () => ({ confirm: async () => false, confirmDialog: null }) },
    "@/app/actions/enrollment-admin-edit": {}, "./EnrollmentMoveModal": nullComponent,
    "@/components/maps/LocationPickerModal": nullComponent, "@/components/admin/AdminModal": nullComponent,
    "@/components/admin/StatusBadge": { statusToneClass: () => "" },
    "./ParentRequestLinkPanel": nullComponent, "./GuardianPanel": nullComponent, "./AbsencePeriodPanel": nullComponent,
    "@/components/admin/CustomerNoticeSender": nullComponent,
  }).default;
  const html = renderToStaticMarkup(React.createElement(Client, { data: {
    student: { id: "student-a", name: "합성 학생", birthDate: "2016-01-01", gender: "남", createdAt: "2026-11-03", parentId: "parent-a", parent: {}, memo: null },
    enrollments: [enrollment], attendances: [], payments: [], attendanceStats: { total: 0, present: 0, absent: 0, late: 0, excused: 0, rate: 0 }, galleryPosts: [], monthlyHistory: [],
  } }));
  assert.doesNotMatch(html, /수강 예정/);
  assert.match(html, /1<span class="text-base"> 개 반<\/span>/, "수강 중 1개 반");
  assert.match(html, /2099-12-01 개시 예정/);
  assert.match(html, /월요일 5교시/);
  assert.doesNotMatch(html, /수강 중인 반이 없습니다/);
  assert.doesNotMatch(html, /value="SCHEDULED"/);
  // 반 단위 토글은 «수강 종료»(퇴원 아님) + ⋯ 메뉴에 반 이동·삭제
  assert.match(html, /수강 종료/);
  assert.match(html, /반 이동\|삭제\(잘못 등록\)/);
});

test("관리자 원생 목록 «활성» 필터·반별 인원은 개시일 미래인 ACTIVE 학생을 수강 중으로 센다", () => {
  const Client = load("src/app/admin/students/StudentManagementClient.tsx", {
    "@/lib/enrollment/commencement": commencement,
    "@/components/admin/adminDisplayText": {}, "next/link": link,
    "next/dynamic": { __esModule: true, default: () => () => null },
    "@/app/actions/admin": {}, "@/components/admin/AdminModal": nullComponent,
    "@/components/admin/AdminQuickActionMenu": nullComponent,
    "@/components/admin/AdminConfirmDialog": { useAdminConfirm: () => ({ confirm: async () => false, confirmDialog: null }) },
    "@/components/academy/CompactListFilters": { __esModule: true, default: ({ children }) => React.createElement("div", {}, children) },
    "@/components/admin/list/ListDetailPanel": nullComponent,
    "@/components/admin/list/StatusCountChips": nullComponent,
    "@/components/admin/list/ListViewToggle": { __esModule: true, default: () => null, useRememberedListView: () => ["class", () => {}] },
  }).default;
  const html = renderToStaticMarkup(React.createElement(Client, { students: [{
    id: "student-a", name: "합성 예정 학생", birthDate: "2016-01-01", createdAt: "2026-11-03", parentId: "parent-a", parent: {}, enrollments: [enrollment],
  }], classes: [], partial: false }));
  assert.match(html, /합성 예정 학생/);
  assert.doesNotMatch(html, /예정 1명|수강 예정/);
  assert.match(html, />1명</);
  assert.match(html, /개시 전/);
  assert.match(html, /title="월요일 5교시"/);
  assert.doesNotMatch(html, /활성 수강반이 없는 학생/);
});

test("학부모 홈은 개시일 미래인 ACTIVE 반을 수강 중으로 세고 수업 시작일을 안내한다", () => {
  const summary = load("src/lib/mypage/summary.ts", {});
  const Client = load("src/app/mypage/MyPageClient.tsx", {
    "@/lib/ui/statusTones": statusTones,
    "@/components/account/ChildConnectionNotice": nullComponent, "next/link": link,
    "@/components/pwa/HideInInstalledApp": { __esModule: true, default: ({ children }) => children },
    "@/components/pwa/AppSafeLink": link, "@/app/actions/admin": {},
    "@/lib/mypage/summary": summary, "@/lib/datetime/kst": { formatKstDate: (value) => String(value) },
    "@/components/parent/VirtualAccountNotice": nullComponent,
  }).default;
  const html = renderToStaticMarkup(React.createElement(Client, { data: {
    parent: { id: "parent-a", name: "합성 부모" },
    children: [{ id: "student-a", name: "합성 학생", birthDate: "2016-01-01", enrollments: [enrollment], attendance: { total: 0, present: 0, absent: 0, late: 0, records: [] }, payments: [] }],
  } }));
  assert.match(html, /수강 중인 반 1개/);
  assert.doesNotMatch(html, /수강 예정|수강 시작을 기다리고 있어요/);
  // 수강 반 목록은 «일정» 탭(ScheduleHub)으로 옮겨졌다 — 개시일 안내도 그 목록 행에서 확인한다
  const parentSchedule = load("src/lib/mypage/parentSchedule.ts", { "@/lib/datetime/kst": kstModule, "@/lib/classSchedule": load("src/lib/classSchedule.ts", {}) });
  const Hub = load("src/app/mypage/history/ScheduleHub.tsx", { "next/link": link, "../ParentShuttleDetail": nullComponent, "@/lib/datetime/kst": kstModule, "@/lib/mypage/parentSchedule": parentSchedule }).default;
  const view = parentSchedule.buildParentMonth({ month: "2026-11", todayYmd: "2026-11-09", events: [], classDates: [], attendance: [] });
  const hubHtml = renderToStaticMarkup(React.createElement(Hub, { childList: [{ id: "student-a", name: "합성 학생", enrollments: [enrollment] }], selectedChildId: "student-a", view, shuttleItems: [] }));
  assert.match(hubHtml, /월요일 5교시/);
  assert.match(hubHtml, /12월 1일부터 수업 시작/, "개시일은 같은 화면 날짜 표기(12월 1일)로");
  assert.doesNotMatch(hubHtml, /수강 예정/);
});
