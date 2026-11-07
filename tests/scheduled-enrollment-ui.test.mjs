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
const enrollment = { id: "enrollment-a", classId: "class-a", status: "ACTIVE", displayStatus: "SCHEDULED", startsOn: "2099-12-01", className: "월요일 5교시", dayOfWeek: "Mon", startTime: "17:00", endTime: "17:55", programName: "합성반", createdAt: "2026-11-03" };

test("첫 다음 수업은 개시일 이전 주차를 건너뛴다", () => {
  const now = { dayIndex: 2, minutes: 12 * 60 }; // 2026-11-03 화요일
  const next = computeNextClass([{ ...enrollment, startsOn: "2026-12-01" }], now, "2026-11-03");
  assert.equal(next.serviceDate, "2026-12-07");
  assert.equal(nextClassWhenLabel(next, now), "12월 7일");
  const onStart = computeNextClass([{ ...enrollment, startsOn: "2026-11-09" }], { dayIndex: 1, minutes: 12 * 60 }, "2026-11-09");
  assert.equal(onStart.serviceDate, "2026-11-09");
  assert.equal(nextClassWhenLabel(onStart, { dayIndex: 1, minutes: 12 * 60 }), "오늘");
});

test("관리자 원생 상세는 예정 반을 수강중·이전반과 구분하고 배정 반과 날짜를 보존한다", () => {
  const Client = load("src/app/admin/students/[id]/StudentDetailClient.tsx", {
    "@/components/admin/adminDisplayText": {}, "next/link": link, "@/app/actions/admin": {},
    "@/lib/datetime/kst": { todayKst: () => "2026-11-03" },
    "@/components/maps/LocationPickerModal": nullComponent, "@/components/admin/AdminModal": nullComponent,
    "@/components/admin/StatusBadge": { statusToneClass: () => "" },
    "./ParentRequestLinkPanel": nullComponent, "./GuardianPanel": nullComponent,
    "@/components/admin/CustomerNoticeSender": nullComponent,
  }).default;
  const html = renderToStaticMarkup(React.createElement(Client, { data: {
    student: { id: "student-a", name: "합성 학생", birthDate: "2016-01-01", gender: "남", createdAt: "2026-11-03", parentId: "parent-a", parent: {}, memo: null },
    enrollments: [enrollment], attendances: [], payments: [], attendanceStats: { total: 0, present: 0, absent: 0, late: 0, excused: 0, rate: 0 }, galleryPosts: [], monthlyHistory: [],
  } }));
  assert.match(html, /수강 예정/);
  assert.match(html, /2099-12-01/);
  assert.match(html, /월요일 5교시/);
  assert.doesNotMatch(html, /수강 중인 반이 없습니다/);
  assert.doesNotMatch(html, /value="SCHEDULED"/);
});

test("관리자 수강예정 필터와 반별 명단은 예정 학생을 반 없음이나 현재 인원으로 오인하지 않는다", () => {
  const Client = load("src/app/admin/students/StudentManagementClient.tsx", {
    react: { ...React, useState: (value) => React.useState(value === "ACTIVE" ? "SCHEDULED" : value) },
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
  assert.match(html, /수강 중 0명 · 예정 1명/);
  assert.match(html, /title="월요일 5교시"/);
  assert.doesNotMatch(html, /활성 수강반이 없는 학생/);
});

test("학부모 실제 홈은 예정 반을 수강중으로 세지 않고 개시일을 보여준다", () => {
  const summary = load("src/lib/mypage/summary.ts", {});
  const Client = load("src/app/mypage/MyPageClient.tsx", {
    "@/components/account/ChildConnectionNotice": nullComponent, "next/link": link,
    "@/components/pwa/HideInInstalledApp": { __esModule: true, default: ({ children }) => children },
    "@/components/pwa/AppSafeLink": link, "@/app/actions/admin": {},
    "@/lib/mypage/summary": summary, "@/lib/datetime/kst": { formatKstDate: (value) => String(value) },
  }).default;
  const html = renderToStaticMarkup(React.createElement(Client, { data: {
    parent: { id: "parent-a", name: "합성 부모" },
    children: [{ id: "student-a", name: "합성 학생", birthDate: "2016-01-01", enrollments: [enrollment], attendance: { total: 0, present: 0, absent: 0, late: 0, records: [] }, payments: [] }],
  } }));
  assert.match(html, /수강 시작을 기다리고 있어요/);
  assert.match(html, /수강 예정/);
  assert.match(html, /2099-12-01/);
  assert.doesNotMatch(html, /수강 중인 반 1개/);
});
